import { PDFDocument, rgb, PDFPage } from 'pdf-lib';
import opentype from 'opentype.js';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

export interface SizeConfig {
  id: string;
  index: string;
  suffix: string;
  fontSize: string;
  bgColor: string;   // CMYK format: "C.M.Y.K" (each 0-100), empty = no background
  textColor: string; // CMYK format: "C.M.Y.K" (each 0-100)
}

export interface TramRow {
  id: string;
  tram: string;
  model: string;
  depot: string;
  quantities: Record<string, string>;
}

export interface WidthCategory {
  label: string;         // 'S' | 'M' | 'L'
  widthMm: number;
  heightMm: number;
  sizeStr: string;
  tramNumbers: string[];
}

// Convert CMYK (0-100 per channel) to pdf-lib rgb (0-1 per channel)
function cmykToRgb(cmykStr: string) {
  const parts = cmykStr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return null;
  const [c, m, y, k] = parts.map(v => v / 100);
  return rgb(
    (1 - c) * (1 - k),
    (1 - m) * (1 - k),
    (1 - y) * (1 - k),
  );
}

const mmToPt = (mm: number) => (mm * 72) / 25.4;
const ptToMm = (pt: number) => (pt * 25.4) / 72;

// Load and cache the opentype font
let cachedFont: opentype.Font | null = null;
async function loadOpentypeFont(): Promise<opentype.Font> {
  if (cachedFont) return cachedFont;
  const fontUrl = `${import.meta.env.BASE_URL}MoscowSansW-Medium.otf`;
  const response = await fetch(fontUrl);
  if (!response.ok) {
    throw new Error(`Failed to load font (${response.status}) at ${fontUrl}`);
  }
  const buffer = await response.arrayBuffer();
  cachedFont = opentype.parse(buffer);
  return cachedFont;
}

// Convert opentype path to SVG path data string
function pathToSvgData(path: opentype.Path): string {
  let d = '';
  for (const cmd of path.commands) {
    switch (cmd.type) {
      case 'M': d += `M${cmd.x} ${cmd.y}`; break;
      case 'L': d += `L${cmd.x} ${cmd.y}`; break;
      case 'Q': d += `Q${cmd.x1} ${cmd.y1} ${cmd.x} ${cmd.y}`; break;
      case 'C': d += `C${cmd.x1} ${cmd.y1} ${cmd.x2} ${cmd.y2} ${cmd.x} ${cmd.y}`; break;
      case 'Z': d += 'Z'; break;
    }
  }
  return d;
}

// Glyph index for the no-serif alternate "1" (one.alt)
const ONE_ALT_GLYPH_INDEX = 428;

// Build a combined opentype Path for text, substituting '1' with the alt glyph.
function getTextPath(
  font: opentype.Font,
  text: string,
  x: number,
  y: number,
  fontSize: number,
): { path: opentype.Path; advanceWidth: number } {
  const scale = fontSize / font.unitsPerEm;
  const combinedPath = new opentype.Path();
  let cursorX = x;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    let glyph: opentype.Glyph;

    if (char === '1') {
      glyph = font.glyphs.get(ONE_ALT_GLYPH_INDEX);
    } else {
      glyph = font.charToGlyph(char);
    }

    const glyphPath = glyph.getPath(cursorX, y, fontSize);
    for (const cmd of glyphPath.commands) {
      combinedPath.commands.push(cmd);
    }

    cursorX += (glyph.advanceWidth ?? 0) * scale;
  }

  return { path: combinedPath, advanceWidth: cursorX - x };
}

// Draw text as vector outlines — stroke only, no fill
function drawTextStroke(
  page: PDFPage,
  font: opentype.Font,
  text: string,
  x: number,
  baselineY: number,
  fontSize: number,
  strokeColor: ReturnType<typeof rgb>,
  strokeWidth: number = 1
) {
  const { path } = getTextPath(font, text, 0, 0, fontSize);
  const svgData = pathToSvgData(path);
  if (!svgData) return;

  page.drawSvgPath(svgData, {
    x,
    y: baselineY,
    borderColor: strokeColor,
    borderWidth: strokeWidth,
    borderOpacity: 1,
    opacity: 0,
  });
}

// Draw text as vector outlines — filled, no stroke
function drawTextFilled(
  page: PDFPage,
  font: opentype.Font,
  text: string,
  x: number,
  baselineY: number,
  fontSize: number,
  fillColor: ReturnType<typeof rgb>,
) {
  const { path } = getTextPath(font, text, 0, 0, fontSize);
  const svgData = pathToSvgData(path);
  if (!svgData) return;

  page.drawSvgPath(svgData, {
    x,
    y: baselineY,
    color: fillColor,
    opacity: 1,
    borderWidth: 0,
  });
}

// Measure text advance width using font metrics with glyph substitution
function measureTextAdvance(font: opentype.Font, text: string, fontSize: number): number {
  const scale = fontSize / font.unitsPerEm;
  let totalAdvance = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const glyph = char === '1'
      ? font.glyphs.get(ONE_ALT_GLYPH_INDEX)
      : font.charToGlyph(char);
    totalAdvance += glyph.advanceWidth ?? 0;
  }
  return totalAdvance * scale;
}

// -------------------------------------------------------------------
// Width categorization: measure all tram numbers and cluster into 3 sizes
// -------------------------------------------------------------------
export async function calculateWidthCategories(
  fontSizeStr: string,
  tramNumbers: string[]
): Promise<WidthCategory[]> {
  const fontSize = parseFloat(fontSizeStr);
  if (isNaN(fontSize) || fontSize <= 0 || tramNumbers.length === 0) return [];

  try {
    const font = await loadOpentypeFont();
    // Calculate height from actual glyph bounding box + padding
    // Measure a representative digit string to get the real cap height
    const refPath = font.getPath('08', 0, 0, fontSize);
    const refBB = refPath.getBoundingBox();
    const glyphHeightPt = refBB.y2 - refBB.y1;
    const heightMm = Math.round(ptToMm(glyphHeightPt) + 15); // 15mm vertical padding
    const paddingMm = 20;

    // Measure each tram number's width
    const measured = tramNumbers.map(num => ({
      num,
      widthMm: Math.ceil(ptToMm(measureTextAdvance(font, num, fontSize)) + paddingMm),
    }));

    // Sort by width
    measured.sort((a, b) => a.widthMm - b.widthMm);

    const minW = measured[0].widthMm;
    const maxW = measured[measured.length - 1].widthMm;

    if (minW === maxW) {
      return [{
        label: 'S',
        widthMm: maxW,
        heightMm,
        sizeStr: `${maxW}x${heightMm}`,
        tramNumbers: measured.map(m => m.num),
      }];
    }

    // Cluster into up to 3 groups using tercile split
    const range = maxW - minW;
    const t1 = minW + range / 3;
    const t2 = minW + (2 * range) / 3;

    const small = measured.filter(m => m.widthMm <= t1);
    const medium = measured.filter(m => m.widthMm > t1 && m.widthMm <= t2);
    const large = measured.filter(m => m.widthMm > t2);

    const categories: WidthCategory[] = [];

    if (small.length > 0) {
      const w = Math.max(...small.map(m => m.widthMm));
      categories.push({
        label: 'S', widthMm: w, heightMm, sizeStr: `${w}x${heightMm}`,
        tramNumbers: small.map(m => m.num),
      });
    }
    if (medium.length > 0) {
      const w = Math.max(...medium.map(m => m.widthMm));
      categories.push({
        label: 'M', widthMm: w, heightMm, sizeStr: `${w}x${heightMm}`,
        tramNumbers: medium.map(m => m.num),
      });
    }
    if (large.length > 0) {
      const w = Math.max(...large.map(m => m.widthMm));
      categories.push({
        label: 'L', widthMm: w, heightMm, sizeStr: `${w}x${heightMm}`,
        tramNumbers: large.map(m => m.num),
      });
    }

    return categories;
  } catch (error) {
    console.error('Failed to calculate width categories', error);
    return [];
  }
}

// Resolve a tram number to its width category (sizeMm) for a given sizeConfig
function resolveTramSize(
  tramNumber: string,
  categories: WidthCategory[]
): WidthCategory | null {
  if (!categories || categories.length === 0) return null;
  for (const cat of categories) {
    if (cat.tramNumbers.includes(tramNumber)) return cat;
  }
  // Fallback: use largest category
  return categories[categories.length - 1];
}

export async function generateStickers(
  trams: TramRow[],
  sizes: SizeConfig[],
  allCategories: Record<string, WidthCategory[]>,
  folderOrder: string[] = []
) {
  const zip = new JSZip();
  const font = await loadOpentypeFont();

  let generatedCount = 0;

  for (const tram of trams) {
    if (!tram.tram) continue;

    for (const size of sizes) {
      const qStr = tram.quantities[size.id];
      const copies = parseInt(qStr, 10);
      if (isNaN(copies) || copies <= 0) continue;

      // Resolve the appropriate width category for this tram
      const categories = allCategories[size.id];
      const cat = resolveTramSize(tram.tram, categories);
      if (!cat) continue;

      const width = mmToPt(cat.widthMm);
      const height = mmToPt(cat.heightMm);
      const mainFontSize = parseFloat(size.fontSize) || (height * 1.05);

      // Parse CMYK colors
      const bgColor = size.bgColor ? cmykToRgb(size.bgColor) : null;
      const textColor = cmykToRgb(size.textColor) || rgb(0, 0, 0);

      const doc = await PDFDocument.create();
      const page = doc.addPage([width, height]);

      // Background fill
      if (bgColor) {
        page.drawRectangle({
          x: 0, y: 0, width, height, color: bgColor,
        });
      }

      // --- Main tram number: 1pt stroke outlines, centered ---
      const { path: mainPath } = getTextPath(font, tram.tram, 0, 0, mainFontSize);
      const mainBB = mainPath.getBoundingBox();
      const glyphVisualHeight = Math.abs(mainBB.y1) + Math.abs(mainBB.y2);
      const glyphVisualWidth = mainBB.x2 - mainBB.x1;

      const textX = (width - glyphVisualWidth) / 2 - mainBB.x1;
      const baselineY = (height - glyphVisualHeight) / 2 + Math.abs(mainBB.y2);

      drawTextStroke(page, font, tram.tram, textX, baselineY, mainFontSize, textColor, 1);

      // --- Small info text: FILLED, always index on left with depot+model ---
      const smallFontSize = 12;
      const infoBaselineY = height - 14;

      // Always: index first, then depot + model
      const indexText = size.index;
      const depotModelText = `${tram.depot}, ${tram.model}`;
      const indexAdvance = measureTextAdvance(font, indexText, smallFontSize);
      drawTextFilled(page, font, indexText, 14, infoBaselineY, smallFontSize, textColor);
      drawTextFilled(page, font, depotModelText, 14 + indexAdvance + 8, infoBaselineY, smallFontSize, textColor);

      const pdfBytes = await doc.save();

      const filename = `${tram.tram}_${tram.model}_${tram.depot}_${size.index}_${size.suffix}_${cat.sizeStr}_${copies}ekz.pdf`
        .replace(/\s+/g, '_')
        .replace(/__/g, '_');

      // Build folder path based on folderOrder
      const pathParts: string[] = [];
      for (const key of folderOrder) {
        switch (key) {
          case 'depot': pathParts.push(tram.depot || 'без_депо'); break;
          case 'model': pathParts.push(tram.model || 'без_модели'); break;
          case 'size': pathParts.push(`${size.index}_${size.suffix}`); break;
        }
      }
      const folderPath = pathParts.length ? pathParts.join('/') + '/' : '';

      zip.file(folderPath + filename, pdfBytes);
      generatedCount++;
    }
  }

  if (generatedCount === 0) {
    throw new Error('Не создано ни одного стикера. Убедитесь, что количество > 0 для хотя бы одной позиции.');
  }

  const d = new Date();
  const ts = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  saveAs(zipBlob, `бортовые_${ts}.zip`);
}

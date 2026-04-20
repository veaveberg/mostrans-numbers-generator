import { PDFDocument, rgb, PDFPage } from 'pdf-lib';
import opentype from 'opentype.js';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

export interface SizeConfig {
  id: string;
  index: string;
  suffix: string;
  fontSize: string;
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

export type GroupByMode = 'all' | 'depot' | 'model_depot';
export type LayoutDirection = 'horizontal' | 'vertical';

export interface OutputOptions {
  single: boolean;
  artboard: boolean;
}

export interface ArtboardOptions {
  widthMm: string;
  heightMm: string;
  heightTolerance5: boolean;
  groupBy: GroupByMode;
  gapMm: string;
  direction: LayoutDirection;
}

export const PDF_MAX_PAGE_MM = Math.floor((14400 * 25.4) / 72);
export const PDF_MIN_PAGE_MM = 10;
const ARTBOARD_SAFETY_MM = 3;
const ARTBOARD_OUTER_MARGIN_MM = 3;

const mmToPt = (mm: number) => (mm * 72) / 25.4;
const ptToMm = (pt: number) => (pt * 25.4) / 72;

function clampMm(mm: number): number {
  if (!Number.isFinite(mm)) return PDF_MIN_PAGE_MM;
  return Math.min(PDF_MAX_PAGE_MM, Math.max(PDF_MIN_PAGE_MM, mm));
}

function parseMm(value: string, fallback: number): number {
  const parsed = parseFloat(value);
  return clampMm(Number.isFinite(parsed) ? parsed : fallback);
}

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

function rotatePath90(path: opentype.Path): opentype.Path {
  const rotated = new opentype.Path();
  for (const cmd of path.commands) {
    switch (cmd.type) {
      case 'M':
      case 'L':
        rotated.commands.push({ type: cmd.type, x: -cmd.y, y: cmd.x });
        break;
      case 'Q':
        rotated.commands.push({
          type: 'Q',
          x1: -cmd.y1,
          y1: cmd.x1,
          x: -cmd.y,
          y: cmd.x,
        });
        break;
      case 'C':
        rotated.commands.push({
          type: 'C',
          x1: -cmd.y1,
          y1: cmd.x1,
          x2: -cmd.y2,
          y2: cmd.x2,
          x: -cmd.y,
          y: cmd.x,
        });
        break;
      case 'Z':
        rotated.commands.push({ type: 'Z' });
        break;
    }
  }
  return rotated;
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
  let previousGlyph: opentype.Glyph | null = null;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    let glyph: opentype.Glyph;

    if (char === '1') {
      glyph = font.glyphs.get(ONE_ALT_GLYPH_INDEX);
    } else {
      glyph = font.charToGlyph(char);
    }

    if (previousGlyph) {
      cursorX += font.getKerningValue(previousGlyph, glyph) * scale;
    }

    const glyphPath = glyph.getPath(cursorX, y, fontSize);
    for (const cmd of glyphPath.commands) {
      combinedPath.commands.push(cmd);
    }

    cursorX += (glyph.advanceWidth ?? 0) * scale;
    previousGlyph = glyph;
  }

  return { path: combinedPath, advanceWidth: cursorX - x };
}

// Draw text as vector outlines — stroke only, no fill
function drawTextStroke(
  page: PDFPage,
  path: opentype.Path,
  x: number,
  baselineY: number,
  strokeColor: ReturnType<typeof rgb>,
  strokeWidth: number = 1,
) {
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

function measureTextBounds(font: opentype.Font, text: string, fontSize: number) {
  const { path } = getTextPath(font, text, 0, 0, fontSize);
  const bounds = path.getBoundingBox();
  return {
    widthPt: bounds.x2 - bounds.x1,
    heightPt: bounds.y2 - bounds.y1,
  };
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
    const heightMm = Math.round(ptToMm(glyphHeightPt) + 10); // 10mm vertical padding
    const paddingMm = 20;

    // Measure each tram number's width using actual outline bounds so packed artboards do not overlap.
    const measured = tramNumbers.map(num => ({
      num,
      widthMm: Math.ceil(ptToMm(measureTextBounds(font, num, fontSize).widthPt) + paddingMm),
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

interface StickerJob {
  tram: TramRow;
  size: SizeConfig;
  category: WidthCategory;
  copies: number;
  fontSizePt: number;
  textPath: opentype.Path;
  textWidthMm: number;
  textHeightMm: number;
}

interface ArtboardLayoutItem {
  job: StickerJob;
  rotated: boolean;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

interface PackedArtboardPage {
  heightMm: number;
  usedHeightMm: number;
  items: ArtboardLayoutItem[];
}

function sanitizePart(value: string): string {
  return (value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'без_имени';
}

function buildSingleFolderPath(folderOrder: string[], tram: TramRow, size: SizeConfig): string {
  const pathParts: string[] = [];
  for (const key of folderOrder) {
    switch (key) {
      case 'depot': pathParts.push(sanitizePart(tram.depot || 'без_депо')); break;
      case 'model': pathParts.push(sanitizePart(tram.model || 'без_модели')); break;
      case 'size': pathParts.push(sanitizePart(`${size.index}_${size.suffix}`)); break;
    }
  }
  return pathParts.length ? `${pathParts.join('/')}/` : '';
}

function drawSticker(
  page: PDFPage,
  font: opentype.Font,
  tramNumber: string,
  fontSize: number,
  xPt: number,
  yPt: number,
  widthPt: number,
  heightPt: number,
  rotated: boolean,
) {
  page.drawRectangle({
    x: xPt,
    y: yPt,
    width: widthPt,
    height: heightPt,
    color: rgb(1, 1, 1),
  });

  const { path } = getTextPath(font, tramNumber, 0, 0, fontSize);
  const effectivePath = rotated ? rotatePath90(path) : path;
  const bounds = effectivePath.getBoundingBox();
  const glyphVisualWidth = bounds.x2 - bounds.x1;
  const glyphVisualHeight = bounds.y2 - bounds.y1;
  const textX = xPt + (widthPt - glyphVisualWidth) / 2 - bounds.x1;
  const baselineY = yPt + (heightPt - glyphVisualHeight) / 2 + bounds.y2;
  drawTextStroke(page, effectivePath, textX, baselineY, rgb(0, 0, 0), 1);
}

function drawArtboardItem(
  page: PDFPage,
  item: ArtboardLayoutItem,
  pageHeightMm: number,
) {
  const effectivePath = item.rotated ? rotatePath90(item.job.textPath) : item.job.textPath;
  const bounds = effectivePath.getBoundingBox();
  const boundsWidthPt = bounds.x2 - bounds.x1;
  const boundsHeightPt = bounds.y2 - bounds.y1;
  const boxLeftPt = mmToPt(item.xMm);
  const boxBottomPt = mmToPt(pageHeightMm - item.yMm - item.heightMm);
  const boxWidthPt = mmToPt(item.widthMm);
  const boxHeightPt = mmToPt(item.heightMm);

  const xPt = boxLeftPt + (boxWidthPt - boundsWidthPt) / 2 - bounds.x1;
  const yPt = boxBottomPt + (boxHeightPt - boundsHeightPt) / 2 + bounds.y2;

  drawTextStroke(page, effectivePath, xPt, yPt, rgb(0, 0, 0), 1);
}

function expandJobsForArtboards(jobs: StickerJob[]): StickerJob[] {
  const expanded: StickerJob[] = [];
  for (const job of jobs) {
    for (let i = 0; i < job.copies; i++) expanded.push(job);
  }
  return expanded;
}

function buildArtboardGroupMeta(job: StickerJob, groupBy: GroupByMode) {
  const sizeLabel = sanitizePart(`${job.size.index}_${job.size.suffix}`);
  const depotLabel = sanitizePart(job.tram.depot || 'без_депо');
  const modelLabel = sanitizePart(job.tram.model || 'без_модели');

  if (groupBy === 'model_depot') {
    return {
      key: `${modelLabel}__${depotLabel}__${sizeLabel}`,
      nameParts: [modelLabel, depotLabel, sizeLabel],
    };
  }
  if (groupBy === 'depot') {
    return {
      key: `${depotLabel}__${sizeLabel}`,
      nameParts: [depotLabel, sizeLabel],
    };
  }
  return {
    key: `all__${sizeLabel}`,
    nameParts: ['все', sizeLabel],
  };
}

function groupArtboardJobs(
  jobs: StickerJob[],
  groupBy: GroupByMode,
): Array<{ key: string; nameParts: string[]; jobs: StickerJob[] }> {
  const groups = new Map<string, { key: string; nameParts: string[]; jobs: StickerJob[] }>();
  for (const job of jobs) {
    const meta = buildArtboardGroupMeta(job, groupBy);
    if (!groups.has(meta.key)) groups.set(meta.key, { key: meta.key, nameParts: meta.nameParts, jobs: [] });
    groups.get(meta.key)!.jobs.push(job);
  }
  return [...groups.values()];
}

function packArtboardJobs(
  jobs: StickerJob[],
  options: ArtboardOptions,
): { widthMm: number; pages: PackedArtboardPage[] } {
  const artboardWidthMm = parseMm(options.widthMm, 1000);
  const targetHeightMm = parseMm(options.heightMm, 1000);
  const gapMm = Math.max(0, parseFloat(options.gapMm) || 0);
  const maxHeightMm = options.heightTolerance5 ? targetHeightMm * 1.05 : targetHeightMm;
  const minHeightMm = options.heightTolerance5 ? targetHeightMm * 0.95 : targetHeightMm;
  const sortedJobs = [...jobs].sort((a, b) => {
    const aPrimary = options.direction === 'horizontal' ? a.textWidthMm : a.textHeightMm;
    const bPrimary = options.direction === 'horizontal' ? b.textWidthMm : b.textHeightMm;
    const aSecondary = options.direction === 'horizontal' ? a.textHeightMm : a.textWidthMm;
    const bSecondary = options.direction === 'horizontal' ? b.textHeightMm : b.textWidthMm;
    return (bPrimary - aPrimary) || (bSecondary - aSecondary);
  });

  const packWithHeight = (pageMaxHeightMm: number): PackedArtboardPage[] => {
    const queue = [...sortedJobs];
    const packedPages: PackedArtboardPage[] = [];

    while (queue.length) {
      const items: ArtboardLayoutItem[] = [];
      let usedHeightMm = 0;

      if (options.direction === 'horizontal') {
        let cursorY = ARTBOARD_OUTER_MARGIN_MM;
        const usableWidthMm = artboardWidthMm - ARTBOARD_OUTER_MARGIN_MM * 2;
        const usableHeightMm = pageMaxHeightMm - ARTBOARD_OUTER_MARGIN_MM * 2;

        while (queue.length) {
          const rowY = cursorY;
          let rowHeight = 0;
          let rowWidth = ARTBOARD_OUTER_MARGIN_MM;
          let placedInRow = false;
          const rowStartIndex = items.length;
          let i = 0;

          while (i < queue.length) {
            const job = queue[i];
            const widthMm = job.textWidthMm + ARTBOARD_SAFETY_MM * 2;
            const heightMm = job.textHeightMm + ARTBOARD_SAFETY_MM * 2;
            const nextX = rowWidth === ARTBOARD_OUTER_MARGIN_MM ? ARTBOARD_OUTER_MARGIN_MM : rowWidth + gapMm;

            if (heightMm > usableHeightMm || widthMm > usableWidthMm) {
              throw new Error(`Номер ${job.tram.tram} (${job.size.index}) не помещается на артборд ${artboardWidthMm}×${targetHeightMm} мм.`);
            }
            if (nextX + widthMm > artboardWidthMm - ARTBOARD_OUTER_MARGIN_MM) {
              i++;
              continue;
            }

            items.push({ job, rotated: false, xMm: nextX, yMm: rowY, widthMm, heightMm });
            rowWidth = nextX + widthMm;
            rowHeight = Math.max(rowHeight, heightMm);
            placedInRow = true;
            queue.splice(i, 1);
          }

          if (!placedInRow) break;
          if (rowY + rowHeight > pageMaxHeightMm - ARTBOARD_OUTER_MARGIN_MM) {
            items.length = rowStartIndex;
            break;
          }

          usedHeightMm = Math.max(usedHeightMm, rowY + rowHeight);
          cursorY = rowY + rowHeight + gapMm;
          if (cursorY > pageMaxHeightMm) break;
        }

        const stripSegments: Array<{ startYMm: number; endYMm: number; startXMm: number }> = [];
        if (items.length) {
          const rawBands: Array<{ startYMm: number; endYMm: number; startXMm: number }> = [];
          const yBreaks = [...new Set([
            ARTBOARD_OUTER_MARGIN_MM,
            usedHeightMm,
            ...items.flatMap((item) => [item.yMm, item.yMm + item.heightMm]),
          ])].sort((a, b) => a - b);

          for (let bandIndex = 0; bandIndex < yBreaks.length - 1; bandIndex++) {
            const bandStartYMm = yBreaks[bandIndex];
            const bandEndYMm = yBreaks[bandIndex + 1];
            if (bandEndYMm <= bandStartYMm) continue;

            let occupiedRightMm = ARTBOARD_OUTER_MARGIN_MM;
            for (const item of items) {
              const intersectsBand = item.yMm < bandEndYMm && item.yMm + item.heightMm > bandStartYMm;
              if (intersectsBand) {
                occupiedRightMm = Math.max(occupiedRightMm, item.xMm + item.widthMm);
              }
            }

            const startXMm = Math.min(
              artboardWidthMm - ARTBOARD_OUTER_MARGIN_MM,
              occupiedRightMm > ARTBOARD_OUTER_MARGIN_MM ? occupiedRightMm + gapMm : ARTBOARD_OUTER_MARGIN_MM,
            );

            if (startXMm >= artboardWidthMm - ARTBOARD_OUTER_MARGIN_MM) continue;
            rawBands.push({ startYMm: bandStartYMm, endYMm: bandEndYMm, startXMm });
          }

          if (rawBands.length) {
            let currentSegment = { ...rawBands[0] };
            for (let bandIndex = 1; bandIndex < rawBands.length; bandIndex++) {
              const band = rawBands[bandIndex];
              if (
                Math.abs(currentSegment.endYMm - band.startYMm) < 0.001
                && band.startXMm <= currentSegment.startXMm + 0.001
              ) {
                currentSegment.endYMm = band.endYMm;
              } else {
                stripSegments.push(currentSegment);
                currentSegment = { ...band };
              }
            }
            stripSegments.push(currentSegment);
          }
        }

        for (const segment of stripSegments) {
          const stripWidth = artboardWidthMm - ARTBOARD_OUTER_MARGIN_MM - segment.startXMm;
          const stripHeight = segment.endYMm - segment.startYMm;
          if (stripWidth <= 0 || stripHeight <= 0) continue;

          let columnX = segment.startXMm;
          let columnY = segment.startYMm;
          let columnWidth = 0;
          let i = 0;

          while (i < queue.length) {
            const job = queue[i];
            const widthMm = job.textHeightMm + ARTBOARD_SAFETY_MM * 2;
            const heightMm = job.textWidthMm + ARTBOARD_SAFETY_MM * 2;

            if (widthMm > stripWidth || heightMm > stripHeight) {
              i++;
              continue;
            }

            const nextY = columnY === segment.startYMm ? segment.startYMm : columnY + gapMm;
            if (nextY + heightMm <= segment.endYMm) {
              items.push({ job, rotated: true, xMm: columnX, yMm: nextY, widthMm, heightMm });
              columnY = nextY + heightMm;
              columnWidth = Math.max(columnWidth, widthMm);
              usedHeightMm = Math.max(usedHeightMm, nextY + heightMm);
              queue.splice(i, 1);
              continue;
            }

            const nextColumnX = columnX + columnWidth + gapMm;
            if (columnWidth > 0 && nextColumnX + widthMm <= artboardWidthMm - ARTBOARD_OUTER_MARGIN_MM) {
              columnX = nextColumnX;
              columnY = segment.startYMm;
              columnWidth = 0;
              continue;
            }
            i++;
          }
        }
      } else {
        let cursorX = ARTBOARD_OUTER_MARGIN_MM;
        const usableWidthMm = artboardWidthMm - ARTBOARD_OUTER_MARGIN_MM * 2;
        const usableHeightMm = pageMaxHeightMm - ARTBOARD_OUTER_MARGIN_MM * 2;

        while (queue.length) {
          const columnX = cursorX;
          let columnHeight = 0;
          let columnWidth = 0;
          let placedInColumn = false;
          const columnStartIndex = items.length;
          let i = 0;

          while (i < queue.length) {
            const job = queue[i];
            const widthMm = job.textHeightMm + ARTBOARD_SAFETY_MM * 2;
            const heightMm = job.textWidthMm + ARTBOARD_SAFETY_MM * 2;
            const nextY = columnHeight === 0 ? ARTBOARD_OUTER_MARGIN_MM : columnHeight + gapMm;

            if (widthMm > usableWidthMm || heightMm > usableHeightMm) {
              throw new Error(`Номер ${job.tram.tram} (${job.size.index}) не помещается на артборд ${artboardWidthMm}×${targetHeightMm} мм.`);
            }
            if (nextY + heightMm > pageMaxHeightMm - ARTBOARD_OUTER_MARGIN_MM) {
              i++;
              continue;
            }

            items.push({ job, rotated: true, xMm: columnX, yMm: nextY, widthMm, heightMm });
            columnHeight = nextY + heightMm;
            columnWidth = Math.max(columnWidth, widthMm);
            placedInColumn = true;
            queue.splice(i, 1);
          }

          if (!placedInColumn) break;
          if (columnX + columnWidth > artboardWidthMm - ARTBOARD_OUTER_MARGIN_MM) {
            items.length = columnStartIndex;
            break;
          }

          usedHeightMm = Math.max(usedHeightMm, columnHeight);
          cursorX = columnX + columnWidth + gapMm;
          if (cursorX > artboardWidthMm) break;
        }
      }

      if (!items.length) {
        const job = queue[0];
        const fitsUnrotated = job.textWidthMm + ARTBOARD_SAFETY_MM * 2 <= artboardWidthMm - ARTBOARD_OUTER_MARGIN_MM * 2
          && job.textHeightMm + ARTBOARD_SAFETY_MM * 2 <= pageMaxHeightMm - ARTBOARD_OUTER_MARGIN_MM * 2;
        const fitsRotated = job.textHeightMm + ARTBOARD_SAFETY_MM * 2 <= artboardWidthMm - ARTBOARD_OUTER_MARGIN_MM * 2
          && job.textWidthMm + ARTBOARD_SAFETY_MM * 2 <= pageMaxHeightMm - ARTBOARD_OUTER_MARGIN_MM * 2;
        if (!fitsUnrotated && !fitsRotated) {
          throw new Error(`Номер ${job.tram.tram} (${job.size.index}) не помещается на артборд ${artboardWidthMm}×${targetHeightMm} мм.`);
        }
        throw new Error('Не удалось разместить номера на артборде. Проверьте размеры и отступы.');
      }

      const actualHeightMm = clampMm(usedHeightMm + ARTBOARD_OUTER_MARGIN_MM);
      packedPages.push({
        heightMm: actualHeightMm,
        usedHeightMm: actualHeightMm,
        items,
      });
    }

    return packedPages;
  };

  let pages = packWithHeight(maxHeightMm);

  if (options.heightTolerance5 && pages.length > 1) {
    const targetPageCount = pages.length;
    let low = minHeightMm;
    let high = maxHeightMm;
    let bestPages = pages;

    for (let i = 0; i < 12; i++) {
      const mid = (low + high) / 2;
      const candidatePages = packWithHeight(mid);

      if (candidatePages.length <= targetPageCount) {
        bestPages = candidatePages;
        high = mid;
      } else {
        low = mid;
      }
    }

    pages = bestPages;
  }

  return { widthMm: artboardWidthMm, pages };
}

export async function generateStickers(
  trams: TramRow[],
  sizes: SizeConfig[],
  allCategories: Record<string, WidthCategory[]>,
  folderOrder: string[] = [],
  outputOptions: OutputOptions = { single: true, artboard: false },
  artboardOptions?: ArtboardOptions,
) {
  const zip = new JSZip();
  const font = await loadOpentypeFont();
  const normalizedArtboardOptions: ArtboardOptions = artboardOptions ?? {
    widthMm: '1000',
    heightMm: '1000',
    heightTolerance5: true,
    groupBy: 'all',
    gapMm: '10',
    direction: 'horizontal',
  };

  let generatedCount = 0;
  const stickerJobs: StickerJob[] = [];

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

      const mainFontSize = parseFloat(size.fontSize) || 160;
      const { path } = getTextPath(font, tram.tram, 0, 0, mainFontSize);
      const textBounds = measureTextBounds(font, tram.tram, mainFontSize);
      stickerJobs.push({
        tram,
        size,
        category: cat,
        copies,
        fontSizePt: mainFontSize,
        textPath: path,
        textWidthMm: ptToMm(textBounds.widthPt),
        textHeightMm: ptToMm(textBounds.heightPt),
      });
    }
  }

  if (outputOptions.single) {
    const rootPrefix = outputOptions.artboard ? 'один_файл_на_номер/' : '';
    for (const job of stickerJobs) {
      const width = mmToPt(job.category.widthMm);
      const height = mmToPt(job.category.heightMm);
      const doc = await PDFDocument.create();
      const page = doc.addPage([width, height]);
      drawSticker(page, font, job.tram.tram, job.fontSizePt, 0, 0, width, height, false);

      const pdfBytes = await doc.save();
      const filename = sanitizePart(`${job.tram.tram}_${job.tram.model}_${job.tram.depot}_${job.size.index}_${job.size.suffix}_${job.category.sizeStr}_${job.copies}ekz`) + '.pdf';
      const folderPath = buildSingleFolderPath(folderOrder, job.tram, job.size);
      zip.file(rootPrefix + folderPath + filename, pdfBytes);
      generatedCount++;
    }
  }

  if (outputOptions.artboard) {
    const rootPrefix = outputOptions.single ? 'артборды/' : '';
    const artboardGroups = groupArtboardJobs(expandJobsForArtboards(stickerJobs), normalizedArtboardOptions.groupBy);
    for (const group of artboardGroups) {
      const packed = packArtboardJobs(group.jobs, normalizedArtboardOptions);
      for (const [pageIndex, packedPage] of packed.pages.entries()) {
        const artboardDoc = await PDFDocument.create();
        const page = artboardDoc.addPage([mmToPt(packed.widthMm), mmToPt(packedPage.heightMm)]);
        page.drawRectangle({
          x: 0,
          y: 0,
          width: mmToPt(packed.widthMm),
          height: mmToPt(packedPage.heightMm),
          color: rgb(1, 1, 1),
        });

        for (const item of packedPage.items) {
          drawArtboardItem(page, item, packedPage.heightMm);
        }

        const pdfBytes = await artboardDoc.save();
        const filename = sanitizePart([
          ...group.nameParts,
          `p${pageIndex + 1}`,
          `${Math.round(packed.widthMm)}x${Math.round(packedPage.heightMm)}`,
        ].join('_')) + '.pdf';
        zip.file(rootPrefix + filename, pdfBytes);
        generatedCount++;
      }
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

import React, { useState, useRef, useEffect, useCallback } from 'react';
import Papa from 'papaparse';
import { Copy, Plus, Trash2, Download, Upload, GripVertical, RotateCcw, FolderTree, Check, ChevronDown } from 'lucide-react';
import {
  generateStickers,
  calculateWidthCategories,
  PDF_MAX_PAGE_MM,
  PDF_MIN_PAGE_MM,
} from './utils/pdfGenerator';
import type {
  SizeConfig,
  TramRow,
  WidthCategory,
  OutputOptions,
  ArtboardOptions,
} from './utils/pdfGenerator';
import './index.css';

const LS_SIZES = 'tramgen_sizes';
const LS_TRAMS = 'tramgen_trams';
const LS_CATS = 'tramgen_categories';
const LS_DISABLED = 'tramgen_disabled';
const LS_FOLDERS = 'tramgen_folders';
const LS_OUTPUT_OPTIONS = 'tramgen_output_options';
const LS_ARTBOARD_OPTIONS = 'tramgen_artboard_options';

function loadLS<T>(key: string, fallback: T): T {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; }
  catch { return fallback; }
}

function clampArtboardMm(value: string, fallback: string): string {
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return String(Math.min(PDF_MAX_PAGE_MM, Math.max(PDF_MIN_PAGE_MM, parsed)));
}

function clampGapMm(value: string, fallback: string): string {
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return String(Math.max(0, Math.min(PDF_MAX_PAGE_MM, parsed)));
}

function timestamp(): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yy}${mm}${dd}-${hh}:${mi}`;
}

function downloadText(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Apply disabled labels: merge disabled categories' trams into next enabled larger one
function applyDisabledFilter(raw: WidthCategory[], disabled: string[]): WidthCategory[] {
  if (!raw.length || !disabled.length) return raw;
  const enabled: WidthCategory[] = [];
  const pending: string[] = [];
  for (const cat of raw) {
    if (disabled.includes(cat.label)) {
      pending.push(...cat.tramNumbers);
    } else {
      enabled.push({ ...cat, tramNumbers: [...cat.tramNumbers, ...pending] });
      pending.length = 0;
    }
  }
  if (pending.length && enabled.length) {
    const last = enabled[enabled.length - 1];
    enabled[enabled.length - 1] = { ...last, tramNumbers: [...last.tramNumbers, ...pending] };
  }
  return enabled;
}

// ─── Folder levels ───
interface FolderLevel { key: string; label: string; enabled: boolean; }
const defaultFolders: FolderLevel[] = [
  { key: 'depot', label: 'Депо', enabled: false },
  { key: 'model', label: 'Модель', enabled: false },
  { key: 'size', label: 'Размер', enabled: false },
];

const defaultOutputOptions: OutputOptions = {
  single: true,
  artboard: false,
};

const defaultArtboardOptions: ArtboardOptions = {
  widthMm: '1000',
  heightMm: '1000',
  heightTolerance5: true,
  groupBy: 'all',
  gapMm: '10',
  direction: 'horizontal',
};

function normalizeOutputOptions(value: unknown): OutputOptions {
  if (!value || typeof value !== 'object') return defaultOutputOptions;
  const source = value as Partial<OutputOptions>;
  return {
    single: typeof source.single === 'boolean' ? source.single : defaultOutputOptions.single,
    artboard: typeof source.artboard === 'boolean' ? source.artboard : defaultOutputOptions.artboard,
  };
}

function normalizeArtboardOptions(value: unknown): ArtboardOptions {
  if (!value || typeof value !== 'object') return defaultArtboardOptions;
  const source = value as Partial<ArtboardOptions> & { size?: string };
  return {
    widthMm: clampArtboardMm(source.widthMm ?? defaultArtboardOptions.widthMm, defaultArtboardOptions.widthMm),
    heightMm: clampArtboardMm(source.heightMm ?? defaultArtboardOptions.heightMm, defaultArtboardOptions.heightMm),
    heightTolerance5: typeof source.heightTolerance5 === 'boolean' ? source.heightTolerance5 : defaultArtboardOptions.heightTolerance5,
    groupBy: source.groupBy === 'depot' || source.groupBy === 'model_depot' || source.groupBy === 'all'
      ? source.groupBy
      : defaultArtboardOptions.groupBy,
    gapMm: clampGapMm(source.gapMm ?? defaultArtboardOptions.gapMm, defaultArtboardOptions.gapMm),
    direction: source.direction === 'vertical' || source.direction === 'horizontal'
      ? source.direction
      : defaultArtboardOptions.direction,
  };
}

function App() {
  const [sizes, setSizes] = useState<SizeConfig[]>(() =>
    loadLS(LS_SIZES, [
      { id: 'size_1', index: '28', suffix: 'салон-чёрн', fontSize: '160' },
      { id: 'size_2', index: '41a', suffix: 'пер-светоотр', fontSize: '436' },
    ])
  );
  const [trams, setTrams] = useState<TramRow[]>(() =>
    loadLS(LS_TRAMS, [
      { id: 'tram_1', tram: '31001', model: '71-931М', depot: 'Баумана', quantities: { size_1: '10', size_2: '5' } },
    ])
  );
  const [rawCategories, setRawCategories] = useState<Record<string, WidthCategory[]>>(() => loadLS(LS_CATS, {}));
  const [disabledLabels, setDisabledLabels] = useState<Record<string, string[]>>(() => loadLS(LS_DISABLED, {}));
  const [folders, setFolders] = useState<FolderLevel[]>(() => loadLS(LS_FOLDERS, defaultFolders));
  const [outputOptions, setOutputOptions] = useState<OutputOptions>(() => normalizeOutputOptions(loadLS(LS_OUTPUT_OPTIONS, defaultOutputOptions)));
  const [artboardOptions, setArtboardOptions] = useState<ArtboardOptions>(() => normalizeArtboardOptions(loadLS(LS_ARTBOARD_OPTIONS, defaultArtboardOptions)));
  const [folderDropdownOpen, setFolderDropdownOpen] = useState(false);
  const [artboardDropdownOpen, setArtboardDropdownOpen] = useState(false);
  const [outputModeError, setOutputModeError] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [folderDragIdx, setFolderDragIdx] = useState<number | null>(null);

  const sizesFileRef = useRef<HTMLInputElement>(null);
  const tramsFileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLDivElement>(null);
  const artboardRef = useRef<HTMLDivElement>(null);

  // Undo stack for clear operations
  const undoStack = useRef<Array<{ type: 'sizes' | 'trams'; sizes?: SizeConfig[]; trams?: TramRow[] }>>([]);

  // Derived: effective categories
  const widthCategories: Record<string, WidthCategory[]> = {};
  for (const sid of Object.keys(rawCategories)) {
    widthCategories[sid] = applyDisabledFilter(rawCategories[sid] || [], disabledLabels[sid] || []);
  }

  // Persist
  useEffect(() => { localStorage.setItem(LS_SIZES, JSON.stringify(sizes)); }, [sizes]);
  useEffect(() => { localStorage.setItem(LS_TRAMS, JSON.stringify(trams)); }, [trams]);
  useEffect(() => { localStorage.setItem(LS_CATS, JSON.stringify(rawCategories)); }, [rawCategories]);
  useEffect(() => { localStorage.setItem(LS_DISABLED, JSON.stringify(disabledLabels)); }, [disabledLabels]);
  useEffect(() => { localStorage.setItem(LS_FOLDERS, JSON.stringify(folders)); }, [folders]);
  useEffect(() => { localStorage.setItem(LS_OUTPUT_OPTIONS, JSON.stringify(outputOptions)); }, [outputOptions]);
  useEffect(() => { localStorage.setItem(LS_ARTBOARD_OPTIONS, JSON.stringify(artboardOptions)); }, [artboardOptions]);

  // Ctrl+Z undo for clear
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        const last = undoStack.current.pop();
        if (last) {
          e.preventDefault();
          if (last.type === 'sizes' && last.sizes) setSizes(last.sizes);
          if (last.type === 'trams' && last.trams) setTrams(last.trams);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Close folder dropdown on outside click
  useEffect(() => {
    if (!folderDropdownOpen && !artboardDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (folderRef.current && !folderRef.current.contains(e.target as Node)) {
        setFolderDropdownOpen(false);
      }
      if (artboardRef.current && !artboardRef.current.contains(e.target as Node)) {
        setArtboardDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [folderDropdownOpen, artboardDropdownOpen]);

  // ─── Auto-analyze: only trams with >0 quantity for each size ───
  const analysisKeys = sizes.map(sz => {
    const nums = trams
      .filter(t => t.tram && parseInt(t.quantities[sz.id], 10) > 0)
      .map(t => t.tram).sort().join(',');
    return `${sz.id}:${sz.fontSize}:${nums}`;
  }).join('|');

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      for (const sz of sizes) {
        if (!sz.fontSize) continue;
        const nums = trams
          .filter(t => t.tram && parseInt(t.quantities[sz.id], 10) > 0)
          .map(t => t.tram);
        if (!nums.length) {
          if (!cancelled) setRawCategories(prev => ({ ...prev, [sz.id]: [] }));
          continue;
        }
        try {
          const cats = await calculateWidthCategories(sz.fontSize, nums);
          if (!cancelled) setRawCategories(prev => ({ ...prev, [sz.id]: cats }));
        } catch (e) { console.error(e); }
      }
    };
    const timer = setTimeout(run, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [analysisKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Can a category be toggled off? ───
  function canToggleOff(sizeId: string, label: string): boolean {
    const rawCats = rawCategories[sizeId] || [];
    const disabled = disabledLabels[sizeId] || [];
    const catIdx = rawCats.findIndex(c => c.label === label);
    if (catIdx === -1) return false;
    return rawCats.some((c, i) => i > catIdx && !disabled.includes(c.label));
  }

  // Effective count for a raw category label (accounts for merges)
  function effectiveCount(sizeId: string, label: string): number {
    const disabled = disabledLabels[sizeId] || [];
    if (disabled.includes(label)) return 0;
    const eff = widthCategories[sizeId] || [];
    const cat = eff.find(c => c.label === label);
    return cat ? cat.tramNumbers.length : 0;
  }

  // ─── Sizes ───
  const handleAddSize = () => {
    setSizes(p => [...p, { id: `s${Date.now()}`, index: '', suffix: '', fontSize: '160' }]);
  };

  const handleDuplicateSize = (i: number) => {
    setSizes(p => { const n = [...p]; n.splice(i + 1, 0, { ...p[i], id: `s${Date.now()}` }); return n; });
  };

  const handleRemoveSize = (i: number) => {
    const sid = sizes[i].id;
    setSizes(p => p.filter((_, j) => j !== i));
    setTrams(p => p.map(t => { const q = { ...t.quantities }; delete q[sid]; return { ...t, quantities: q }; }));
    setRawCategories(p => { const n = { ...p }; delete n[sid]; return n; });
    setDisabledLabels(p => { const n = { ...p }; delete n[sid]; return n; });
  };

  const handleSizeChange = useCallback((i: number, field: keyof SizeConfig, value: string) => {
    setSizes(prev => { const n = [...prev]; n[i] = { ...n[i], [field]: value }; return n; });
  }, []);

  const toggleCategoryLabel = (sizeId: string, label: string) => {
    setDisabledLabels(prev => {
      const current = prev[sizeId] || [];
      const isDisabled = current.includes(label);
      if (!isDisabled && !canToggleOff(sizeId, label)) return prev;
      const next = isDisabled ? current.filter(l => l !== label) : [...current, label];
      return { ...prev, [sizeId]: next };
    });
  };

  // ─── Size drag reorder ───
  const handleDragStart = (i: number) => { setDragIdx(i); };
  const handleDragOver = (e: React.DragEvent, i: number) => { e.preventDefault(); setDragOverIdx(i); };
  const handleDragLeave = () => { setDragOverIdx(null); };
  const handleDrop = (i: number) => {
    if (dragIdx === null || dragIdx === i) { setDragIdx(null); setDragOverIdx(null); return; }
    setSizes(prev => { const n = [...prev]; const [m] = n.splice(dragIdx, 1); n.splice(i, 0, m); return n; });
    setDragIdx(null); setDragOverIdx(null);
  };
  const handleDragEnd = () => { setDragIdx(null); setDragOverIdx(null); };

  // ─── Clear tables ───
  const handleClearSizes = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!confirm('Очистить таблицу размеров?\n\nCtrl+Z / Cmd+Z — для отмены.')) return;
    undoStack.current.push({ type: 'sizes', sizes: [...sizes] });
    setSizes([]);
    setRawCategories({});
    setDisabledLabels({});
  };
  const handleClearTrams = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!confirm('Очистить таблицу транспорта?\n\nCtrl+Z / Cmd+Z — для отмены.')) return;
    undoStack.current.push({ type: 'trams', trams: [...trams] });
    setTrams([]);
  };

  // ─── Folder levels ───
  const toggleFolder = (i: number) => {
    setFolders(prev => { const n = [...prev]; n[i] = { ...n[i], enabled: !n[i].enabled }; return n; });
  };
  const handleFolderDragStart = (i: number) => { setFolderDragIdx(i); };
  const handleFolderDrop = (i: number) => {
    if (folderDragIdx === null || folderDragIdx === i) { setFolderDragIdx(null); return; }
    setFolders(prev => { const n = [...prev]; const [m] = n.splice(folderDragIdx, 1); n.splice(i, 0, m); return n; });
    setFolderDragIdx(null);
  };
  const activeFolderOrder = folders.filter(f => f.enabled).map(f => f.key);
  const setArtboardField = useCallback(function <K extends keyof ArtboardOptions>(field: K, value: ArtboardOptions[K]) {
    setArtboardOptions(prev => ({ ...prev, [field]: value }));
  }, []);
  const normalizeArtboardField = useCallback((field: 'widthMm' | 'heightMm' | 'gapMm') => {
    setArtboardOptions(prev => ({
      ...prev,
      [field]: field === 'gapMm'
        ? clampGapMm(prev[field], defaultArtboardOptions.gapMm)
        : clampArtboardMm(prev[field], defaultArtboardOptions[field]),
    }));
  }, []);
  const toggleOutputOption = useCallback((field: keyof OutputOptions) => {
    setOutputOptions(prev => {
      const next = { ...prev, [field]: !prev[field] };
      if (next.single || next.artboard) setOutputModeError(false);
      return next;
    });
  }, []);

  // ─── Sizes CSV ───
  const handleExportSizes = () => {
    const csv = Papa.unparse(sizes.map(s => ({
      index: s.index, suffix: s.suffix, fontSize: s.fontSize,
    })));
    downloadText(csv, `размеры_${timestamp()}.csv`);
  };

  const handleImportSizes = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    Papa.parse(file, {
      header: true,
      complete: (res) => {
        const imported: SizeConfig[] = (res.data as any[])
          .filter(r => r.index || r.suffix || r.fontSize)
          .map((r, i) => ({
            id: `s${Date.now()}_${i}`, index: r.index || '', suffix: r.suffix || '',
            fontSize: r.fontSize || '160',
          }));
        if (imported.length) setSizes(imported);
      },
    });
    if (sizesFileRef.current) sizesFileRef.current.value = '';
  };

  // ─── Trams ───
  const handleAddTram = () => {
    setTrams(p => [...p, { id: `t${Date.now()}`, tram: '', model: '71-931М', depot: 'Баумана', quantities: {} }]);
  };
  const handleDuplicateTram = (i: number) => {
    setTrams(p => { const n = [...p]; n.splice(i + 1, 0, { ...p[i], id: `t${Date.now()}` }); return n; });
  };
  const handleRemoveTram = (i: number) => { setTrams(p => p.filter((_, j) => j !== i)); };

  const handleTramChange = useCallback((i: number, field: keyof TramRow, value: string) => {
    setTrams(prev => { const n = [...prev]; n[i] = { ...n[i], [field]: value }; return n; });
  }, []);

  const handleQtyChange = useCallback((ti: number, sid: string, value: string) => {
    setTrams(prev => {
      const n = [...prev];
      n[ti] = { ...n[ti], quantities: { ...n[ti].quantities, [sid]: value } };
      return n;
    });
  }, []);

  // ─── Trams CSV ───
  const handleExportTrams = () => {
    const rows = trams.map(t => {
      const base: Record<string, string> = { tram: t.tram, model: t.model, depot: t.depot };
      sizes.forEach(s => { base[`qty_${s.index}_${s.suffix}`] = t.quantities[s.id] || ''; });
      return base;
    });
    downloadText(Papa.unparse(rows), `бортовые_${timestamp()}.csv`);
  };

  const handleImportTrams = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    Papa.parse(file, {
      header: true,
      complete: (res) => {
        const imported: TramRow[] = (res.data as any[])
          .filter(r => r.tram)
          .map((r, i) => {
            const quantities: Record<string, string> = {};
            sizes.forEach(s => { const v = r[`qty_${s.index}_${s.suffix}`]; if (v) quantities[s.id] = v; });
            return { id: `t${Date.now()}_${i}`, tram: r.tram, model: r.model || '', depot: r.depot || '', quantities };
          });
        if (imported.length) setTrams(imported);
      },
    });
    if (tramsFileRef.current) tramsFileRef.current.value = '';
  };

  // ─── Generation ───
  const handleGenerate = async () => {
    if (!outputOptions.single && !outputOptions.artboard) {
      setOutputModeError(true);
      return;
    }
    setIsGenerating(true);
    try { await generateStickers(trams, sizes, widthCategories, activeFolderOrder, outputOptions, artboardOptions); }
    catch (err: any) { console.error(err); alert('Ошибка: ' + err.message); }
    finally { setIsGenerating(false); }
  };

  return (
    <div>
      <h1>Генератор бортовых номеров для печати</h1>
      <div className="page-actions">
        <div className="page-actions-left">
          <button
            type="button"
            className={`btn btn-toggle ${outputOptions.single ? 'btn-toggle-active' : ''}${outputModeError ? ' btn-toggle-error' : ''}`}
            onClick={() => toggleOutputOption('single')}
            aria-pressed={outputOptions.single}
          >
            <span className={`toggle-check ${outputOptions.single ? 'toggle-check-active' : ''}${outputModeError ? ' toggle-check-error' : ''}`}>
              {outputOptions.single && <Check size={12} />}
            </span>
            Один файл на номер
          </button>

          <div ref={artboardRef} className="dropdown-wrap">
            <div
              className={`btn btn-toggle btn-toggle-split ${outputOptions.artboard ? 'btn-toggle-active' : ''}${outputModeError ? ' btn-toggle-error' : ''}`}
              aria-pressed={outputOptions.artboard}
            >
              <button
                type="button"
                className="split-toggle-main"
                onClick={() => toggleOutputOption('artboard')}
              >
                <span className={`toggle-check ${outputOptions.artboard ? 'toggle-check-active' : ''}${outputModeError ? ' toggle-check-error' : ''}`}>
                  {outputOptions.artboard && <Check size={12} />}
                </span>
                Несколько номеров на артборде
              </button>
              <button
                type="button"
                className="split-toggle-dropdown"
                onClick={() => setArtboardDropdownOpen(prev => !prev)}
                aria-label="Открыть настройки артборда"
              >
                <ChevronDown size={14} className={artboardDropdownOpen ? 'chevron-open' : ''} />
              </button>
            </div>

            {artboardDropdownOpen && (
              <div className="dropdown-panel dropdown-panel-wide">
                <label className="form-row">
                  <span className="form-label">Размер артборда</span>
                  <div className="dimension-grid">
                    <label className="form-row form-row-compact">
                      <span className="form-label">Ширина</span>
                      <div className="input-with-suffix">
                        <input
                          className="input-field"
                          type="number"
                          min={PDF_MIN_PAGE_MM}
                          max={PDF_MAX_PAGE_MM}
                          value={artboardOptions.widthMm}
                          onChange={e => setArtboardField('widthMm', e.target.value)}
                          onBlur={() => normalizeArtboardField('widthMm')}
                          title={`Допустимо: ${PDF_MIN_PAGE_MM}–${PDF_MAX_PAGE_MM} мм`}
                        />
                        <span>мм</span>
                      </div>
                    </label>

                    <label className="form-row form-row-compact">
                      <span className="form-label">Высота</span>
                      <div className="dimension-height-row">
                        <div className="input-with-suffix">
                          <input
                            className="input-field"
                            type="number"
                            min={PDF_MIN_PAGE_MM}
                            max={PDF_MAX_PAGE_MM}
                            value={artboardOptions.heightMm}
                            onChange={e => setArtboardField('heightMm', e.target.value)}
                            onBlur={() => normalizeArtboardField('heightMm')}
                            title={`Допустимо: ${PDF_MIN_PAGE_MM}–${PDF_MAX_PAGE_MM} мм`}
                          />
                          <span>мм</span>
                        </div>
                        <button
                          type="button"
                          className={`btn btn-mini-toggle ${artboardOptions.heightTolerance5 ? 'btn-mini-toggle-active' : ''}`}
                          onClick={() => setArtboardField('heightTolerance5', !artboardOptions.heightTolerance5)}
                          title="Корректировать высоту артборда в зависимости от помещающихся номеров."
                        >
                          ± 5%
                        </button>
                      </div>
                    </label>
                  </div>
                </label>

                <div className="form-row">
                  <span className="form-label">Группировать</span>
                  <div className="radio-group radio-group-inline">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="groupBy"
                        checked={artboardOptions.groupBy === 'all'}
                        onChange={() => setArtboardField('groupBy', 'all')}
                      />
                      <span>Все</span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="groupBy"
                        checked={artboardOptions.groupBy === 'depot'}
                        onChange={() => setArtboardField('groupBy', 'depot')}
                      />
                      <span>По депо</span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="groupBy"
                        checked={artboardOptions.groupBy === 'model_depot'}
                        onChange={() => setArtboardField('groupBy', 'model_depot')}
                      />
                      <span>По модели и депо</span>
                    </label>
                  </div>
                </div>

                <label className="form-row">
                  <span className="form-label">Отступ между номерами</span>
                  <div className="input-with-suffix">
                    <input
                      className="input-field"
                      type="number"
                      min="0"
                      max={PDF_MAX_PAGE_MM}
                      value={artboardOptions.gapMm}
                      onChange={e => setArtboardField('gapMm', e.target.value)}
                      onBlur={() => normalizeArtboardField('gapMm')}
                    />
                    <span>мм</span>
                  </div>
                </label>

                <div className="form-row">
                  <span className="form-label">Основное направление укладки на артборде</span>
                  <div className="radio-group radio-group-inline">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="direction"
                        checked={artboardOptions.direction === 'horizontal'}
                        onChange={() => setArtboardField('direction', 'horizontal')}
                      />
                      <span>Горизонтально</span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="direction"
                        checked={artboardOptions.direction === 'vertical'}
                        onChange={() => setArtboardField('direction', 'vertical')}
                      />
                      <span>Вертикально</span>
                    </label>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="page-actions-right">
          <div ref={folderRef} className="dropdown-wrap">
            <button
              type="button"
              className={`btn btn-toggle btn-menu ${activeFolderOrder.length ? 'btn-toggle-active' : ''}`}
              onClick={() => setFolderDropdownOpen(p => !p)}
              title="Настройка иерархии папок в ZIP"
            >
              <span className="menu-toggle-main">
                <FolderTree size={14} /> Папки{activeFolderOrder.length > 0 && ` (${activeFolderOrder.length})`}
              </span>
              <span className="menu-toggle-dropdown" aria-hidden="true">
                <ChevronDown size={14} className={folderDropdownOpen ? 'chevron-open' : ''} />
              </span>
            </button>
            {folderDropdownOpen && (
              <div className="dropdown-panel">
                <div className="dropdown-title">Разложить по папкам</div>
                {folders.map((fl, fi) => {
                  const enabledBefore = folders.slice(0, fi).filter(folder => folder.enabled).length;
                  const folderRowIndent = fl.enabled && enabledBefore > 0 ? enabledBefore : 0;
                  return (
                  <div key={fl.key}
                    className="folder-option-row"
                    draggable
                    onDragStart={() => handleFolderDragStart(fi)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => handleFolderDrop(fi)}
                    style={{ ['--folder-indent' as const]: folderRowIndent } as React.CSSProperties}
                  >
                    <button
                      type="button"
                      onClick={() => toggleFolder(fi)}
                      className={`folder-option-check ${fl.enabled ? 'folder-option-check-active' : ''}`}
                    >
                      {fl.enabled && <Check size={12} color="var(--accent-contrast)" />}
                    </button>
                    <GripVertical size={12} className="folder-option-grip" />
                    <span className={`folder-option-label ${fl.enabled ? 'folder-option-label-active' : ''}`}>
                      {fl.label}
                    </span>
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          <button type="button" className="btn btn-primary btn-action" onClick={handleGenerate}
            disabled={!trams.length || !sizes.length || isGenerating}>
            <Download size={14} /> {isGenerating ? 'Генерация...' : 'Скачать ZIP'}
          </button>
        </div>
      </div>

      {/* ─── SIZES ─── */}
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Размеры</h2>
        <div className="toolbar-right">
          <button type="button" className="btn btn-danger" onClick={handleClearSizes} title="Очистить таблицу">
            <RotateCcw size={14} /> Очистить
          </button>
          <input type="file" accept=".csv" style={{ display: 'none' }} ref={sizesFileRef} onChange={handleImportSizes} />
          <button type="button" className="btn" onClick={() => sizesFileRef.current?.click()}><Upload size={14} /> Импорт CSV</button>
          <button type="button" className="btn" onClick={handleExportSizes}><Download size={14} /> Экспорт CSV</button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th style={{ width: '30px' }}></th>
            <th style={{ width: '70px' }}>Индекс</th>
            <th>Суффикс</th>
            <th style={{ width: '80px' }}>Кегль</th>
            <th>Размеры</th>
            <th style={{ width: '60px' }}></th>
          </tr>
        </thead>
        <tbody>
          {sizes.map((sz, i) => {
            const rawCats = rawCategories[sz.id] || [];
            const disabled = disabledLabels[sz.id] || [];
            return (
              <tr key={sz.id}
                draggable
                onDragStart={() => handleDragStart(i)}
                onDragOver={(e) => handleDragOver(e, i)}
                onDragLeave={handleDragLeave}
                onDrop={() => handleDrop(i)}
                onDragEnd={handleDragEnd}
                className={dragOverIdx === i ? 'drag-over' : ''}
              >
                <td className="drag-handle-cell">
                  <GripVertical size={14} />
                </td>
                <td><input className="input-field" placeholder="28" value={sz.index}
                  onChange={e => handleSizeChange(i, 'index', e.target.value)} /></td>
                <td><input className="input-field" placeholder="чёрн" value={sz.suffix}
                  onChange={e => handleSizeChange(i, 'suffix', e.target.value)} /></td>
                <td><input className="input-field" type="number" value={sz.fontSize}
                  onChange={e => handleSizeChange(i, 'fontSize', e.target.value)} /></td>
                <td className="size-categories-cell">
                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    {rawCats.length === 0 && (
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>—</span>
                    )}
                    {rawCats.map(cat => {
                      const isOff = disabled.includes(cat.label);
                      const locked = !isOff && !canToggleOff(sz.id, cat.label);
                      const count = effectiveCount(sz.id, cat.label);
                      return (
                        <button key={cat.label}
                          className={`category-chip${isOff ? ' category-off' : ''}${locked ? ' category-locked' : ''}`}
                          onClick={() => !locked && toggleCategoryLabel(sz.id, cat.label)}
                          title={locked
                            ? `${cat.label} — единственный размер для этих номеров`
                            : isOff
                              ? `Включить ${cat.label}`
                              : `Выключить ${cat.label} — номера перейдут в больший размер`}
                        >
                          <strong>{cat.label}</strong>
                          <span>{cat.sizeStr}</span>
                          {count > 0 && <span style={{ opacity: 0.5 }}>({count})</span>}
                          <span className="chip-x">{isOff ? '+' : '×'}</span>
                        </button>
                      );
                    })}
                  </div>
                </td>
                <td>
                  <div className="flex-row" style={{ gap: '0.15rem', justifyContent: 'center' }}>
                    <button className="btn" onClick={() => handleDuplicateSize(i)} title="Дублировать"><Copy size={13} /></button>
                    <button className="btn btn-danger" onClick={() => handleRemoveSize(i)} title="Удалить"><Trash2 size={13} /></button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ padding: '0.3rem 0' }}>
        <button type="button" className="btn" onClick={handleAddSize}><Plus size={14} /> Добавить размер</button>
      </div>

      {/* ─── TRAMS ─── */}
      <div className="toolbar" style={{ marginTop: '1rem' }}>
        <h2 style={{ margin: 0 }}>Транспорт</h2>
        <div className="toolbar-right">
          <button type="button" className="btn btn-danger" onClick={handleClearTrams} title="Очистить таблицу">
            <RotateCcw size={14} /> Очистить
          </button>
          <input type="file" accept=".csv" style={{ display: 'none' }} ref={tramsFileRef} onChange={handleImportTrams} />
          <button type="button" className="btn" onClick={() => tramsFileRef.current?.click()}><Upload size={14} /> Импорт CSV</button>
          <button type="button" className="btn" onClick={handleExportTrams}><Download size={14} /> Экспорт CSV</button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Номер</th>
            <th>Модель</th>
            <th>Депо</th>
            {sizes.map(sz => (
              <th key={`th_${sz.id}`} style={{ textAlign: 'center', minWidth: '60px' }}>
                {sz.index}, {sz.fontSize}pt
                <div style={{ fontWeight: 400, fontSize: '0.65rem' }}>{sz.suffix}</div>
              </th>
            ))}
            <th style={{ width: '60px' }}></th>
          </tr>
        </thead>
        <tbody>
          {trams.map((row, i) => (
            <tr key={row.id}>
              <td><input className="input-field" placeholder="31001" value={row.tram}
                onChange={e => handleTramChange(i, 'tram', e.target.value)} /></td>
              <td><input className="input-field" value={row.model}
                onChange={e => handleTramChange(i, 'model', e.target.value)} /></td>
              <td><input className="input-field" value={row.depot}
                onChange={e => handleTramChange(i, 'depot', e.target.value)} /></td>
              {sizes.map(sz => (
                <td key={`q_${row.id}_${sz.id}`}>
                  <input className="input-field" type="number" placeholder="0" min="0"
                    style={{ textAlign: 'center' }}
                    value={row.quantities[sz.id] || ''}
                    onChange={e => handleQtyChange(i, sz.id, e.target.value)} />
                </td>
              ))}
              <td>
                <div className="flex-row" style={{ gap: '0.15rem', justifyContent: 'center' }}>
                  <button className="btn" onClick={() => handleDuplicateTram(i)} title="Дублировать"><Copy size={13} /></button>
                  <button className="btn btn-danger" onClick={() => handleRemoveTram(i)} title="Удалить"><Trash2 size={13} /></button>
                </div>
              </td>
            </tr>
          ))}
          {!trams.length && (
            <tr><td colSpan={4 + sizes.length} style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-secondary)' }}>
              Нет записей. Добавьте транспорт или импортируйте CSV.
            </td></tr>
          )}
        </tbody>
      </table>
      <div style={{ padding: '0.3rem 0' }}>
          <button type="button" className="btn" onClick={handleAddTram}><Plus size={14} /> Добавить транспорт</button>
      </div>
    </div>
  );
}

export default App;

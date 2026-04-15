import React, { useState, useRef, useEffect, useCallback } from 'react';
import Papa from 'papaparse';
import { Copy, Plus, Trash2, Download, Upload, GripVertical, RotateCcw, FolderTree, Check } from 'lucide-react';
import { generateStickers, calculateWidthCategories } from './utils/pdfGenerator';
import type { SizeConfig, TramRow, WidthCategory } from './utils/pdfGenerator';
import './index.css';

const LS_SIZES = 'tramgen_sizes';
const LS_TRAMS = 'tramgen_trams';
const LS_CATS = 'tramgen_categories';
const LS_DISABLED = 'tramgen_disabled';
const LS_FOLDERS = 'tramgen_folders';

function loadLS<T>(key: string, fallback: T): T {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; }
  catch { return fallback; }
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

// CMYK → RGB values (0–1)
function cmykToRgbValues(cmykStr: string): { r: number; g: number; b: number } | null {
  const parts = cmykStr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return null;
  const [c, m, y, k] = parts.map(v => v / 100);
  return { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k) };
}

function cmykStyle(cmykStr: string): React.CSSProperties {
  const rgb = cmykToRgbValues(cmykStr);
  if (!rgb) return {};
  const { r, g, b } = rgb;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return {
    backgroundColor: `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`,
    color: lum > 0.5 ? '#37352f' : '#ffffff',
  };
}

function normalizeCmyk(val: string): string {
  if (!val.trim()) return '0.0.0.0';
  return val;
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

function App() {
  const [sizes, setSizes] = useState<SizeConfig[]>(() =>
    loadLS(LS_SIZES, [
      { id: 'size_1', index: '28', suffix: 'салон-чёрн', fontSize: '160', bgColor: '0.0.0.100', textColor: '0.0.0.0' },
      { id: 'size_2', index: '41a', suffix: 'пер-светоотр', fontSize: '436', bgColor: '0.0.0.0', textColor: '0.0.0.100' },
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
  const [folderDropdownOpen, setFolderDropdownOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [folderDragIdx, setFolderDragIdx] = useState<number | null>(null);

  const sizesFileRef = useRef<HTMLInputElement>(null);
  const tramsFileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLDivElement>(null);

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
    if (!folderDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (folderRef.current && !folderRef.current.contains(e.target as Node)) {
        setFolderDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [folderDropdownOpen]);

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
    setSizes(p => [...p, { id: `s${Date.now()}`, index: '', suffix: '', fontSize: '160', bgColor: '0.0.0.0', textColor: '0.0.0.100' }]);
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

  const handleCmykBlur = useCallback((i: number, field: 'bgColor' | 'textColor') => {
    setSizes(prev => {
      const n = [...prev];
      n[i] = { ...n[i], [field]: normalizeCmyk(n[i][field]) };
      return n;
    });
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

  // ─── Sizes CSV ───
  const handleExportSizes = () => {
    const csv = Papa.unparse(sizes.map(s => ({
      index: s.index, suffix: s.suffix, fontSize: s.fontSize,
      bgColor: s.bgColor, textColor: s.textColor,
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
            bgColor: normalizeCmyk(r.bgColor || ''),
            textColor: normalizeCmyk(r.textColor || ''),
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
    setIsGenerating(true);
    try { await generateStickers(trams, sizes, widthCategories, activeFolderOrder); }
    catch (err: any) { console.error(err); alert('Ошибка: ' + err.message); }
    finally { setIsGenerating(false); }
  };

  return (
    <div>
      <h1>Генератор бортовых номеров для печати</h1>

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
            <th style={{ width: '110px' }}>Заливка CMYK</th>
            <th style={{ width: '110px' }}>Обводка CMYK</th>
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
                <td style={{ cursor: 'grab', color: 'var(--text-secondary)', textAlign: 'center' }}>
                  <GripVertical size={14} />
                </td>
                <td><input className="input-field" placeholder="28" value={sz.index}
                  onChange={e => handleSizeChange(i, 'index', e.target.value)} /></td>
                <td><input className="input-field" placeholder="чёрн" value={sz.suffix}
                  onChange={e => handleSizeChange(i, 'suffix', e.target.value)} /></td>
                <td><input className="input-field" type="number" value={sz.fontSize}
                  onChange={e => handleSizeChange(i, 'fontSize', e.target.value)} /></td>
                <td>
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
                  <input className="input-field cmyk-input" placeholder="C.M.Y.K" value={sz.bgColor}
                    onChange={e => handleSizeChange(i, 'bgColor', e.target.value)}
                    onBlur={() => handleCmykBlur(i, 'bgColor')}
                    style={cmykStyle(sz.bgColor)} />
                </td>
                <td>
                  <input className="input-field cmyk-input" placeholder="C.M.Y.K" value={sz.textColor}
                    onChange={e => handleSizeChange(i, 'textColor', e.target.value)}
                    onBlur={() => handleCmykBlur(i, 'textColor')}
                    style={cmykStyle(sz.textColor)} />
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

          {/* Folder hierarchy dropdown */}
          <div ref={folderRef} style={{ position: 'relative' }}>
	            <button
                  type="button"
	              className={`btn ${activeFolderOrder.length ? 'btn-primary' : ''}`}
	              onClick={() => setFolderDropdownOpen(p => !p)}
	              title="Настройка иерархии папок в ZIP"
	            >
              <FolderTree size={14} /> Папки{activeFolderOrder.length > 0 && ` (${activeFolderOrder.length})`}
            </button>
            {folderDropdownOpen && (
              <div style={{
                position: 'absolute', right: 0, top: '100%', marginTop: 4,
                background: 'white', border: '1px solid var(--border)',
                borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                padding: '0.5rem 0', minWidth: 200, zIndex: 100,
              }}>
                <div style={{ padding: '0.25rem 0.75rem', fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Разложить по папкам
                </div>
                {folders.map((fl, fi) => (
                  <div key={fl.key}
                    draggable
                    onDragStart={() => handleFolderDragStart(fi)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => handleFolderDrop(fi)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.5rem',
                      padding: '0.35rem 0.75rem', cursor: 'grab',
                      paddingLeft: fl.enabled ? `${0.75 + fi * 0.75}rem` : '0.75rem',
                      transition: 'padding-left 0.15s',
                    }}
                  >
                    <button
                      type="button"
	                      onClick={() => toggleFolder(fi)}
	                      style={{
                        width: 18, height: 18, borderRadius: 4, border: '1px solid var(--border)',
                        background: fl.enabled ? 'var(--accent)' : 'transparent',
                        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, padding: 0, transition: 'background 0.1s',
                      }}
                    >
                      {fl.enabled && <Check size={12} color="white" />}
                    </button>
                    <GripVertical size={12} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                    <span style={{ fontSize: '0.8125rem', color: fl.enabled ? '#37352f' : 'var(--text-secondary)' }}>
                      {fl.label}
                    </span>
                    {fl.enabled && (
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginLeft: 'auto' }}>
                        {fi + 1}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <button type="button" className="btn btn-primary" onClick={handleGenerate}
            disabled={!trams.length || !sizes.length || isGenerating}>
            <Download size={14} /> {isGenerating ? 'Генерация...' : 'Скачать ZIP'}
          </button>
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

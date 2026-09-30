import { useEffect, useRef, useState } from 'react';
import { Archive, ArrowDownToLine, ArrowRight, Check, ChevronRight, CircleHelp, File, FileImage, FileJson, FolderOpen, Images, LockKeyhole, Plus, Search, X } from 'lucide-react';
import { LIMITS, initialDecisions, isReview, STATUS_LABEL, unresolved, type Decisions, type Entry, type Input, type Inventory, type Manifest, type Policy } from './engine';
import { captureText, offsetText } from './jpeg';
import { catalog, count, instant, message, number, readLocale, saveLocale, t, type Locale } from './i18n';
import { Language, languageNames } from './Language';

type Tab = 'inventory' | 'review' | 'export';
type Task = { label: string; done: number; total: number };
const offsetOptions = [-720, -660, -600, -570, -540, -480, -420, -360, -300, -240, -210, -180, -120, -60, 0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525, 540, 570, 600, 630, 660, 720, 765, 780, 825, 840];
const tabTitles = { inventory: 'Photo archive preflight', review: 'Review exceptions', export: 'Export verified copies' };
const tabDescriptions = { inventory: 'Compare capture dates and sidecars. Your originals stay untouched.', review: 'Compare the evidence and choose what belongs in your new copy.', export: 'Review the fixed UTC offset and privacy policy before export.' };
const readTab = (): Tab => { const value = new URL(window.location.href).searchParams.get('view'); return value === 'review' || value === 'export' ? value : 'inventory'; };

export default function App() {
  const [locale, setLocale] = useState<Locale>(readLocale);
  const [preferenceSaved, setPreferenceSaved] = useState(true);
  const [inputs, setInputs] = useState<Input[]>([]);
  const [data, setData] = useState<Inventory | null>(null);
  const [decisions, setDecisions] = useState<Decisions>({});
  const [policy, setPolicy] = useState<Policy>({ offsetMinutes: 0, acknowledged: false });
  const [tab, setTab] = useState<Tab>(readTab);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<{ manifest: Manifest; url: string; locale: Locale } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const resultUrl = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const reviewTrigger = useRef<HTMLElement | null>(null);
  const demoAbort = useRef<AbortController | null>(null);
  const tr = (key: string, params?: Record<string, string | number>) => t(locale, key, params);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = `ArchiveGuard — ${t(locale, tabTitles[tab])}`;
  }, [locale, tab]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === 'archiveguard.locale') setLocale(readLocale()); };
    const back = () => { setTab(readTab()); setSelected(null); setFilter('all'); setQuery(''); mainRef.current?.focus(); };
    window.addEventListener('storage', sync);
    window.addEventListener('popstate', back);
    return () => { window.removeEventListener('storage', sync); window.removeEventListener('popstate', back); workerRef.current?.terminate(); demoAbort.current?.abort(); if (resultUrl.current) URL.revokeObjectURL(resultUrl.current); };
  }, []);
  function changeLocale(next: Locale) { setLocale(next); setPreferenceSaved(saveLocale(next)); }
  function clearResult() { if (resultUrl.current) URL.revokeObjectURL(resultUrl.current); resultUrl.current = null; setResult(null); }
  function run(payload: object, label: string) {
    mainRef.current?.focus();
    workerRef.current?.terminate(); workerRef.current = null; setError(''); setNotice(''); setTask({ done: 0, total: 1, label });
    if (typeof Worker === 'undefined' || !globalThis.crypto?.subtle) { setTask(null); setError('Use a current browser over HTTPS or the local loopback preview. Private processing needs Web Workers and Web Crypto.'); return; }
    let worker: Worker;
    try { worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }); }
    catch { setTask(null); setError('The local processor could not start. Check browser permissions or try a current browser.'); return; }
    workerRef.current = worker;
    worker.onmessage = event => {
      if (workerRef.current !== worker) return;
      const m = event.data;
      if (m.type === 'progress') { setTask({ label: m.label, done: m.done, total: m.total }); return; }
      setTask(null); worker.terminate(); workerRef.current = null;
      if (m.type === 'error') setError(m.message);
      if (m.type === 'inventory') {
        setData(m.inventory); setDecisions(initialDecisions(m.inventory)); setSelected(null); navigation('inventory'); setPolicy(p => ({ ...p, acknowledged: false }));
        setNotice('Preflight complete. Every selected input is accounted for.');
      }
      if (m.type === 'export') {
        clearResult();
        try {
          const url = URL.createObjectURL(new Blob([m.zip], { type: 'application/zip' })); resultUrl.current = url;
          setResult({ url, manifest: m.manifest, locale: m.locale }); setNotice(m.manifest.summary.repaired + m.manifest.summary.copied > 0 ? 'Verified copies are ready. Download the ZIP to save them.' : 'Your audit is ready.');
        } catch { setError('A ZIP could not be prepared in this browser. Try a smaller sample.'); }
      }
    };
    worker.onerror = () => { if (workerRef.current !== worker) return; worker.terminate(); workerRef.current = null; setTask(null); setError('The local processor could not run. Check the connection or choose a smaller sample. If this app was updated, refresh this page and import again. Originals stay untouched.'); };
    try { worker.postMessage(payload); }
    catch { worker.terminate(); workerRef.current = null; setTask(null); setError('The selected sample could not be passed to the local processor. Re-import a smaller sample.'); }
  }
  function scan(next: Input[]) {
    demoAbort.current?.abort(); demoAbort.current = null;
    clearResult(); setInputs(next); setData(null); setDecisions({}); setSelected(null); setQuery(''); setFilter('all'); navigation('inventory');
    if (next.length > LIMITS.files || next.reduce((sum, input) => sum + input.file.size, 0) > LIMITS.totalBytes) { workerRef.current?.terminate(); workerRef.current = null; setTask(null); setError('This sample exceeds 200 files or 64 MiB. Choose a smaller sample.'); mainRef.current?.focus(); return; }
    run({ operation: 'scan', inputs: next }, 'Reading selected files');
  }
  function importFiles(files: FileList | File[]) { scan(Array.from(files).map(file => ({ path: file.webkitRelativePath || file.name, file }))); }
  async function demo() {
    mainRef.current?.focus();
    workerRef.current?.terminate(); workerRef.current = null; demoAbort.current?.abort(); clearResult();
    const controller = new AbortController(); demoAbort.current = controller; setTask({ done: 0, total: 1, label: 'Preparing synthetic demo' }); setError('');
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}demo/demo.json`, { signal: controller.signal });
      if (!response.ok) throw new Error('Demo unavailable');
      const list: unknown = await response.json();
      if (!Array.isArray(list) || list.length > 200 || list.some(path => typeof path !== 'string' || !/^[a-z0-9.-]+$/i.test(path))) throw new Error('Demo list invalid');
      const next: Input[] = [];
      for (const path of list as string[]) {
        const asset = await fetch(`${import.meta.env.BASE_URL}demo/${path}`, { signal: controller.signal });
        if (!asset.ok) throw new Error('Demo asset unavailable');
        next.push({ path: `Sample archive/${path}`, file: await asset.blob() });
      }
      if (!controller.signal.aborted) scan(next);
    } catch { if (!controller.signal.aborted) { setTask(null); setError('Demo could not be loaded. Check the connection and try again.'); } }
    finally { if (demoAbort.current === controller) demoAbort.current = null; }
  }
  function cancel() { demoAbort.current?.abort(); demoAbort.current = null; workerRef.current?.terminate(); workerRef.current = null; setTask(null); setNotice('Cancelled. No output was saved.'); mainRef.current?.focus(); }
  function changeDecision(id: string, patch: Partial<Decisions[string]>) { clearResult(); setDecisions(d => ({ ...d, [id]: { ...d[id], ...patch } })); }
  function openReview(id: string, trigger: HTMLElement) { reviewTrigger.current = trigger; setSelected(id === selected ? null : id); }
  function closeReview() { setSelected(null); if (reviewTrigger.current?.isConnected) reviewTrigger.current.focus(); else if (searchRef.current) searchRef.current.focus(); else mainRef.current?.focus(); }
  function navigation(next: Tab) { const url = new URL(window.location.href); if (readTab() !== next) { url.searchParams.set('view', next); url.hash = ''; window.history.pushState(null, '', url); } setTab(next); setSelected(null); setFilter('all'); setQuery(''); mainRef.current?.focus(); }
  function reset() { cancel(); clearResult(); setData(null); setInputs([]); setDecisions({}); setSelected(null); setError(''); setNotice(''); setQuery(''); setFilter('all'); navigation('inventory'); setPolicy(p => ({ ...p, acknowledged: false })); requestAnimationFrame(() => chooseRef.current?.focus()); }
  const photos = data?.entries.filter(e => e.jpeg) || [];
  const reviews = photos.filter(isReview);
  const remaining = data ? unresolved(data, decisions) : 0;
  const chosen = data?.entries.find(e => e.id === selected);
  const visible = data?.entries.filter(e => (tab !== 'review' || isReview(e)) && (filter === 'all' || (filter === 'jpeg' ? e.kind === 'jpeg' : filter === 'attention' ? isReview(e) || ['invalid', 'unsupported', 'orphan'].includes(e.status) : e.kind === 'json')) && e.path.toLocaleLowerCase(locale).includes(query.toLocaleLowerCase(locale))) || [];
  const repairCount = photos.filter(e => decisions[e.id]?.action === 'repair').length;
  const keepCount = photos.filter(e => decisions[e.id]?.action === 'keep').length;

  return <div className="app-shell">
    <a className="skip-link" href="#main">{tr('Skip to content')}</a>
    <header className="app-header"><a className="brand" href="?view=inventory" aria-label={tr('ArchiveGuard home')} onClick={event => { event.preventDefault(); navigation('inventory'); }}><Archive size={24} aria-hidden="true" /><span>ArchiveGuard</span></a><Language locale={locale} onChange={changeLocale} /></header>
    <nav className="workflow" aria-label={tr('Archive workflow')}>{(['inventory', 'review', 'export'] as const).map((value, i) => <button data-testid={`nav-${value}`} aria-current={tab === value ? 'step' : undefined} className={tab === value ? 'current' : ''} onClick={() => navigation(value)} key={value}><span className="step-number">{i + 1}</span><span>{tr(({ inventory: 'Preflight', review: 'Review queue', export: 'Verified export' })[value])}</span>{value === 'review' && remaining > 0 && <span className="queue-count">{number(locale, remaining)}</span>}</button>)}</nav>
    <main id="main" ref={mainRef} tabIndex={-1}>
      <div className="page-title"><p className="eyebrow">{tr('JPEG + Google Photos JSON')}</p><h1>{tr(tabTitles[tab])}</h1><p>{tr(tabDescriptions[tab])}</p></div>
      {!preferenceSaved && <p className="storage-note" role="status">{tr('Language preference could not be saved; it still applies in this tab.')}</p>}
      {error && <div className="message error" role="alert" data-testid="error-alert"><CircleHelp size={20} aria-hidden="true" /><span>{message(locale, error)}</span><button className="icon-button" aria-label={tr('Dismiss error')} onClick={() => { setError(''); mainRef.current?.focus(); }}><X size={20} aria-hidden="true" /></button></div>}
      {notice && <div className="sr-only" role="status">{tr(notice)}</div>}
      {task && <div className="progress-card" role="status" data-testid="progress-panel"><div><span className="spinner" aria-hidden="true" /><b>{Object.hasOwn(catalog, task.label) ? tr(task.label) : task.label}</b><button data-testid="cancel-task" className="button" onClick={cancel}>{tr('Cancel')}</button></div><progress aria-label={tr('Local processing')} max={task.total || 1} value={task.done} /><small>{tr('{done} of {total} inputs · working locally', { done: number(locale, task.done), total: number(locale, task.total) })}</small></div>}
      {!data && !task && <>
        <section className="import-card" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); importFiles(e.dataTransfer.files); }}>
          <div><FolderOpen size={28} aria-hidden="true" /><h2>{tr('Select a small sample')}</h2><p>{tr('Choose JPEG photos and JSON sidecars from an unpacked Google Photos export.')}</p><div className="import-actions"><button ref={chooseRef} className="button primary" onClick={() => fileRef.current?.click()}><Plus size={18} aria-hidden="true" />{tr('Choose files')}</button><button className="button" onClick={() => folderRef.current?.click()}><FolderOpen size={18} aria-hidden="true" />{tr('Choose folder')}</button></div><p className="drop-hint">{tr('Or drop files here.')}</p></div>
          <div className="import-limits"><h3>{tr('Files remain on this device')}</h3><p>{tr('No uploads, account, analytics, or paid API.')}</p><p>{tr('200 inputs / 64 MiB total · 12 MiB per JPEG · 1 MiB per JSON')}</p><p>{tr('ZIP input, HEIC, RAW, and video are unsupported.')}</p><a href={`${import.meta.env.BASE_URL}privacy.html`} target="_blank" rel="noopener noreferrer"><span>{tr('Privacy, limits & support')}</span><ArrowRight size={16} aria-hidden="true" /></a></div>
        </section>
        <button data-testid="demo-start" className="demo-card" onClick={demo}><Images size={24} aria-hidden="true" /><span><b>{tr('Try a synthetic sample')}</b><small>{tr('Date conflicts, missing metadata, duplicates, and malformed JSON.')}</small></span><ArrowRight size={20} aria-hidden="true" /></button>
        {tab !== 'inventory' && <p className="empty-hint">{tr('Import a sample or open the demo to start this step.')}</p>}
      </>}
      {data && !task && <>
        <div className="session-bar"><div><b>{inputs[0]?.path.includes('/') ? inputs[0].path.split('/')[0] === 'Sample archive' ? tr('Sample archive') : inputs[0].path.split('/')[0] : tr('Selected files')}</b><span>{count(locale, data.entries.length, '{count} input', '{count} inputs (few)', '{count} inputs')} · {number(locale, data.inputBytes / (data.inputBytes < 1024 * 1024 ? 1024 : 1024 * 1024), { maximumFractionDigits: data.inputBytes < 1024 * 1024 ? 3 : 1 })} {data.inputBytes < 1024 * 1024 ? 'KiB' : 'MiB'}</span></div><button data-testid="new-sample" className="button" onClick={reset}><Plus size={18} aria-hidden="true" />{tr('New sample')}</button></div>
        <dl className="inventory-counts"><div><dt>{tr('JPEG photos')}</dt><dd>{number(locale, photos.length)}</dd></div><div><dt>{tr('Ready to restore')}</dt><dd>{number(locale, data.entries.filter(e => e.status === 'ready').length)}</dd></div><div className={remaining ? 'attention-count' : ''}><dt>{tr('Decisions needed')}</dt><dd>{number(locale, remaining)}</dd></div></dl>
        {tab !== 'export' ? <section className="inventory-panel">
          <div className="panel-heading"><div><h2 id="inventory-heading">{tr(tab === 'review' ? 'Your review queue' : 'Archive inventory')}</h2><p>{tr(tab === 'review' ? 'Choose an action for each exception. Unchanged copies are always an option.' : 'Every selected file, with its match and metadata status.')}</p></div><button className="button" onClick={() => navigation(tab === 'inventory' && remaining ? 'review' : 'export')}>{tr(tab === 'inventory' && remaining ? 'Review exceptions' : 'Continue to export')}<ArrowRight size={18} aria-hidden="true" /></button></div>
          <div className="table-tools"><div className="filters" role="group" aria-label={tr('Inventory filters')}>{[['all', 'All inputs'], ['jpeg', 'JPEGs'], ['json', 'Sidecars'], ['attention', 'Needs attention']].map(([value, label]) => <button key={value} data-testid={`filter-${value}`} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{tr(label)}</button>)}</div><label className="search"><Search size={18} aria-hidden="true" /><input data-testid="search-input" ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} placeholder={tr('Find a file')} aria-label={tr('Find a file')} />{query && <button className="icon-button" aria-label={tr('Clear search')} onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X size={18} aria-hidden="true" /></button>}</label></div>
          <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="inventory-heading" aria-describedby="table-hint"><table data-testid="inventory-table"><thead><tr>{['File', 'Capture metadata', 'Preflight status', 'Your action'].map(label => <th scope="col" key={label}>{tr(label)}</th>)}</tr></thead><tbody>{visible.map(entry => <tr data-testid={`file-row-${entry.id}`} key={entry.id} className={selected === entry.id ? 'chosen' : ''}>
            <td><button id={`file-${entry.id}`} data-testid={`review-file-${entry.id}`} aria-expanded={selected === entry.id} aria-controls={selected === entry.id ? `review-${entry.id}` : undefined} className="file-button" onClick={event => openReview(entry.id, event.currentTarget)}><span className={`file-icon ${entry.kind}`}>{entry.kind === 'json' ? <FileJson size={22} aria-hidden="true" /> : entry.kind === 'jpeg' ? <FileImage size={22} aria-hidden="true" /> : <File size={22} aria-hidden="true" />}</span><span><b>{entry.path.split('/').at(-1)}</b><small>{entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) === 'Sample archive' ? tr('Sample archive') : entry.path.slice(0, entry.path.lastIndexOf('/')) : tr('Selected input')} · {number(locale, entry.size / 1024, { maximumFractionDigits: 0 })} KiB</small></span></button></td>
            <td><span className="date-value">{entry.jpeg?.embedded.original || (entry.sidecar ? instant(locale, entry.sidecar.capture) : '—')}</span><small className="cell-sub">{entry.jpeg?.embedded.offset ? `UTC${entry.jpeg.embedded.offset}` : tr(entry.jpeg?.embedded.original ? 'Timezone unspecified' : entry.kind === 'json' ? 'Sidecar capture instant' : 'No readable capture date')}</small></td>
            <td><span className={`status ${entry.status}`}>{tr(STATUS_LABEL[entry.status])}</span></td><td>{entry.jpeg ? <button className="action-button" onClick={event => openReview(entry.id, event.currentTarget)}>{tr(({ pending: 'Review', repair: 'Use sidecar', keep: 'Keep unchanged', skip: 'Exclude' })[decisions[entry.id]?.action || 'pending'])}<ChevronRight size={18} aria-hidden="true" /></button> : <span className="cell-sub">{tr('Audit only')}</span>}</td>
          </tr>)}</tbody></table></div>
          {!visible.length && <div className="empty-state" data-testid="empty-state"><h3>{tr(tab === 'review' && !reviews.length ? 'No exceptions to review' : 'No matching files')}</h3><p>{tr('Change the filter or continue to your export policy.')}</p></div>}
          <div className="table-footer"><span>{tr('{shown} of {total} inputs shown · sidecars stay in the audit', { shown: number(locale, visible.length), total: number(locale, data.entries.length) })}</span><span id="table-hint">{tr('Scroll the file table horizontally to see every column.')}</span></div>
        </section> : <section className="export-panel">
          <div className="panel-heading"><div><h2>{tr('Review your export policy')}</h2><p>{tr('The policy applies to every copy that uses a sidecar capture time.')}</p></div></div>
          <div className="policy-grid"><div><label className="field-label" htmlFor="offset">{tr('UTC offset for repaired capture times')}</label><select id="offset" data-testid="offset-select" value={policy.offsetMinutes} onChange={e => { clearResult(); setPolicy({ offsetMinutes: Number(e.target.value), acknowledged: false }); }}>{offsetOptions.map(n => <option value={n} key={n}>UTC{offsetText(n)}</option>)}</select><p className="field-help">{tr('JSON supplies an instant. This fixed offset sets the wall-clock time written into EXIF. Use separate batches for different offsets or daylight-saving periods.')}</p><div className="policy-note"><h3>{tr('Only capture fields change')}</h3><p>{tr('Write DateTimeOriginal and OffsetTimeOriginal. Remove capture subseconds because JSON has whole seconds. Digitized dates, modification dates, XMP, and filesystem times are not reconciled.')}</p></div><div className="policy-note"><h3>{tr('GPS policy')}</h3><p>{tr('Sidecar GPS is never added. Existing embedded GPS remains in copies. Reports omit coordinates; exported photos can still contain location data.')}</p></div><label className="acknowledge"><input data-testid="policy-ack" type="checkbox" checked={policy.acknowledged} onChange={e => { clearResult(); setPolicy(p => ({ ...p, acknowledged: e.target.checked })); }} /><span>{tr('I reviewed the fixed UTC offset, capture-field scope, and GPS policy.')}</span></label></div>
          <div className="export-summary"><h3>{tr('Your verified copy package')}</h3><dl><div><dt>{tr('Repaired JPEG copies')}</dt><dd>{number(locale, repairCount)}</dd></div><div><dt>{tr('Unchanged JPEG copies')}</dt><dd>{number(locale, keepCount)}</dd></div><div><dt>{tr('JPEG decisions pending')}</dt><dd>{number(locale, remaining)}</dd></div></dl><p>{tr('Includes manifest.json, a CSV audit, and a readable HTML report. Every input has a recorded outcome.')}</p>{repairCount + keepCount === 0 && <p className="reports-only">{tr('No JPEG copies selected. This export contains reports only.')}</p>}{remaining > 0 && <button className="button" onClick={() => navigation('review')}>{tr('Finish review')}<ArrowRight size={18} aria-hidden="true" /></button>}<button data-testid="prepare-export" className="button primary export-button" disabled={remaining > 0 || !policy.acknowledged} onClick={() => { clearResult(); run({ operation: 'export', inputs, inventory: data, decisions, policy, locale }, 'Verifying JPEG copies'); }}><Check size={18} aria-hidden="true" />{tr('Verify & prepare ZIP')}</button><small>{tr('No file is saved until you download.')}</small></div></div>
          {result && <div className="download-card" role="status"><div><h3>{tr(result.manifest.summary.repaired + result.manifest.summary.copied > 0 ? 'Your verified copies are ready.' : 'Your audit is ready.')}</h3><p>{tr('{repaired} repaired · {copied} unchanged · {excluded} audit-only or excluded inputs', { repaired: number(locale, result.manifest.summary.repaired), copied: number(locale, result.manifest.summary.copied), excluded: number(locale, result.manifest.summary.excluded) })}</p><p>{tr('Report language')}: <span lang={result.locale}>{languageNames[result.locale]}</span></p><small>{tr('If the download is blocked, allow downloads for this site and try again. Keep the tab open until saving finishes.')}</small></div><a data-testid="download-zip" className="button primary" href={result.url} download="ArchiveGuard-verified-copies.zip"><ArrowDownToLine size={18} aria-hidden="true" />{tr('Download ZIP')}</a></div>}
        </section>}
        {chosen && <Review locale={locale} entry={chosen} data={data} decision={decisions[chosen.id]} offset={policy.offsetMinutes} onChange={patch => changeDecision(chosen.id, patch)} onClose={closeReview} />}
        <p className="scope-note">{tr('Google Takeout retains original embedded metadata and puts extra metadata in JSON. ArchiveGuard compares the sources; it never assumes every photo needs repair.')}</p>
        <p className="session-note">{tr('Reloading clears this session. Keep the tab open until you download your copies.')}</p>
      </>}
      <input data-testid="file-input" tabIndex={-1} className="sr-only" ref={fileRef} type="file" multiple aria-label={tr('Import JPEG and JSON files')} onChange={e => { if (e.target.files?.length) importFiles(e.target.files); e.target.value = ''; }} />
      <input data-testid="folder-input" tabIndex={-1} className="sr-only" ref={folderRef} type="file" multiple {...{ webkitdirectory: '', directory: '' }} aria-label={tr('Import unpacked folder')} onChange={e => { if (e.target.files?.length) importFiles(e.target.files); e.target.value = ''; }} />
    </main>
    <footer><span><LockKeyhole size={16} aria-hidden="true" />{tr('Local processing')}</span><a href={`${import.meta.env.BASE_URL}privacy.html`} target="_blank" rel="noopener noreferrer">{tr('Privacy, limits & support')}</a><span>{tr('Free browser utility')}</span></footer>
  </div>;
}

function Review({ locale, entry, data, decision, offset, onChange, onClose }: { locale: Locale; entry: Entry; data: Inventory; decision: Decisions[string]; offset: number; onChange: (patch: Partial<Decisions[string]>) => void; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => { panelRef.current?.focus({ preventScroll: true }); panelRef.current?.scrollIntoView({ block: 'nearest' }); }, [entry.id]);
  const tr = (key: string, params?: Record<string, string | number>) => t(locale, key, params);
  const sidecar = data.entries.find(e => e.id === decision?.sidecarId);
  const canRepair = !!entry.jpeg?.repairable && sidecar?.sidecar?.capture !== null && sidecar?.sidecar?.capture !== undefined;
  return <section data-testid="review-panel" id={`review-${entry.id}`} ref={panelRef} tabIndex={-1} className="review-detail" aria-label={tr('Review {path}', { path: entry.path })} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}>
    <div className="panel-heading"><div><p className="eyebrow">{tr('Source evidence')}</p><h2>{entry.path.split('/').at(-1)}</h2><p>{message(locale, entry.note)}</p></div><button data-testid="close-review" className="icon-button" aria-label={tr('Close file review')} onClick={onClose}><X size={20} aria-hidden="true" /></button></div>
    <div className="evidence-grid"><div className="evidence"><h3><FileImage size={18} aria-hidden="true" />{tr(entry.kind === 'json' ? 'Google Photos sidecar' : entry.kind === 'jpeg' ? 'Original JPEG' : 'Source evidence')}</h3><b>{entry.jpeg?.embedded.original || (entry.sidecar ? instant(locale, entry.sidecar.capture) : tr(entry.kind === 'other' ? 'Unsupported format' : 'No readable capture date'))}</b>{entry.sidecar && <><p>{tr('Creation/upload')}: {instant(locale, entry.sidecar.created)}</p><p>{tr('Sidecar GPS')}: {tr(entry.sidecar.hasGps ? 'Present — will not be added' : 'Not present')}</p></>}{entry.jpeg && <><dl>{[['Offset', entry.jpeg.embedded.offset], ['Digitized', entry.jpeg.embedded.digitized], ['Modified', entry.jpeg.embedded.modified], ['Capture subseconds', entry.jpeg.embedded.subsecond]].map(([label, value]) => <div key={label}><dt>{tr(label!)}</dt><dd>{value || tr(label === 'Offset' ? 'Unspecified' : 'Not supplied')}</dd></div>)}</dl><p>{tr('Embedded GPS')}: {tr(entry.jpeg.embedded.hasGps ? 'Present — preserved' : entry.jpeg.repairable ? 'Not present' : 'Not safely inspected')}</p><p>{tr('{width} × {height} pixels', { width: number(locale, entry.jpeg.width), height: number(locale, entry.jpeg.height) })}</p></>}</div>
      <div className="evidence"><h3><FileJson size={18} aria-hidden="true" />{tr(entry.jpeg ? 'Google Photos sidecar' : 'Source evidence')}</h3>{entry.candidates.length ? <><label className="field-label" htmlFor={`sidecar-${entry.id}`}>{tr('Choose the matching sidecar')}</label><select data-testid="sidecar-select" id={`sidecar-${entry.id}`} value={decision.sidecarId || ''} onChange={e => onChange({ sidecarId: e.target.value || null, action: 'pending' })}><option value="">{tr('Select a candidate')}</option>{entry.candidates.map(c => <option key={c.id} value={c.id}>{data.entries.find(e => e.id === c.id)!.path.split('/').at(-1)} · {tr(({ exact: 'Exact filename', title: 'JSON title match', possible: 'Possible truncated match' })[c.confidence])}</option>)}</select><b>{instant(locale, sidecar?.sidecar?.capture)}</b><p>{tr('Creation/upload')}: {instant(locale, sidecar?.sidecar?.created)}</p><p>{message(locale, entry.candidates.find(c => c.id === decision.sidecarId)?.reason || 'Confirm a candidate to see its evidence.')}</p><small>{tr('Creation time is never used as capture time.')}</small><p>{tr('Sidecar GPS')}: {tr(sidecar?.sidecar?.hasGps ? 'Present — will not be added' : 'Not present or not selected')}</p></> : <>{entry.jpeg && <b>{tr('No valid matching sidecar')}</b>}<p>{tr(entry.jpeg ? 'Keep a byte-identical JPEG copy or exclude this input. Unsupported files stay in the audit.' : 'This input stays in the audit. It cannot be exported as a JPEG copy.')}</p></>}</div></div>
    {entry.sourceHash && <details className="hash-details"><summary>{tr('View source SHA-256')}</summary><code>{entry.sourceHash}</code><p>{tr('The repaired copy gets its own output hash. This hash identifies the original bytes.')}</p></details>}
    {entry.jpeg && <><fieldset className="decision-options"><legend>{tr('Choose this photo’s outcome')}</legend>{([{ action: 'keep', label: 'Keep unchanged', description: tr('Make a byte-identical JPEG copy.'), disabled: false }, { action: 'repair', label: 'Use sidecar capture time', description: canRepair ? tr('Write {date} UTC{offset} using the export policy.', { date: captureText(sidecar!.sidecar!.capture!, offset), offset: offsetText(offset) }) : tr('A safe JPEG and a valid capture sidecar are required.'), disabled: !canRepair }, { action: 'skip', label: 'Exclude from copies', description: tr('Record the exclusion in the audit.'), disabled: false }] as const).map(option => <label key={option.action} className={`${decision.action === option.action ? 'selected ' : ''}${option.disabled ? 'disabled' : ''}`}><input data-testid={`decision-${option.action}`} type="radio" name={`decision-${entry.id}`} value={option.action} checked={decision.action === option.action} disabled={option.disabled} onChange={() => onChange({ action: option.action })} /><span><b>{tr(option.label)}</b><small>{option.description}</small></span></label>)}</fieldset><p className="detail-footnote">{tr('Your decision affects a new copy. The selected original is never changed.')}</p></>}
  </section>;
}

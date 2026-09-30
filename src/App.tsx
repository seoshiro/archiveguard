import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Check, CheckCheck, ChevronRight, CircleHelp, FileImage, FileJson, FolderOpen, HardDrive, Leaf, LockKeyhole, Plus, Search, ShieldCheck, Sparkles, X } from 'lucide-react';
import { initialDecisions, isReview, STATUS_LABEL, unresolved, type Decisions, type Entry, type Input, type Inventory, type Manifest, type Policy } from './engine';
import { captureText, offsetText } from './jpeg';

type Task = { label: string; done: number; total: number };
const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const epochText = (epoch: number | null | undefined) => epoch === null || epoch === undefined ? 'Not supplied' : new Date(epoch * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');

export default function App() {
  const [inputs, setInputs] = useState<Input[]>([]);
  const [data, setData] = useState<Inventory | null>(null);
  const [decisions, setDecisions] = useState<Decisions>({});
  const [policy, setPolicy] = useState<Policy>({ offsetMinutes: 0, acknowledged: false });
  const [tab, setTab] = useState<'inventory' | 'review' | 'export'>('inventory');
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<{ manifest: Manifest; url: string } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const resultUrl = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const demoAbort = useRef<AbortController | null>(null);

  useEffect(() => () => { workerRef.current?.terminate(); demoAbort.current?.abort(); if (resultUrl.current) URL.revokeObjectURL(resultUrl.current); }, []);
  function clearResult() {
    if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
    resultUrl.current = null; setResult(null);
  }
  function run(message: object, label: string) {
    workerRef.current?.terminate(); setError(''); setNotice(''); setTask({ done: 0, total: 1, label });
    if (typeof Worker === 'undefined' || !globalThis.crypto?.subtle) { setTask(null); setError('Use a current browser over HTTPS or the local loopback preview. Private processing needs Web Workers and Web Crypto.'); return; }
    let worker: Worker;
    try { worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }); }
    catch { setTask(null); setError('The local processor could not start. Check browser permissions or try a current browser.'); return; }
    workerRef.current = worker;
    worker.onmessage = event => {
      if (workerRef.current !== worker) return;
      const m = event.data;
      if (m.type === 'progress') setTask({ label: m.label, done: m.done, total: m.total });
      else {
        setTask(null); worker.terminate(); workerRef.current = null;
        if (m.type === 'error') setError(m.message);
        if (m.type === 'inventory') {
          setData(m.inventory); setDecisions(initialDecisions(m.inventory)); setSelected(null); setTab('inventory'); setPolicy(p => ({ ...p, acknowledged: false }));
          setNotice('Preflight complete. Every selected input is accounted for.');
        }
        if (m.type === 'export') {
          clearResult(); const url = URL.createObjectURL(new Blob([m.zip], { type: 'application/zip' })); resultUrl.current = url;
          setResult({ url, manifest: m.manifest }); setNotice('Verified copies are ready. Download the ZIP to save them.');
        }
      }
    };
    worker.onerror = () => { if (workerRef.current !== worker) return; worker.terminate(); workerRef.current = null; setTask(null); setError('The local worker stopped. Re-import a smaller sample and try again.'); };
    try { worker.postMessage(message); }
    catch { worker.terminate(); workerRef.current = null; setTask(null); setError('The selected sample could not be passed to the local processor. Re-import a smaller sample.'); }
  }
  function scan(next: Input[]) {
    demoAbort.current?.abort(); demoAbort.current = null;
    clearResult(); setInputs(next); setData(null); setDecisions({}); setSelected(null); setQuery(''); setFilter('all');
    run({ operation: 'scan', inputs: next }, 'Reading selected files');
  }
  function importFiles(files: FileList | File[]) {
    scan(Array.from(files).map(file => ({ path: file.webkitRelativePath || file.name, file })));
  }
  async function demo() {
    demoAbort.current?.abort();
    const controller = new AbortController(); demoAbort.current = controller; setTask({ done: 0, total: 1, label: 'Preparing synthetic demo' }); setError('');
    try {
      const list: string[] = await (await fetch(`${import.meta.env.BASE_URL}demo/demo.json`, { signal: controller.signal })).json();
      const next: Input[] = [];
      for (const path of list) {
        const response = await fetch(`${import.meta.env.BASE_URL}demo/${path}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Synthetic demo could not be loaded.');
        next.push({ path: `Sample archive/${path}`, file: await response.blob() });
      }
      if (!controller.signal.aborted) scan(next);
    } catch (e) { if (!controller.signal.aborted) { setTask(null); setError(e instanceof Error ? e.message : 'Demo could not be loaded.'); } }
    finally { if (demoAbort.current === controller) demoAbort.current = null; }
  }
  function cancel() { demoAbort.current?.abort(); workerRef.current?.terminate(); workerRef.current = null; setTask(null); setNotice('Cancelled. No output was saved.'); }
  function changeDecision(id: string, patch: Partial<Decisions[string]>) { clearResult(); setDecisions(d => ({ ...d, [id]: { ...d[id], ...patch } })); }
  function closeReview() { const id = selected; setSelected(null); if (id) document.getElementById(`file-${id}`)?.focus(); }
  const photos = data?.entries.filter(e => e.jpeg) || [];
  const reviews = photos.filter(isReview);
  const remaining = data ? unresolved(data, decisions) : 0;
  const chosen = data?.entries.find(e => e.id === selected);
  const visible = data?.entries.filter(e => (tab !== 'review' || isReview(e)) && (filter === 'all' || (filter === 'jpeg' ? e.kind === 'jpeg' : filter === 'attention' ? isReview(e) || ['invalid', 'unsupported', 'orphan'].includes(e.status) : e.kind === 'json')) && e.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) || [];
  const repairCount = photos.filter(e => decisions[e.id]?.action === 'repair').length;
  const keepCount = photos.filter(e => decisions[e.id]?.action === 'keep').length;
  const offsetOptions = [-720, -660, -600, -570, -540, -480, -420, -360, -300, -240, -210, -180, -120, -60, 0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525, 540, 570, 600, 630, 660, 720, 765, 780, 825, 840];
  function navigation(next: typeof tab) { setTab(next); setSelected(null); setFilter('all'); setQuery(''); mainRef.current?.focus(); }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#main" aria-label="ArchiveGuard home"><span className="brand-mark"><ShieldCheck size={23} /></span>Archive<span>Guard</span></a>
      <div className="workspace"><div className="workspace-icon"><FolderOpen size={19} /></div><div><b>Personal workspace</b><small>Local archive session</small></div><LockKeyhole size={13} /></div>
      <span className="nav-caption">YOUR ARCHIVE</span>
      <nav aria-label="Archive workflow">
        <button aria-current={tab === 'inventory' ? 'step' : undefined} className={tab === 'inventory' ? 'nav-item active' : 'nav-item'} onClick={() => navigation('inventory')}><FolderOpen size={18} />Preflight<span>{data?.entries.length || '—'}</span></button>
        <button aria-current={tab === 'review' ? 'step' : undefined} className={tab === 'review' ? 'nav-item active' : 'nav-item'} onClick={() => navigation('review')}><CheckCheck size={18} />Review queue<span className={remaining ? 'nav-count' : ''}>{remaining || '—'}</span></button>
        <button aria-current={tab === 'export' ? 'step' : undefined} className={tab === 'export' ? 'nav-item active' : 'nav-item'} onClick={() => navigation('export')}><ArrowDownToLine size={18} />Verified export{result && <Check size={14} />}</button>
      </nav>
      <div className="local-card"><span className="local-dot" /><b>Your files stay here.</b><p>Photos and metadata are processed in this browser. No account. No uploads.</p><div><HardDrive size={14} /> On-device processing</div></div>
      <div className="sidebar-bottom"><Leaf size={17} /><span>A little care.<br /><b>A lifetime of memories.</b></span></div>
      <span className="version">ARCHIVEGUARD · JPEG EDITION 1.0</span>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div><span>Workspace</span><ChevronRight size={14} /><b>{tab === 'inventory' ? 'Archive preflight' : tab === 'review' ? 'Review queue' : 'Verified export'}</b></div><span className="privacy-pill"><LockKeyhole size={13} /> Private by design</span></header>
      <main id="main" ref={mainRef} tabIndex={-1}>
        <div className="page-title"><div><div className="eyebrow">A CAREFUL MOVE, A CLEAR RECORD</div><h1>{tab === 'inventory' ? 'Your memories, accounted for.' : tab === 'review' ? 'Every exception deserves a look.' : 'A new copy. A complete record.'}</h1><p>{tab === 'inventory' ? 'Check a photo archive before its next chapter. Keep what’s right. Review what isn’t.' : tab === 'review' ? 'Compare the evidence, then decide what belongs in your new archive.' : 'Choose your capture-time policy and export copies you can verify.'}</p></div><span className="scope-badge"><FileImage size={15} /> JPEG + Google Photos JSON</span></div>
        <div className="steps" aria-label="Workflow progress">{['Import & inspect', 'Review exceptions', 'Export safe copies'].map((label, i) => <div key={label} className={(i === 0 && tab === 'inventory') || (i === 1 && tab === 'review') || (i === 2 && tab === 'export') ? 'step current' : 'step'}><span>{i === 0 && data ? <Check size={14} /> : i + 1}</span>{label}{i < 2 && <div className="step-line" />}</div>)}</div>
        {error && <div className="message error" role="alert"><CircleHelp size={18} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
        {notice && <div className="sr-only" role="status">{notice}</div>}
        {task && <div className="progress-card" role="status"><div><span className="spinner" /><b>{task.label}</b><button className="button subtle" onClick={cancel}>Cancel</button></div><progress max={task.total || 1} value={task.done} /><small>{task.done} / {task.total} inputs · working locally</small></div>}
        {!data && !task && <>
          <section className="import-card" onDragOver={e => { e.preventDefault(); }} onDrop={e => { e.preventDefault(); importFiles(e.dataTransfer.files); }}>
            <div className="import-copy"><div className="import-icon"><FolderOpen size={29} strokeWidth={1.5} /><span><Plus size={12} /></span></div><span className="eyebrow">START WITH A SMALL SAMPLE</span><h2>Bring your archive.<br />Leave the guesswork.</h2><p>Select JPEG photos and their JSON sidecars from an unpacked Google Photos export.</p><div className="import-actions"><button className="button primary" onClick={() => fileRef.current?.click()}><Plus size={17} />Choose files</button><button className="button" onClick={() => folderRef.current?.click()}><FolderOpen size={17} />Choose folder</button></div><small>Or drop files here · 200 files / 64 MiB per batch<br />12 MiB per JPEG · 1 MiB per JSON · no ZIP input</small></div>
            <div className="archive-illustration" aria-hidden="true"><div className="illus-grid" /><div className="photo-stack back" /><div className="photo-stack middle"><div className="landscape sunlit"><span /></div></div><div className="photo-stack front"><div className="landscape green"><span /></div><div className="photo-caption"><span>MEMORIES, PRESERVED</span><Check size={13} /></div></div><div className="verified-stamp"><ShieldCheck size={20} /><span>Originals<br /><b>always safe</b></span></div><span className="illustration-caption">A careful move starts with a clear picture.</span></div>
          </section>
          <button className="demo-card" onClick={demo}><span className="demo-icon"><Sparkles size={21} /></span><span><b>Take a look around first</b><small>Try a synthetic archive with date conflicts, duplicate photos, and missing metadata.</small></span><span className="demo-link">Open demo <ArrowRight size={16} /></span></button>
          <div className="trust-strip"><div><ShieldCheck size={22} /><b>Originals stay untouched</b><span>Every export creates new copies.</span></div><div><Search size={22} /><b>Evidence before action</b><span>Clear matches. Visible exceptions.</span></div><div><CheckCheck size={22} /><b>Verified, then packaged</b><span>Metadata, hashes, and an audit trail.</span></div></div>
        </>}
        {!data && !task && tab !== 'inventory' && <p className="empty-hint">Import a sample or open the demo to start this step.</p>}
        {data && !task && <>
          <div className="session-bar"><span><FolderOpen size={16} /><b>{inputs[0]?.path.split('/').length > 1 ? inputs[0].path.split('/')[0] : 'Selected files'}</b><small>{data.entries.length} inputs · {formatBytes(data.inputBytes)}</small></span><button className="button subtle" onClick={() => { clearResult(); setData(null); setInputs([]); setSelected(null); setTab('inventory'); }}><Plus size={15} />New sample</button></div>
          <div className="stats"><div><span>JPEG photos inspected</span><strong>{photos.length}<small> / {data.entries.filter(e => e.kind === 'jpeg').length} selected</small></strong><p>Readable JPEG structure</p></div><div><span>Ready to restore</span><strong>{data.entries.filter(e => e.status === 'ready').length}</strong><p>Exact, unambiguous sidecars</p></div><div className="attention-stat"><span>Decisions still needed</span><strong>{remaining}</strong><p>{reviews.length} photos require explicit review</p></div><div><span>Protected originals</span><strong>100<small>%</small></strong><p>No source writes, ever</p></div></div>
          {tab !== 'export' ? <section className="inventory-panel">
            <div className="panel-heading"><div><h2>{tab === 'review' ? 'Your review queue' : 'Archive inventory'}</h2><p>{tab === 'review' ? 'Choose an action for each exception. Unchanged copies are always an option.' : 'Every selected file, with its match and metadata status.'}</p></div><button className="button" onClick={() => navigation(tab === 'inventory' && remaining ? 'review' : 'export')}>{tab === 'inventory' && remaining ? 'Review exceptions' : 'Continue to export'}<ArrowRight size={15} /></button></div>
            <div className="table-tools"><div className="filters" role="group" aria-label="Inventory filters">{[['all', 'All inputs'], ['jpeg', 'JPEGs'], ['json', 'Sidecars'], ['attention', 'Needs attention']].map(([value, label]) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><label className="search"><Search size={15} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a file…" aria-label="Find a file" /></label></div>
            <div className="table-scroll"><table><thead><tr><th>FILE</th><th>CAPTURE METADATA</th><th>PREFLIGHT STATUS</th><th>YOUR ACTION</th></tr></thead><tbody>{visible.map(entry => <tr key={entry.id} className={selected === entry.id ? 'chosen' : ''}><td><button id={`file-${entry.id}`} aria-expanded={selected === entry.id} aria-controls={selected === entry.id ? `review-${entry.id}` : undefined} className="file-button" onClick={() => setSelected(selected === entry.id ? null : entry.id)}><span className={`file-icon ${entry.kind}`}>{entry.kind === 'json' ? <FileJson size={21} /> : <FileImage size={21} />}</span><span><b>{entry.path.split('/').at(-1)}</b><small>{entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : 'Selected input'} · {(entry.size / 1024).toFixed(0)} KiB</small></span></button></td><td><span className="date-value">{entry.jpeg?.embedded.original || (entry.sidecar ? epochText(entry.sidecar.capture) : '—')}</span><small className="cell-sub">{entry.jpeg?.embedded.offset ? `UTC${entry.jpeg.embedded.offset}` : entry.jpeg?.embedded.original ? 'Timezone unspecified' : entry.kind === 'json' ? 'Sidecar capture instant' : 'No readable capture date'}</small></td><td><span className={`status ${entry.status}`}><i />{STATUS_LABEL[entry.status]}</span></td><td>{entry.jpeg ? <button className={`action-button ${decisions[entry.id]?.action === 'pending' ? 'pending' : ''}`} onClick={() => setSelected(entry.id)}>{({ pending: 'Review', repair: 'Use sidecar', keep: 'Keep unchanged', skip: 'Exclude' })[decisions[entry.id]?.action || 'pending']}<ChevronRight size={14} /></button> : <span className="cell-sub">Audit only</span>}</td></tr>)}</tbody></table></div>
            {!visible.length && <div className="empty-state"><CheckCheck size={27} /><h3>{tab === 'review' && !reviews.length ? 'No exceptions to review' : 'No matching files'}</h3><p>Change the filter or continue to your export policy.</p></div>}
            <div className="table-footer"><span>{visible.length} of {data.entries.length} inputs shown · sidecars stay in the audit</span><span><LockKeyhole size={12} />Session stays in memory</span></div>
          </section> : <section className="export-panel"><div className="panel-heading"><div><h2>Review your export policy</h2><p>The policy applies to every copy that uses a sidecar capture time.</p></div><ShieldCheck size={28} /></div><div className="policy-grid"><div><label className="field-label" htmlFor="offset">UTC offset for repaired capture times</label><select id="offset" value={policy.offsetMinutes} onChange={e => { clearResult(); setPolicy({ offsetMinutes: Number(e.target.value), acknowledged: false }); }}>{offsetOptions.map(n => <option value={n} key={n}>UTC{offsetText(n)}{n === 0 ? ' · UTC' : ''}</option>)}</select><p className="field-help">JSON supplies an instant. This fixed offset sets the wall-clock time written into EXIF. Choose a separate batch for photos taken in another offset or daylight-saving period.</p><div className="policy-note"><b>Only capture fields change</b><p>Write DateTimeOriginal and OffsetTimeOriginal. Remove capture subseconds because JSON has whole seconds. Digitized dates, modification dates, XMP, and file-system times are not reconciled.</p></div><div className="policy-note"><b>GPS stays under your control</b><p>Sidecar GPS is never added. Existing embedded GPS remains in copies. Coordinates are omitted from reports; exported photos can still contain location data.</p></div><label className="acknowledge"><input type="checkbox" checked={policy.acknowledged} onChange={e => { clearResult(); setPolicy(p => ({ ...p, acknowledged: e.target.checked })); }} /><span>I reviewed the fixed UTC offset, capture-field scope, and GPS policy.</span></label></div><div className="export-summary"><div className="export-summary-icon"><ArrowDownToLine size={27} /></div><h3>Your verified copy package</h3><dl><div><dt>Repaired JPEG copies</dt><dd>{repairCount}</dd></div><div><dt>Unchanged JPEG copies</dt><dd>{keepCount}</dd></div><div><dt>JPEG decisions pending</dt><dd>{remaining}</dd></div></dl><p>Includes <b>manifest.json</b>, a CSV audit, and a readable HTML report. Every input has a recorded outcome.</p>{remaining > 0 && <button className="button" onClick={() => navigation('review')}>Finish {remaining} review {remaining === 1 ? 'item' : 'items'}<ArrowRight size={15} /></button>}<button className="button primary export-button" disabled={remaining > 0 || !policy.acknowledged} onClick={() => run({ operation: 'export', inputs, inventory: data, decisions, policy }, 'Verifying JPEG copies')}><ShieldCheck size={17} />Verify & prepare ZIP</button><small>No file is saved until you download.</small></div></div>{result && <div className="download-card" role="status"><CheckCheck size={27} /><div><h3>Your verified copies are ready.</h3><p>{result.manifest.summary.repaired} repaired · {result.manifest.summary.copied} unchanged · {result.manifest.summary.excluded} audit-only or excluded inputs</p></div><a className="button primary" href={result.url} download="ArchiveGuard-verified-copies.zip"><ArrowDownToLine size={17} />Download ZIP</a></div>}</section>}
          {chosen && <Review entry={chosen} data={data} decision={decisions[chosen.id]} offset={policy.offsetMinutes} onChange={patch => changeDecision(chosen.id, patch)} onClose={closeReview} />}
          <div className="scope-note"><CircleHelp size={16} /><p>Google Takeout retains original embedded metadata and puts additional metadata in JSON. ArchiveGuard compares the sources; it never assumes all photos need repair. This JPEG MVP does not reconcile XMP, RAW, HEIC, or video.</p></div>
        </>}
        <input className="sr-only" ref={fileRef} type="file" multiple aria-label="Import JPEG and JSON files" onChange={e => { if (e.target.files?.length) importFiles(e.target.files); e.target.value = ''; }} />
        <input className="sr-only" ref={folderRef} type="file" multiple {...{ webkitdirectory: '', directory: '' }} aria-label="Import unpacked folder" onChange={e => { if (e.target.files?.length) importFiles(e.target.files); e.target.value = ''; }} />
      </main>
      <footer><span><ShieldCheck size={13} /> Care for the archive. Keep the original.</span><a href={`${import.meta.env.BASE_URL}privacy.html`} target="_blank" rel="noopener noreferrer">Privacy, limits & support</a><span>Free · On-device processing</span></footer>
    </div>
  </div>;
}

function Review({ entry, data, decision, offset, onChange, onClose }: { entry: Entry; data: Inventory; decision: Decisions[string]; offset: number; onChange: (patch: Partial<Decisions[string]>) => void; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => { panelRef.current?.focus({ preventScroll: true }); panelRef.current?.scrollIntoView({ block: 'nearest' }); }, [entry.id]);
  const sidecar = data.entries.find(e => e.id === decision?.sidecarId);
  const canRepair = !!entry.jpeg?.repairable && sidecar?.sidecar?.capture !== null && sidecar?.sidecar?.capture !== undefined;
  return <section id={`review-${entry.id}`} ref={panelRef} tabIndex={-1} className="review-detail" aria-label={`Review ${entry.path}`}>
    <div className="panel-heading"><div><div className="eyebrow">SOURCE EVIDENCE</div><h2>{entry.path.split('/').at(-1)}</h2><p>{entry.note}</p></div><button className="icon-button" aria-label="Close file review" onClick={onClose}><X size={19} /></button></div>
    <div className="evidence-grid"><div className="evidence"><span className="evidence-label"><FileImage size={15} />ORIGINAL JPEG</span><b>{entry.jpeg?.embedded.original || 'No readable capture date'}</b><p>Offset: {entry.jpeg?.embedded.offset || 'unspecified'}<br />Digitized: {entry.jpeg?.embedded.digitized || 'not supplied'}<br />Modified: {entry.jpeg?.embedded.modified || 'not supplied'}<br />Capture subseconds: {entry.jpeg?.embedded.subsecond || 'not supplied'}</p><small>Embedded GPS: {entry.jpeg?.embedded.hasGps ? 'present — preserved' : entry.jpeg?.repairable ? 'not present' : 'not safely inspected'}<br />{entry.jpeg ? `${entry.jpeg.width} × ${entry.jpeg.height} pixels` : 'No supported JPEG structure'}</small></div><div className="evidence"><span className="evidence-label"><FileJson size={15} />GOOGLE PHOTOS SIDECAR</span>{entry.candidates.length ? <><label className="field-label" htmlFor={`sidecar-${entry.id}`}>Choose the matching sidecar</label><select id={`sidecar-${entry.id}`} value={decision.sidecarId || ''} onChange={e => onChange({ sidecarId: e.target.value || null, action: 'pending' })}><option value="">Select a candidate…</option>{entry.candidates.map(c => <option key={c.id} value={c.id}>{data.entries.find(e => e.id === c.id)!.path.split('/').at(-1)} · {c.confidence}</option>)}</select><b>{epochText(sidecar?.sidecar?.capture)}</b><p>Creation/upload: {epochText(sidecar?.sidecar?.created)}<br />{entry.candidates.find(c => c.id === decision.sidecarId)?.reason || 'Confirm a candidate to see its evidence.'}</p><small>Creation time is never used as capture time.<br />Sidecar GPS: {sidecar?.sidecar?.hasGps ? 'present — will not be added' : 'not present or not selected'}</small></> : <><b>No valid matching sidecar</b><p>Keep a byte-identical JPEG copy or exclude this input. Unsupported files stay in the audit.</p></>}</div></div>
    {entry.sourceHash && <details className="hash-details"><summary>View source SHA-256</summary><code>{entry.sourceHash}</code><p>The repaired copy gets its own output hash. This hash identifies the original bytes.</p></details>}
    {entry.jpeg && <><fieldset className="decision-options"><legend>Choose this photo’s outcome</legend>{([{ action: 'keep', label: 'Keep unchanged', description: 'Make a byte-identical JPEG copy.', disabled: false }, { action: 'repair', label: 'Use sidecar capture time', description: canRepair ? `Write ${captureText(sidecar!.sidecar!.capture!, offset)} UTC${offsetText(offset)} using the export policy.` : 'A safe JPEG and a valid capture sidecar are required.', disabled: !canRepair }, { action: 'skip', label: 'Exclude from copies', description: 'Record the exclusion in the audit.', disabled: false }] as const).map(option => <label key={option.action} className={`${decision.action === option.action ? 'selected ' : ''}${option.disabled ? 'disabled' : ''}`}><input type="radio" name={`decision-${entry.id}`} value={option.action} checked={decision.action === option.action} disabled={option.disabled} onChange={() => onChange({ action: option.action })} /><span><b>{option.label}</b><small>{option.description}</small></span></label>)}</fieldset><p className="detail-footnote"><ShieldCheck size={14} />Your decision affects a new copy. The selected original is never changed.</p></>}
  </section>;
}

import { strToU8, zipSync } from 'fflate';
import { exifInstant, inspectJpeg, repairJpeg, sha256, validExifDate, validOffset, type JpegInfo } from './jpeg';
import { reports } from './reports';
import { t, type Locale } from './i18n';

export const LIMITS = { files: 200, totalBytes: 64 * 1024 * 1024, jpegBytes: 12 * 1024 * 1024, jsonBytes: 1024 * 1024 };
export type Input = { path: string; file: Blob };
export type Status = 'ready' | 'preserved' | 'conflict' | 'timezone' | 'ambiguous' | 'duplicate' | 'missing' | 'invalid' | 'unsupported' | 'sidecar' | 'orphan';
export type Sidecar = { title: string | null; capture: number | null; created: number | null; hasGps: boolean };
export type Candidate = { id: string; confidence: 'exact' | 'title' | 'possible'; reason: string };
export type Entry = { id: string; path: string; kind: 'jpeg' | 'json' | 'other'; size: number; status: Status; note: string; sourceHash: string | null; jpeg: JpegInfo | null; sidecar: Sidecar | null; candidates: Candidate[]; duplicateOf: string | null };
export type Inventory = { entries: Entry[]; inputBytes: number };
export type Decision = { action: 'pending' | 'keep' | 'repair' | 'skip'; sidecarId: string | null };
export type Decisions = Record<string, Decision>;
export type Policy = { offsetMinutes: number; acknowledged: boolean };
export type Progress = (done: number, total: number, label: string) => void;
export type ManifestRow = { id: string; sourcePath: string; status: Status; outcome: 'repaired' | 'copied' | 'excluded'; reason: string; sourceSha256: string | null; outputPath: string | null; outputSha256: string | null; payloadSha256: string | null; payloadPreserved: boolean | null; metadataVerified: boolean | null; embeddedBefore: JpegInfo['embedded'] | null; captureAfter: string | null; offsetAfter: string | null; sidecarPath: string | null; sidecarSha256: string | null; sidecarCaptureEpoch: number | null; matchConfidence: string | null };
export type Manifest = { schemaVersion: 1; product: 'ArchiveGuard'; createdAt: string; policy: { offsetMinutes: number; gps: string; writeScope: string }; summary: { repaired: number; copied: number; excluded: number }; limitations: string[]; entries: ManifestRow[] };
export const STATUS_LABEL: Record<Status, string> = { ready: 'Ready to restore', preserved: 'Capture date intact', conflict: 'Date conflict', timezone: 'Timezone needed', ambiguous: 'Match needs review', duplicate: 'Duplicate content', missing: 'No sidecar', invalid: 'Cannot process', unsupported: 'Unsupported format', sidecar: 'Matched sidecar', orphan: 'Unmatched sidecar' };
export function safePath(path: string): boolean {
  if (!path || path.length > 500 || path.includes('\\') || path.startsWith('/') || /[<>:"|?*]/.test(path) || Array.from(path).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return false;
  return path.split('/').every(part => part.length > 0 && new TextEncoder().encode(part).length <= 255 && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function kind(path: string): Entry['kind'] { return /\.jpe?g$/i.test(path) ? 'jpeg' : /\.json$/i.test(path) ? 'json' : 'other'; }
const dirname = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
function checkJson(value: unknown, depth = 0, count = { n: 0 }): void {
  if (depth > 16 || ++count.n > 20000) throw new Error('JSON nesting or value count exceeds the safe limit.');
  if (typeof value === 'string' && value.length > 16000) throw new Error('JSON string exceeds the safe limit.');
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new Error('Reserved object key in sidecar.');
      checkJson(v, depth + 1, count);
    }
  }
}
function timestamp(value: unknown): number | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || !('timestamp' in value)) throw new Error('Sidecar date must contain a Unix timestamp.');
  const raw = (value as { timestamp: unknown }).timestamp;
  if (!((typeof raw === 'string' && /^-?\d{1,11}$/.test(raw)) || (typeof raw === 'number' && Number.isSafeInteger(raw)))) throw new Error('Invalid Unix timestamp in sidecar.');
  const n = Number(raw);
  if (n < -2208988800 || n > 4102444799) throw new Error('Sidecar date is outside 1900–2099.');
  return n;
}
export function parseSidecar(raw: string): Sidecar {
  let obj: unknown;
  try { obj = JSON.parse(raw); }
  catch { throw new Error('Malformed JSON or invalid UTF-8 sidecar.'); }
  // JSON.parse keeps the last duplicate object key. Reject hidden competing
  // metadata sources before interpreting the parsed object.
  const scopes: { object: boolean; keyNext: boolean; keys: Set<string> }[] = [];
  for (const token of raw.match(/"(?:\\[\s\S]|[^"\\])*"|[{}[\]:,]/g) || []) {
    if (token === '{' || token === '[') {
      if (scopes.length >= 17) throw new Error('JSON nesting exceeds the safe limit.');
      scopes.push({ object: token === '{', keyNext: token === '{', keys: new Set() });
    } else if (token === '}' || token === ']') scopes.pop();
    else if (token === ',') { if (scopes.at(-1)?.object) scopes.at(-1)!.keyNext = true; }
    else if (token.startsWith('"') && scopes.at(-1)?.object && scopes.at(-1)!.keyNext) {
      const scope = scopes.at(-1)!, key: string = JSON.parse(token);
      if (scope.keys.has(key)) throw new Error('Duplicate JSON object key: sidecar requires review outside ArchiveGuard.');
      scope.keys.add(key); scope.keyNext = false;
    }
  }
  checkJson(obj);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Sidecar must be a JSON object.');
  const data = obj as Record<string, unknown>;
  let title: string | null = null;
  if (data.title !== undefined) {
    if (typeof data.title !== 'string' || !safePath(data.title) || data.title.includes('/')) throw new Error('Sidecar title must be a safe filename.');
    title = data.title;
  }
  const capture = timestamp(data.photoTakenTime), created = timestamp(data.creationTime);
  if (capture === null && created === null && title === null) throw new Error('Not a recognized Google Photos sidecar.');
  const hasGps = ['geoData', 'geoDataExif'].some(key => {
    const geo = data[key] as Record<string, unknown> | undefined;
    return geo && typeof geo.latitude === 'number' && typeof geo.longitude === 'number' && (geo.latitude !== 0 || geo.longitude !== 0);
  });
  return { title, capture, created, hasGps };
}
export function matchCandidates(photo: Entry, sidecars: Entry[]): Candidate[] {
  const name = basename(photo.path);
  return sidecars.filter(s => dirname(s.path) === dirname(photo.path) && s.sidecar).flatMap<Candidate>(s => {
    const stem = basename(s.path).replace(/(?:\.supplemental-metadata)?\.json$/i, '');
    if (stem === name) return [{ id: s.id, confidence: 'exact' as const, reason: s.sidecar!.title && s.sidecar!.title !== name ? 'Exact filename; JSON title disagrees' : 'Exact sidecar filename in the same folder' }];
    if (s.sidecar!.title === name) return [{ id: s.id, confidence: 'title' as const, reason: 'Exact JSON title in the same folder; filename differs' }];
    if (stem.length >= 12 && name.startsWith(stem)) return [{ id: s.id, confidence: 'possible' as const, reason: 'Possible truncated filename; confirmation required' }];
    return [];
  });
}
export async function inventory(inputs: Input[], progress: Progress = () => {}): Promise<Inventory> {
  const inputBytes = inputs.reduce((n, f) => n + f.file.size, 0);
  if (!inputs.length) throw new Error('Choose JPEG files and JSON sidecars first.');
  if (inputs.length > LIMITS.files || inputBytes > LIMITS.totalBytes) throw new Error('This sample exceeds 200 files or 64 MiB. Choose a smaller sample.');
  const entries: Entry[] = [];
  const pathCounts = new Map<string, number>();
  for (const f of inputs) { const path = f.path.normalize('NFC').toLocaleLowerCase('en-US'); pathCounts.set(path, (pathCounts.get(path) || 0) + 1); }
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i], fileKind = kind(input.path);
    const entry: Entry = { id: `f${String(i + 1).padStart(4, '0')}`, path: input.path, kind: fileKind, size: input.file.size, status: 'unsupported', note: 'Only JPEG images and Google Photos JSON sidecars are supported. Unpack ZIP archives before selecting a sample.', sourceHash: null, jpeg: null, sidecar: null, candidates: [], duplicateOf: null };
    entries.push(entry); progress(i, inputs.length, input.path);
    try {
      if (!safePath(input.path)) throw new Error('Unsafe or non-portable path. Rename this selected file before importing.');
      if ((pathCounts.get(input.path.normalize('NFC').toLocaleLowerCase('en-US')) || 0) > 1) throw new Error('Filename collision (including case or Unicode variants). Import separately or rename first.');
      if (fileKind === 'other') continue;
      if (input.file.size > (fileKind === 'jpeg' ? LIMITS.jpegBytes : LIMITS.jsonBytes)) throw new Error(fileKind === 'jpeg' ? 'JPEG exceeds the 12 MiB per-file limit.' : 'JSON exceeds the 1 MiB per-file limit.');
      const bytes = new Uint8Array(await input.file.arrayBuffer());
      entry.sourceHash = await sha256(bytes);
      if (fileKind === 'json') {
        let raw: string;
        try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new Error('Malformed JSON or invalid UTF-8 sidecar.'); }
        entry.sidecar = parseSidecar(raw); entry.status = 'orphan'; entry.note = 'No selected JPEG matches this sidecar.';
      } else {
        entry.jpeg = await inspectJpeg(bytes); entry.status = entry.jpeg.repairable ? 'missing' : 'invalid'; entry.note = entry.jpeg.warning || 'No matching valid sidecar. Keep an unchanged copy or exclude this file.';
      }
    } catch (e) { entry.status = 'invalid'; entry.note = e instanceof Error ? e.message : 'Could not read this selected file.'; }
  }
  const sidecars = entries.filter(e => e.sidecar), photos = entries.filter(e => e.jpeg);
  const claims = new Map<string, string[]>();
  for (const photo of photos) {
    photo.candidates = matchCandidates(photo, sidecars);
    for (const candidate of photo.candidates) claims.set(candidate.id, [...(claims.get(candidate.id) || []), photo.id]);
  }
  for (const sidecar of sidecars) if (claims.has(sidecar.id)) { sidecar.status = 'sidecar'; sidecar.note = 'Linked to a selected JPEG. Included in the audit manifest; sidecar contents are not bundled.'; }
  for (const photo of photos) {
    if (!photo.jpeg!.repairable) continue;
    const candidates = photo.candidates;
    if (!candidates.length) continue;
    const first = entries.find(e => e.id === candidates[0].id)!;
    if (candidates.length !== 1 || candidates[0].confidence !== 'exact' || candidates[0].reason.includes('disagrees') || claims.get(first.id)!.length > 1) { photo.status = 'ambiguous'; photo.note = 'Confirm the sidecar manually. ArchiveGuard will not guess between filename, title or shared matches.'; continue; }
    const embedded = photo.jpeg!.embedded, capture = first.sidecar!.capture;
    if (capture === null) { photo.status = 'conflict'; photo.note = 'JSON has no photoTakenTime. Upload/creation time is never used as capture time.'; }
    else if (!embedded.original && embedded.digitized) { photo.status = 'conflict'; photo.note = 'Digitized time exists without an original capture date. Review this additional date source before adding capture EXIF.'; }
    else if (!embedded.original) { photo.status = 'ready'; photo.note = 'Exact sidecar match with capture time. Capture EXIF can be added to a verified copy.'; }
    else if (!embedded.offset || !validOffset(embedded.offset)) { photo.status = 'timezone'; photo.note = 'Embedded capture time has no UTC offset. Choose the original date or the sidecar instant explicitly.'; }
    else if (exifInstant(embedded.original, embedded.offset) !== capture || (embedded.digitized && embedded.digitized !== embedded.original)) { photo.status = 'conflict'; photo.note = 'Capture sources disagree. Review their provenance and choose which to preserve.'; }
    else { photo.status = 'preserved'; photo.note = 'Embedded capture time and sidecar represent the same second. A byte-identical copy is proposed.'; }
  }
  const hashes = new Map<string, Entry>();
  for (const photo of photos) {
    const first = hashes.get(photo.sourceHash!);
    if (first) {
      photo.duplicateOf = first.id; first.duplicateOf ||= photo.id;
      for (const e of [first, photo]) if (e.jpeg?.repairable) { e.status = 'duplicate'; e.note = 'Byte-identical selected JPEGs. Each copy stays separate; choose its action explicitly. No deduplication or deletion.'; }
    } else hashes.set(photo.sourceHash!, photo);
  }
  progress(inputs.length, inputs.length, 'Inventory complete'); return { entries, inputBytes };
}
export function initialDecisions(data: Inventory): Decisions {
  return Object.fromEntries(data.entries.map(e => [e.id, { action: e.status === 'ready' ? 'repair' : e.status === 'preserved' ? 'keep' : e.kind !== 'jpeg' || !e.jpeg ? 'skip' : 'pending', sidecarId: e.candidates.length === 1 ? e.candidates[0].id : null }]));
}
export function unresolved(data: Inventory, decisions: Decisions): number { return data.entries.filter(e => e.jpeg && (!decisions[e.id] || decisions[e.id].action === 'pending')).length; }
export async function exportArchive(inputs: Input[], data: Inventory, decisions: Decisions, policy: Policy, progress: Progress = () => {}, locale: Locale = 'en'): Promise<{ zip: Uint8Array; manifest: Manifest }> {
  if (!policy.acknowledged) throw new Error('Review and acknowledge the capture-time and GPS policy first.');
  if (!Number.isInteger(policy.offsetMinutes) || Math.abs(policy.offsetMinutes) > 840) throw new Error('Invalid UTC offset.');
  if (unresolved(data, decisions)) throw new Error('Resolve every JPEG review item before exporting.');
  if (data.entries.length !== inputs.length || inputs.length > LIMITS.files || inputs.reduce((n, input) => n + input.file.size, 0) > LIMITS.totalBytes) throw new Error('Input set does not match the bounded inventory.');
  const files: Record<string, Uint8Array> = Object.create(null), rows: ManifestRow[] = [];
  let exported = 0;
  for (let i = 0; i < data.entries.length; i++) {
    const entry = data.entries[i], choice = decisions[entry.id] || { action: 'skip', sidecarId: null };
    progress(i, data.entries.length, entry.path);
    const row: ManifestRow = { id: entry.id, sourcePath: entry.path, status: entry.status, outcome: 'excluded', reason: entry.note, sourceSha256: entry.sourceHash, outputPath: null, outputSha256: null, payloadSha256: entry.jpeg?.payloadHash || null, payloadPreserved: null, metadataVerified: null, embeddedBefore: entry.jpeg?.embedded || null, captureAfter: null, offsetAfter: null, sidecarPath: null, sidecarSha256: null, sidecarCaptureEpoch: null, matchConfidence: null };
    rows.push(row);
    if (choice.action === 'skip') { if (entry.kind === 'jpeg') row.reason = 'Explicitly excluded in review. ' + entry.note; continue; }
    if (!entry.jpeg || entry.kind !== 'jpeg' || !safePath(entry.path) || inputs[i].path !== entry.path) throw new Error('Only inventoried valid JPEGs may be exported.');
    if (inputs[i].file.size > LIMITS.jpegBytes) throw new Error('Input size changed. Import again.');
    const source = new Uint8Array(await inputs[i].file.arrayBuffer());
    if (await sha256(source) !== entry.sourceHash) throw new Error(`Selected input changed: ${entry.path}. Import it again.`);
    let output: Uint8Array = source;
    if (choice.action === 'repair') {
      const candidate = entry.candidates.find(c => c.id === choice.sidecarId), sidecarIndex = data.entries.findIndex(e => e.id === choice.sidecarId), sidecar = data.entries[sidecarIndex];
      if (!candidate || !sidecar?.sidecar || sidecar.sidecar.capture === null || !entry.jpeg.repairable) throw new Error(`Choose a valid capture sidecar for ${entry.path}.`);
      if (inputs[sidecarIndex].path !== sidecar.path || inputs[sidecarIndex].file.size > LIMITS.jsonBytes || await sha256(new Uint8Array(await inputs[sidecarIndex].file.arrayBuffer())) !== sidecar.sourceHash) throw new Error('Sidecar changed after review. Import it again.');
      const fixed = await repairJpeg(source, sidecar.sidecar.capture, policy.offsetMinutes);
      output = fixed.bytes; row.outcome = 'repaired'; row.captureAfter = fixed.writtenDate; row.offsetAfter = fixed.writtenOffset; row.metadataVerified = true;
      row.sidecarPath = sidecar.path; row.sidecarSha256 = sidecar.sourceHash; row.sidecarCaptureEpoch = sidecar.sidecar.capture; row.matchConfidence = candidate.confidence;
      row.reason = `Reviewed sidecar capture instant; UTC offset ${policy.offsetMinutes} minutes. Only DateTimeOriginal and OffsetTimeOriginal written; SubSecTimeOriginal removed.`;
    } else if (choice.action === 'keep') {
      row.outcome = 'copied'; row.captureAfter = entry.jpeg.embedded.original; row.offsetAfter = entry.jpeg.embedded.offset; row.metadataVerified = null; row.reason = 'Explicitly retained as a byte-identical JPEG copy; metadata unchanged.';
    } else throw new Error('Unresolved or invalid repair action.');
    if ((await inspectJpeg(output)).payloadHash !== entry.jpeg.payloadHash) throw new Error('JPEG preservation check failed. No download was created.');
    row.payloadPreserved = true; row.outputSha256 = await sha256(output);
    if (choice.action === 'keep' && row.outputSha256 !== row.sourceSha256) throw new Error('Unchanged-copy checksum verification failed.');
    row.outputPath = `photos/${entry.id}/${basename(entry.path)}`;
    files[row.outputPath] = output; exported++;
  }
  const manifest: Manifest = { schemaVersion: 1, product: 'ArchiveGuard', createdAt: new Date().toISOString(), policy: { offsetMinutes: policy.offsetMinutes, gps: 'Sidecar GPS is not added; existing embedded GPS is preserved. Reports omit coordinates.', writeScope: 'DateTimeOriginal + OffsetTimeOriginal; remove SubSecTimeOriginal on repaired copies; all other readable EXIF retained and verified.' }, summary: { repaired: rows.filter(r => r.outcome === 'repaired').length, copied: rows.filter(r => r.outcome === 'copied').length, excluded: rows.filter(r => r.outcome === 'excluded').length }, limitations: ['JPEG only; 200 files / 64 MiB per batch, 12 MiB per JPEG, 1 MiB per JSON.', 'No ZIP input, video, HEIC, RAW, or XMP capture-date reconciliation.', 'No automatic camera timezone inference or capture-time fallback from upload time.', 'JPEG bytes outside EXIF are hashed and preserved; unrelated readable EXIF values are compared.', 'JPEG frame/scan structure is checked; preservation hashes do not prove complete image decodability.', 'MakerNotes, unknown EXIF tags and unsupported TIFF structures allow unchanged copies only where a supported JPEG structure is readable.', 'Reports include filenames, dates and hashes; handle them as private archive data.'], entries: rows };
  const report = reports(manifest, locale);
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2)); files['audit.csv'] = strToU8(report.csv); files['audit.html'] = strToU8(report.html);
  files['README.txt'] = strToU8([t(locale, 'ArchiveGuard verified copy export'), t(locale, '{count} JPEG copies. Original files were never written or deleted.', { count: exported }), t(locale, 'Review audit.html and manifest.json for exclusions and provenance.'), t(locale, 'Repaired file hashes normally differ from source hashes. payloadSha256 covers all JPEG bytes outside EXIF.'), t(locale, 'DateTimeDigitized, modification time and XMP are unchanged. Existing GPS remains in JPEG copies; sidecar GPS is never added.')].join('\n') + '\n');
  progress(data.entries.length, data.entries.length, 'Packaging verified copies');
  return { zip: zipSync(files, { level: 0 }), manifest };
}
export function isReview(entry: Entry): boolean { return !!entry.jpeg && !['ready', 'preserved'].includes(entry.status); }
export function sourceDate(entry: Entry): string { return entry.jpeg?.embedded.original || 'No readable capture date'; }
export function dateValid(entry: Entry): boolean { return validExifDate(entry.jpeg?.embedded.original || null); }

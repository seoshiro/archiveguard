import type { Manifest } from './engine';
import { instant, message, number, t, type Locale } from './i18n';
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function csvCell(s: unknown): string {
  let value = String(s ?? '');
  // Keep machine-readable CSV keys and values stable; neutralize formulas.
  if (/^\s*[=+@-]/.test(value)) value = "'" + value;
  return '"' + value.replaceAll('"', '""') + '"';
}
export function reports(manifest: Manifest, locale: Locale = 'en'): { csv: string; html: string } {
  const keys = ['id', 'sourcePath', 'status', 'outcome', 'reason', 'sourceSha256', 'outputPath', 'outputSha256', 'payloadSha256', 'payloadPreserved', 'metadataVerified', 'captureAfter', 'offsetAfter', 'sidecarPath', 'sidecarSha256', 'sidecarCaptureEpoch', 'matchConfidence'] as const;
  const csv = '\uFEFF' + keys.map(csvCell).join(',') + '\r\n' + manifest.entries.map(row => keys.map(key => csvCell(row[key])).join(',')).join('\r\n') + '\r\n';
  const tr = (key: string, params?: Record<string, string | number>) => escape(t(locale, key, params));
  const evidence = (text: string) => escape(message(locale, text));
  const created = Date.parse(manifest.createdAt);
  const createdText = Number.isFinite(created) ? instant(locale, created / 1000) : manifest.createdAt;
  const outcomes = { repaired: 'Repaired', copied: 'Copied', excluded: 'Excluded' };
  const summary = tr('{repaired} repaired · {copied} unchanged · {excluded} audit-only or excluded inputs', { repaired: number(locale, manifest.summary.repaired), copied: number(locale, manifest.summary.copied), excluded: number(locale, manifest.summary.excluded) });
  const rows = manifest.entries.map(row => `<tr><td>${escape(row.sourcePath)}<small>${tr('Source SHA-256')}: ${escape(row.sourceSha256 || t(locale, 'Not read'))}</small></td><td>${tr(outcomes[row.outcome])}<small>${evidence(row.reason)}</small></td><td>${escape(row.captureAfter)} ${escape(row.offsetAfter)}</td><td>${escape(row.sidecarPath || t(locale, 'No sidecar used'))}<small>${tr('Output')}: ${escape(row.outputPath || t(locale, 'Excluded'))}<br>${tr('Output SHA-256')}: ${escape(row.outputSha256 || '—')}<br>${tr('Content outside EXIF preserved')}: ${tr(row.payloadPreserved === true ? 'Verified' : 'Not exported')}<br>${tr('Written capture fields')}: ${tr(row.metadataVerified === true ? 'Verified by two readers' : row.outcome === 'copied' ? 'Byte-identical copy' : 'Not exported')}</small></td></tr>`).join('');
  const html = `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${tr('ArchiveGuard audit')}</title><style>body{font:16px/1.7 system-ui;color:#24352f;background:#f9faf8;margin:24px}h1{font-size:28px;line-height:1.3}table{border-collapse:collapse;background:white;width:100%;min-width:760px}td,th{padding:16px;text-align:left;border-bottom:1px solid #d7ddd7;vertical-align:top;overflow-wrap:anywhere}small{display:block;overflow-wrap:anywhere;max-width:600px;color:#57655e}li{margin:12px 0}.wrap{overflow:auto;max-width:100%}p{overflow-wrap:anywhere}@media(max-width:420px){body{margin:16px}h1{font-size:24px}}</style><h1>ArchiveGuard — ${tr('Verified copy audit')}</h1><p>${escape(createdText)} · ${summary}</p><p>${tr('Original files were never overwritten. Source SHA-256 records original bytes; repaired output hashes may differ. JPEG bytes outside EXIF were preserved. GPS coordinates are omitted from this report; existing GPS remains in JPEG copies.')}</p><div class="wrap" tabindex="0" role="region" aria-label="${tr('Verified copy audit')}"><table><thead><tr>${['Selected input', 'Outcome', 'Capture time', 'Provenance & verification'].map(key => `<th scope="col">${tr(key)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><h2>${tr('Scope and limitations')}</h2><ul>${manifest.limitations.map(s => `<li>${evidence(s)}</li>`).join('')}</ul></html>`;
  return { csv, html };
}

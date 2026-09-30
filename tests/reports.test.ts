import { describe, expect, it } from 'vitest';
import type { Manifest, ManifestRow } from '../src/engine';
import { csvCell, reports } from '../src/reports';

function row(overrides: Partial<ManifestRow> = {}): ManifestRow {
  return {
    id: 'f0001', sourcePath: 'album/photo.jpg', status: 'ready', outcome: 'repaired', reason: 'Reviewed capture instant',
    sourceSha256: 'a'.repeat(64), outputPath: 'photos/f0001/photo.jpg', outputSha256: 'b'.repeat(64),
    payloadSha256: 'c'.repeat(64), payloadPreserved: true, metadataVerified: true,
    embeddedBefore: { original: null, digitized: null, modified: null, offset: null, subsecond: null, hasGps: true },
    captureAfter: '2023:11:14 22:13:20', offsetAfter: '+00:00', sidecarPath: 'album/photo.jpg.json',
    sidecarSha256: 'd'.repeat(64), sidecarCaptureEpoch: 1_700_000_000, matchConfidence: 'exact', ...overrides,
  };
}

function manifest(entries: ManifestRow[], overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1, product: 'ArchiveGuard', createdAt: '2026-09-30T12:00:00.000Z',
    policy: { offsetMinutes: 0, gps: 'Existing embedded GPS is preserved', writeScope: 'Capture date and offset only' },
    summary: { repaired: entries.filter(entry => entry.outcome === 'repaired').length, copied: entries.filter(entry => entry.outcome === 'copied').length, excluded: entries.filter(entry => entry.outcome === 'excluded').length },
    limitations: ['JPEG only; originals are preserved.'], entries, ...overrides,
  };
}

function readCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [], value = '', quoted = false;
  const text = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { current.push(value); value = ''; }
    else if (char === '\r' && text[i + 1] === '\n' && !quoted) {
      current.push(value); rows.push(current); current = []; value = ''; i++;
    } else value += char;
  }
  if (current.length || value) { current.push(value); rows.push(current); }
  return rows;
}

describe('spreadsheet-safe CSV cells', () => {
  it.each(['=1+1', '+SUM(A1:A2)', '-1+1', '@SUM(A1:A2)', '  =HYPERLINK("https://example.test")', '\t+1', '\r\n@cmd', '\u00a0-2'])('neutralizes formula input %s', value => {
    expect(readCsv(csvCell(value) + '\r\n')[0][0]).toBe("'" + value);
  });

  it.each(['photo.jpg', "O'Brien.jpg", 'text = 1', 'commas, quotes " and\nnewlines', "'=already neutralized", ''])('preserves plain text %s', value => {
    expect(readCsv(csvCell(value) + '\r\n')[0][0]).toBe(value);
  });

  it('quotes every cell, doubles quotes, and retains null, numbers, and booleans predictably', () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(0)).toBe('"0"');
    expect(csvCell(true)).toBe('"true"');
  });
});

describe('audit reports', () => {
  it('round-trips commas, quotes and newlines without changing CSV column alignment', () => {
    const entry = row({ sourcePath: 'album/a,"photo".jpg', reason: 'Reason, with "quotes"\nand another line', offsetAfter: '-03:30' });
    const report = reports(manifest([entry]));
    const csv = readCsv(report.csv);
    expect(report.csv.startsWith('\uFEFF')).toBe(true);
    expect(report.csv.endsWith('\r\n')).toBe(true);
    expect(csv).toHaveLength(2);
    expect(csv[0]).toEqual(['id', 'sourcePath', 'status', 'outcome', 'reason', 'sourceSha256', 'outputPath', 'outputSha256', 'payloadSha256', 'payloadPreserved', 'metadataVerified', 'captureAfter', 'offsetAfter', 'sidecarPath', 'sidecarSha256', 'sidecarCaptureEpoch', 'matchConfidence']);
    expect(csv[1]).toHaveLength(csv[0].length);
    expect(csv[1][1]).toBe(entry.sourcePath);
    expect(csv[1][4]).toBe(entry.reason);
    expect(csv[1][5]).toBe(entry.sourceSha256);
    expect(csv[1][9]).toBe('true');
    expect(csv[1][12]).toBe("'-03:30");
    expect(csv[1][15]).toBe('1700000000');
  });

  it('neutralizes a formula in any exported string column', () => {
    const entry = row({ id: '=id', sourcePath: '\t=filename', reason: '+command', sourceSha256: '@source', outputPath: '-output', outputSha256: '=hash', payloadSha256: '+payload', captureAfter: '@capture', sidecarPath: '=sidecar', sidecarSha256: '+sidecarHash', matchConfidence: '@confidence' });
    const csv = readCsv(reports(manifest([entry])).csv);
    for (const index of [0, 1, 4, 5, 6, 7, 8, 11, 13, 14, 16]) {
      expect(csv[1][index].startsWith("'")).toBe(true);
    }
  });

  it('escapes every user-controlled HTML field and limitation, including attribute-looking text', () => {
    const attack = '<img src=x onerror="alert(1)">&\'injection';
    const entry = row({ sourcePath: attack, reason: '</small><script>alert(2)</script>', sourceSha256: attack, outputPath: attack, outputSha256: attack, captureAfter: attack, offsetAfter: attack, sidecarPath: attack });
    const html = reports(manifest([entry], { createdAt: attack, limitations: [attack] })).html;
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('</small><script>');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;injection');
    expect(html).not.toContain('alert(2)');
    expect(html).toContain('This file could not be read safely.');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'none'; style-src 'unsafe-inline'");
  });

  it('distinguishes verified repairs, unchanged copies, and exclusions without reporting GPS coordinates', () => {
    const entries = [
      row(),
      row({ id: 'f0002', outcome: 'copied', metadataVerified: null, sidecarPath: null }),
      row({ id: 'f0003', outcome: 'excluded', outputPath: null, outputSha256: null, payloadPreserved: null, metadataVerified: null, captureAfter: null, offsetAfter: null, sidecarPath: null }),
    ];
    const report = reports(manifest(entries));
    expect(report.html).toContain('1 repaired');
    expect(report.html).toContain('1 unchanged');
    expect(report.html).toContain('1 audit-only or excluded inputs');
    expect(report.html).toContain('Verified by two readers');
    expect(report.html).toContain('Byte-identical copy');
    expect(report.html).toContain('Not exported');
    expect(report.html).toContain('GPS coordinates are omitted');
    expect(report.csv).not.toContain('hasGps');
    expect(report.csv).not.toContain('latitude');
    expect(report.html).not.toContain('latitude');
    expect(readCsv(report.csv)).toHaveLength(4);
  });

  it('creates complete report headers for an empty manifest', () => {
    const report = reports(manifest([]));
    const csv = readCsv(report.csv);
    expect(csv[0]).toEqual(expect.arrayContaining(['sourceSha256', 'outputSha256', 'payloadSha256']));
    expect(csv.slice(1).every(cells => cells.join('') === '')).toBe(true);
    expect(report.html).toContain('<tbody></tbody>');
    expect(report.html).toContain('0 repaired');
  });

  it.each(['ru', 'kk'] as const)('localizes %s HTML while keeping machine CSV and private paths unchanged', locale => {
    const entry = row({ sourcePath: 'family/әжеме арналған фото.jpg', reason: 'Reviewed sidecar capture instant; UTC offset 0 minutes. Only DateTimeOriginal and OffsetTimeOriginal written; SubSecTimeOriginal removed.' });
    const data = manifest([entry]);
    const english = reports(data), localized = reports(data, locale);
    expect(localized.csv).toBe(english.csv);
    expect(localized.html).toContain(`lang="${locale}"`);
    expect(localized.html).not.toContain('<title>ArchiveGuard audit</title>');
    expect(localized.html).not.toContain('Verified by two readers');
    expect(localized.html).toContain(entry.sourcePath);
    expect(localized.html).toContain(entry.sourceSha256);
    expect(localized.html).toContain(entry.outputPath);
    expect(localized.html).toContain(entry.captureAfter);
    expect(localized.html).toContain('default-src');
  });

  it.each(['ru', 'kk'] as const)('does not surface arbitrary third-party error text in %s HTML', locale => {
    const attack = '<script>parserSpecificText(12345)</script>';
    const report = reports(manifest([row({ reason: attack })]), locale);
    expect(report.html).not.toContain('parserSpecificText');
    expect(report.html).not.toContain('<script>');
    expect(readCsv(report.csv)[1][4]).toBe(attack);
  });
});

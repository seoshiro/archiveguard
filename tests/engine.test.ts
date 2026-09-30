import { unzipSync, strFromU8 } from 'fflate';
import { decode } from 'jpeg-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dateValid, exportArchive, initialDecisions, inventory, isReview, LIMITS,
  parseSidecar, safePath, sourceDate, unresolved, type Decisions, type Input,
} from '../src/engine';
import { binary, exifInstant, inspectJpeg, jpegSegments, piexif, sha256 } from '../src/jpeg';
import {
  bytesInput, CAPTURE_DATE, CAPTURE_EPOCH, jpegBytes, jsonInput,
  photoInput, POLICY, rawTiff, sidecarInput, sizedInput, withExif, withRawTiff,
} from './fixtures';

afterEach(() => vi.restoreAllMocks());

describe('safe portable input paths', () => {
  it.each(['photo.jpg', 'album/IMG_1234.JPG', 'family/été 2024.jpeg', 'sub/archive-1/photo (2).jpg', 'a'.repeat(251) + '.jpg'])('accepts %s', path => {
    expect(safePath(path)).toBe(true);
  });

  it.each([
    '', '/photo.jpg', '../photo.jpg', 'album/../photo.jpg', './photo.jpg', 'album//photo.jpg', 'album/',
    'C:/photo.jpg', 'album\\photo.jpg', 'bad\0.jpg', 'bad\n.jpg', 'bad\u007f.jpg', 'bad<.jpg', 'bad>.jpg',
    'bad:.jpg', 'bad".jpg', 'bad|.jpg', 'bad?.jpg', 'bad*.jpg', 'photo.jpg.', 'photo.jpg ',
    'con.jpg', 'PRN', 'aux.jpeg', 'nul.txt', 'com1.jpg', 'COM9', 'lpt1.json', 'LPT9.jpg',
    'album/con/photo.jpg', 'a'.repeat(252) + '.jpg', 'a/'.repeat(249) + 'abc.jpg',
  ])('rejects %s', path => {
    expect(safePath(path)).toBe(false);
  });

  it('marks an unsafe selected JPEG invalid before reading its bytes', async () => {
    const input = photoInput('../escape.jpg');
    const read = vi.spyOn(input.file, 'arrayBuffer');
    const data = await inventory([input]);
    expect(data.entries[0]).toMatchObject({ status: 'invalid', sourceHash: null, jpeg: null });
    expect(data.entries[0].note).toMatch(/Unsafe/);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('bounded Google Photos JSON sidecars', () => {
  it('reads capture and creation independently and records GPS presence without retaining coordinates', () => {
    const sidecar = parseSidecar(JSON.stringify({ title: 'photo.jpg', photoTakenTime: { timestamp: String(CAPTURE_EPOCH) }, creationTime: { timestamp: CAPTURE_EPOCH + 100 }, geoData: { latitude: 51.5, longitude: -0.1 } }));
    expect(sidecar).toEqual({ title: 'photo.jpg', capture: CAPTURE_EPOCH, created: CAPTURE_EPOCH + 100, hasGps: true });
    expect(JSON.stringify(sidecar)).not.toContain('51.5');
  });

  it.each([
    { title: 'photo.jpg' },
    { photoTakenTime: { timestamp: -2_208_988_800 } },
    { photoTakenTime: { timestamp: '4102444799' } },
    { creationTime: { timestamp: String(CAPTURE_EPOCH) } },
  ])('accepts recognized sidecar fields %#', value => {
    expect(() => parseSidecar(JSON.stringify(value))).not.toThrow();
  });

  it.each([null, [], 'plain string', 12, {}, { ignored: true }])('rejects an unrecognized root %#', value => {
    expect(() => parseSidecar(JSON.stringify(value))).toThrow();
  });

  it.each([null, 0, '', {}, { timestamp: null }, { timestamp: true }, { timestamp: '' }, { timestamp: '1e9' }, { timestamp: '1.5' }, { timestamp: '+1700000000' }, { timestamp: ' 1700000000' }, { timestamp: 1.5 }, { timestamp: -2_208_988_801 }, { timestamp: 4_102_444_800 }, { timestamp: Number.MAX_SAFE_INTEGER + 1 }])('rejects malformed photoTakenTime %#', value => {
    expect(() => parseSidecar(JSON.stringify({ title: 'photo.jpg', photoTakenTime: value }))).toThrow(/timestamp|Sidecar date/);
  });

  it.each([null, 17, '../photo.jpg', 'folder/photo.jpg', 'con.jpg', 'photo.jpg ', 'bad\\photo.jpg'])('rejects unsafe sidecar title %s', title => {
    expect(() => parseSidecar(JSON.stringify({ title, photoTakenTime: { timestamp: CAPTURE_EPOCH } }))).toThrow(/safe filename/);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects reserved key %s at any nesting level', key => {
    const raw = '{"title":"photo.jpg","nested":{"' + key + '":{"polluted":true}}}';
    expect(() => parseSidecar(raw)).toThrow(/Reserved object key/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    '{"title":"photo.jpg","photoTakenTime":{"timestamp":"1700000000"},"photoTakenTime":{"timestamp":"1700000001"}}',
    '{"title":"photo.jpg","photoTakenTime":{"timestamp":"1700000000","timestamp":"1700000001"}}',
    '{"title":"photo.jpg","photoTakenTime":{"timestamp":"1700000000"},"photoTaken\\u0054ime":{"timestamp":"1700000001"}}',
    '{"title":"photo.jpg","geoData":{"latitude":1,"longitude":2,"latitude":3}}',
  ])('rejects duplicate JSON keys including escaped equivalents %#', raw => {
    expect(() => parseSidecar(raw)).toThrow(/Duplicate/i);
  });

  it('accepts delimiter characters inside strings and repeated keys in distinct array objects', () => {
    const raw = JSON.stringify({ title: 'photo.jpg', description: 'Text containing { } [ ] , : and "quote" and \\slash', values: [{ key: 1 }, { key: 2 }], photoTakenTime: { timestamp: CAPTURE_EPOCH } });
    expect(parseSidecar(raw)).toMatchObject({ title: 'photo.jpg', capture: CAPTURE_EPOCH });
  });

  it('rejects deeply nested values, excessive value counts, and long strings', () => {
    const deep = '{"title":"photo.jpg","nested":' + '['.repeat(17) + '0' + ']'.repeat(17) + '}';
    expect(() => parseSidecar(deep)).toThrow(/nesting/);
    expect(() => parseSidecar(JSON.stringify({ title: 'photo.jpg', values: Array.from({ length: 20_000 }, () => 0) }))).toThrow(/value count/);
    expect(() => parseSidecar(JSON.stringify({ title: 'photo.jpg', description: 'x'.repeat(16_001) }))).toThrow(/string/);
  });

  it('handles GPS absence, zero coordinates, and either supported GPS field', () => {
    expect(parseSidecar('{"title":"photo.jpg"}').hasGps).toBe(false);
    expect(parseSidecar('{"title":"photo.jpg","geoData":{"latitude":0,"longitude":0}}').hasGps).toBe(false);
    expect(parseSidecar('{"title":"photo.jpg","geoDataExif":{"latitude":0,"longitude":10}}').hasGps).toBe(true);
    expect(parseSidecar('{"title":"photo.jpg","geoData":{"latitude":"51","longitude":10}}').hasGps).toBe(false);
  });

  it('isolates malformed JSON and invalid UTF-8 without aborting the rest of the inventory', async () => {
    const data = await inventory([
      { path: 'bad.json', file: new Blob(['{"title":']) },
      bytesInput('utf8.json', Uint8Array.of(0xff, 0xfe)),
      photoInput(), sidecarInput(),
    ]);
    expect(data.entries.map(entry => entry.status)).toEqual(['invalid', 'invalid', 'ready', 'sidecar']);
    expect(data.entries[0].sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.entries[1].sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('inventory bounds and unsupported files', () => {
  it('rejects an empty sample, more than 200 files, and more than 64 MiB before any reads', async () => {
    await expect(inventory([])).rejects.toThrow(/Choose JPEG/);
    await expect(inventory(Array.from({ length: LIMITS.files + 1 }, (_, i) => sizedInput(`f${i}.png`, 0)))).rejects.toThrow(/200 files or 64 MiB/);
    const tooBig = sizedInput('archive.zip', LIMITS.totalBytes + 1);
    const read = vi.spyOn(tooBig.file, 'arrayBuffer');
    await expect(inventory([tooBig])).rejects.toThrow(/200 files or 64 MiB/);
    expect(read).not.toHaveBeenCalled();
  });

  it('accepts the batch file-count and byte-size boundaries for unsupported inputs', async () => {
    expect((await inventory(Array.from({ length: LIMITS.files }, (_, i) => sizedInput(`f${i}.png`, 0)))).entries).toHaveLength(LIMITS.files);
    expect((await inventory([sizedInput('archive.zip', LIMITS.totalBytes)])).inputBytes).toBe(LIMITS.totalBytes);
  });

  it.each([['photo.jpg', LIMITS.jpegBytes, '12 MiB'], ['photo.jpg.json', LIMITS.jsonBytes, '1 MiB']] as const)('rejects oversized %s without reading it', async (path, size, note) => {
    const input = sizedInput(path, size + 1);
    const read = vi.spyOn(input.file, 'arrayBuffer');
    const data = await inventory([input]);
    expect(data.entries[0].status).toBe('invalid');
    expect(data.entries[0].note).toContain(note);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([['photo.jpg', LIMITS.jpegBytes], ['photo.jpg.json', LIMITS.jsonBytes]] as const)('attempts to read %s at its exact per-file limit', async (path, size) => {
    const input = sizedInput(path, size);
    const read = vi.spyOn(input.file, 'arrayBuffer');
    const data = await inventory([input]);
    expect(read).toHaveBeenCalledOnce();
    expect(data.entries[0].note).not.toContain('per-file limit');
  });

  it.each(['image.heic', 'image.raw', 'image.png', 'movie.mp4', 'metadata.xmp', 'archive.zip'])('reports %s as unsupported and never reads it', async path => {
    const input = photoInput(path);
    const read = vi.spyOn(input.file, 'arrayBuffer');
    const data = await inventory([input]);
    expect(data.entries[0]).toMatchObject({ kind: 'other', status: 'unsupported', sourceHash: null, jpeg: null });
    expect(initialDecisions(data).f0001.action).toBe('skip');
    expect(read).not.toHaveBeenCalled();
  });

  it.each([['Photo.jpg', 'photo.JPG'], ['café.jpg', 'cafe\u0301.jpg']])('rejects colliding paths %s and %s before content matching', async (first, second) => {
    const inputs = [photoInput(first), photoInput(second, jpegBytes(1))];
    const reads = inputs.map(input => vi.spyOn(input.file, 'arrayBuffer'));
    const data = await inventory(inputs);
    expect(data.entries.map(entry => entry.status)).toEqual(['invalid', 'invalid']);
    expect(data.entries.every(entry => /collision/.test(entry.note))).toBe(true);
    expect(reads.every(read => read.mock.calls.length === 0)).toBe(true);
  });

  it('records file read failures and finishes the remaining sample with progress', async () => {
    const bad = photoInput('broken.jpg');
    vi.spyOn(bad.file, 'arrayBuffer').mockRejectedValue(new Error('Synthetic read failure'));
    const progress = vi.fn();
    const inputs = [bad, photoInput(), sidecarInput()];
    const data = await inventory(inputs, progress);
    expect(data.entries.map(entry => entry.status)).toEqual(['invalid', 'ready', 'sidecar']);
    expect(data.entries[0].note).toBe('Synthetic read failure');
    expect(data.inputBytes).toBe(inputs.reduce((sum, input) => sum + input.file.size, 0));
    expect(progress).toHaveBeenLastCalledWith(3, 3, 'Inventory complete');
  });
});

describe('sidecar matching and capture provenance', () => {
  it.each(['photo.jpg.json', 'photo.jpg.supplemental-metadata.json'])('automatically matches exact same-folder %s', async path => {
    const data = await inventory([photoInput(), sidecarInput(path)]);
    expect(data.entries[0]).toMatchObject({ id: 'f0001', status: 'ready', candidates: [{ id: 'f0002', confidence: 'exact' }] });
    expect(data.entries[1].status).toBe('sidecar');
    expect(initialDecisions(data)).toEqual({ f0001: { action: 'repair', sidecarId: 'f0002' }, f0002: { action: 'skip', sidecarId: null } });
    expect(unresolved(data, initialDecisions(data))).toBe(0);
    expect(isReview(data.entries[0])).toBe(false);
  });

  it('requires review for a title-only match', async () => {
    const data = await inventory([photoInput(), sidecarInput('renamed.json')]);
    expect(data.entries[0].status).toBe('ambiguous');
    expect(data.entries[0].candidates[0].confidence).toBe('title');
    expect(initialDecisions(data).f0001).toEqual({ action: 'pending', sidecarId: 'f0002' });
    expect(isReview(data.entries[0])).toBe(true);
  });

  it('requires review for possible truncated names and ignores short prefixes', async () => {
    const data = await inventory([
      photoInput('holiday-2023-very-long-name.jpg'),
      sidecarInput('holiday-2023.json', CAPTURE_EPOCH, 'another.jpg'),
      sidecarInput('holiday.json', CAPTURE_EPOCH, 'other.jpg'),
    ]);
    expect(data.entries[0].status).toBe('ambiguous');
    expect(data.entries[0].candidates).toEqual([{ id: 'f0002', confidence: 'possible', reason: expect.stringContaining('truncated') }]);
    expect(data.entries[2].status).toBe('orphan');
  });

  it('requires review when an exact filename and JSON title disagree', async () => {
    const data = await inventory([photoInput(), sidecarInput('photo.jpg.json', CAPTURE_EPOCH, 'different.jpg')]);
    expect(data.entries[0].status).toBe('ambiguous');
    expect(data.entries[0].candidates[0]).toMatchObject({ confidence: 'exact', reason: expect.stringContaining('disagrees') });
  });

  it('does not choose among multiple sidecars or a sidecar claimed by two photos', async () => {
    const multiple = await inventory([photoInput(), sidecarInput(), sidecarInput('photo.jpg.supplemental-metadata.json')]);
    expect(multiple.entries[0].status).toBe('ambiguous');
    expect(multiple.entries[0].candidates).toHaveLength(2);
    expect(initialDecisions(multiple).f0001.sidecarId).toBeNull();
    const shared = await inventory([photoInput('photo.jpg'), photoInput('other.jpg', jpegBytes(1)), sidecarInput('photo.jpg.json', CAPTURE_EPOCH, 'other.jpg')]);
    expect(shared.entries.slice(0, 2).map(entry => entry.status)).toEqual(['ambiguous', 'ambiguous']);
    expect(shared.entries[0].candidates[0].id).toBe(shared.entries[1].candidates[0].id);
  });

  it('never matches by basename or title across folders', async () => {
    const data = await inventory([photoInput('album-a/photo.jpg'), sidecarInput('album-b/photo.jpg.json')]);
    expect(data.entries.map(entry => entry.status)).toEqual(['missing', 'orphan']);
    expect(data.entries[0].candidates).toEqual([]);
    expect(initialDecisions(data).f0001.action).toBe('pending');
  });

  it('matches a nested uppercase JPEG only with its exact basename in that folder', async () => {
    const data = await inventory([photoInput('album/PHOTO.JPG'), sidecarInput('album/PHOTO.JPG.supplemental-metadata.json', CAPTURE_EPOCH, 'PHOTO.JPG')]);
    expect(data.entries[0].status).toBe('ready');
    expect(data.entries[0].kind).toBe('jpeg');
  });

  it('keeps a same-instant embedded capture date as a byte-identical copy proposal', async () => {
    const bytes = withExif({ Exif: { 36867: '2023:11:15 03:58:20', 36868: '2023:11:15 03:58:20', 36881: '+05:45' } });
    const data = await inventory([photoInput('photo.jpg', bytes), sidecarInput()]);
    expect(data.entries[0].status).toBe('preserved');
    expect(initialDecisions(data).f0001.action).toBe('keep');
    expect(sourceDate(data.entries[0])).toBe('2023:11:15 03:58:20');
    expect(dateValid(data.entries[0])).toBe(true);
  });

  it('requires an explicit timezone choice when the original date has no offset', async () => {
    const data = await inventory([photoInput('photo.jpg', withExif({ Exif: { 36867: CAPTURE_DATE } })), sidecarInput()]);
    expect(data.entries[0].status).toBe('timezone');
    expect(initialDecisions(data).f0001.action).toBe('pending');
  });

  it.each([
    { 36867: '2000:01:01 00:00:00', 36881: '+00:00' },
    { 36867: CAPTURE_DATE, 36868: '2000:01:01 00:00:00', 36881: '+00:00' },
    { 36868: '2000:01:01 00:00:00' },
    { 36868: CAPTURE_DATE },
  ] as Record<number, string>[])('requires review for conflicting or digitized-only metadata %#', async Exif => {
    const data = await inventory([photoInput('photo.jpg', withExif({ Exif })), sidecarInput()]);
    expect(data.entries[0].status).toBe('conflict');
    expect(initialDecisions(data).f0001.action).toBe('pending');
    expect(unresolved(data, initialDecisions(data))).toBe(1);
  });

  it('never falls back to upload/creation time, even after selecting repair', async () => {
    const inputs = [photoInput(), jsonInput('photo.jpg.json', { title: 'photo.jpg', creationTime: { timestamp: String(CAPTURE_EPOCH) } })];
    const data = await inventory(inputs);
    expect(data.entries[0].status).toBe('conflict');
    expect(data.entries[1].sidecar).toMatchObject({ capture: null, created: CAPTURE_EPOCH });
    const decisions = initialDecisions(data);
    decisions.f0001.action = 'repair';
    await expect(exportArchive(inputs, data, decisions, POLICY)).rejects.toThrow(/valid capture sidecar/);
  });

  it('records an unmatched JPEG and sidecar without inventing a capture date', async () => {
    const data = await inventory([photoInput('unmatched.jpg'), sidecarInput()]);
    expect(data.entries.map(entry => entry.status)).toEqual(['missing', 'orphan']);
    expect(sourceDate(data.entries[0])).toBe('No readable capture date');
    expect(dateValid(data.entries[0])).toBe(false);
    expect(isReview(data.entries[1])).toBe(false);
  });

  it('retains each byte-identical JPEG as a separate review decision', async () => {
    const bytes = jpegBytes();
    const data = await inventory([photoInput('one.jpg', bytes), photoInput('two.jpg', bytes), photoInput('third.jpg', bytes)]);
    expect(data.entries.map(entry => entry.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(data.entries[0].duplicateOf).toBe('f0002');
    expect(data.entries[1].duplicateOf).toBe('f0001');
    expect(data.entries[2].duplicateOf).toBe('f0001');
    expect(unresolved(data, initialDecisions(data))).toBe(3);
  });
});

describe('transactional verified exports', () => {
  it('exports a repair, a byte-identical copy, and exclusions with verified provenance and reports', async () => {
    const repairSource = withExif({ '0th': { 306: '2001:01:01 01:02:03' }, Exif: { 36868: '2002:02:02 02:03:04', 37521: '123' }, GPS: { 1: 'N', 2: [[51, 1], [30, 1], [0, 1]], 3: 'E', 4: [[7, 1], [0, 1], [0, 1]] } });
    const keepSource = withExif({ Exif: { 36867: CAPTURE_DATE, 36881: '+00:00' } }, jpegBytes(1));
    const inputs = [
      photoInput('album/repair.jpg', repairSource),
      jsonInput('album/repair.jpg.json', { title: 'repair.jpg', photoTakenTime: { timestamp: String(CAPTURE_EPOCH) }, geoData: { latitude: 88.876543, longitude: 77.765432 } }),
      photoInput('album/keep.jpg', keepSource),
      sidecarInput('album/keep.jpg.json', CAPTURE_EPOCH, 'keep.jpg'),
      photoInput('album/exclude.jpg', jpegBytes(2)),
      photoInput('album/video.mp4', jpegBytes(3)),
    ];
    const originals = await Promise.all(inputs.map(input => input.file.arrayBuffer()));
    const data = await inventory(inputs);
    const decisions = initialDecisions(data);
    decisions.f0001.action = 'repair';
    decisions.f0005.action = 'skip';
    const progress = vi.fn();
    const result = await exportArchive(inputs, data, decisions, { acknowledged: true, offsetMinutes: 345 }, progress);
    const files = unzipSync(result.zip);
    expect(Object.keys(files).sort()).toEqual(['README.txt', 'audit.csv', 'audit.html', 'manifest.json', 'photos/f0001/repair.jpg', 'photos/f0003/keep.jpg'].sort());
    expect(result.manifest.summary).toEqual({ repaired: 1, copied: 1, excluded: 4 });
    expect(JSON.parse(strFromU8(files['manifest.json']))).toEqual(result.manifest);
    expect(result.manifest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const repaired = result.manifest.entries[0];
    const repairedBytes = files[repaired.outputPath!];
    const copied = result.manifest.entries[2];
    expect(repaired).toMatchObject({ outcome: 'repaired', payloadPreserved: true, metadataVerified: true, captureAfter: '2023:11:15 03:58:20', offsetAfter: '+05:45', sidecarPath: 'album/repair.jpg.json', sidecarCaptureEpoch: CAPTURE_EPOCH, matchConfidence: 'exact' });
    expect(repaired.sourceSha256).toBe(await sha256(repairSource));
    expect(repaired.outputSha256).toBe(await sha256(repairedBytes));
    expect(repaired.outputSha256).not.toBe(repaired.sourceSha256);
    expect(repaired.sidecarSha256).toBe(await sha256(new Uint8Array(originals[1])));
    expect(repaired.payloadSha256).toBe(await sha256(jpegSegments(repairSource).preserved));
    expect(repaired.payloadSha256).toBe((await inspectJpeg(repairedBytes)).payloadHash);
    expect(await sha256(decode(repairedBytes, { useTArray: true }).data)).toBe(await sha256(decode(repairSource, { useTArray: true }).data));
    expect(exifInstant(repaired.captureAfter!, repaired.offsetAfter!)).toBe(CAPTURE_EPOCH);
    expect(piexif.load(binary(repairedBytes)).GPS).toEqual(piexif.load(binary(repairSource)).GPS);
    expect((await inspectJpeg(repairedBytes)).embedded).toMatchObject({ digitized: '2002:02:02 02:03:04', modified: '2001:01:01 01:02:03', subsecond: null, hasGps: true });

    expect(copied).toMatchObject({ outcome: 'copied', metadataVerified: null, payloadPreserved: true, sidecarPath: null });
    expect(files[copied.outputPath!]).toEqual(keepSource);
    expect(copied.sourceSha256).toBe(copied.outputSha256);
    expect(result.manifest.entries[4]).toMatchObject({ outcome: 'excluded', outputPath: null, outputSha256: null, payloadPreserved: null });
    expect(result.manifest.entries[4].reason).toContain('Explicitly excluded');
    expect(strFromU8(files['README.txt'])).toContain('Original files were never written or deleted');
    expect(strFromU8(files['audit.html'])).toContain('Verified by two readers');
    for (const report of ['manifest.json', 'audit.csv', 'audit.html', 'README.txt']) {
      expect(strFromU8(files[report])).not.toContain('88.876543');
      expect(strFromU8(files[report])).not.toContain('77.765432');
    }
    expect(await Promise.all(inputs.map(input => input.file.arrayBuffer()))).toEqual(originals);
    expect(progress).toHaveBeenLastCalledWith(inputs.length, inputs.length, 'Packaging verified copies');
  });

  it('records sidecar GPS but does not add it to an otherwise GPS-free repaired JPEG', async () => {
    const inputs = [photoInput(), jsonInput('photo.jpg.json', { title: 'photo.jpg', photoTakenTime: { timestamp: CAPTURE_EPOCH }, geoDataExif: { latitude: 52.234567, longitude: 4.987654 } })];
    const data = await inventory(inputs);
    expect(data.entries[1].sidecar?.hasGps).toBe(true);
    const result = await exportArchive(inputs, data, initialDecisions(data), POLICY);
    const bytes = unzipSync(result.zip)[result.manifest.entries[0].outputPath!];
    expect((await inspectJpeg(bytes)).embedded.hasGps).toBe(false);
    expect(piexif.load(binary(bytes)).GPS).toEqual({});
  });

  it('retains a structurally readable JPEG with unsupported EXIF as a byte-identical copy', async () => {
    const source = withRawTiff(rawTiff([{ tag: 65500, value: Uint8Array.of(65, 0) }]));
    const inputs = [photoInput('unsupported-exif.jpg', source)];
    const data = await inventory(inputs);
    expect(data.entries[0]).toMatchObject({ status: 'invalid', jpeg: { repairable: false } });
    const decisions = initialDecisions(data);
    expect(decisions.f0001.action).toBe('pending');
    decisions.f0001.action = 'keep';
    const result = await exportArchive(inputs, data, decisions, POLICY);
    expect(unzipSync(result.zip)['photos/f0001/unsupported-exif.jpg']).toEqual(source);
    expect(result.manifest.entries[0]).toMatchObject({ outcome: 'copied', payloadPreserved: true, metadataVerified: null });
  });

  it('keeps duplicate copies and same basenames from different folders in distinct portable directories', async () => {
    const bytes = jpegBytes();
    const longName = 'a'.repeat(251) + '.jpg';
    const inputs = [photoInput('one/photo.jpg', bytes), photoInput('two/photo.jpg', bytes), photoInput(longName, jpegBytes(1))];
    const data = await inventory(inputs);
    const decisions = initialDecisions(data);
    for (const decision of Object.values(decisions)) decision.action = 'keep';
    const result = await exportArchive(inputs, data, decisions, POLICY);
    const files = unzipSync(result.zip);
    expect(result.manifest.summary).toEqual({ repaired: 0, copied: 3, excluded: 0 });
    expect(files['photos/f0001/photo.jpg']).toEqual(bytes);
    expect(files['photos/f0002/photo.jpg']).toEqual(bytes);
    expect(files[`photos/f0003/${longName}`]).toEqual(jpegBytes(1));
    expect(result.manifest.entries.every(row => safePath(row.outputPath!))).toBe(true);
    expect(result.manifest.entries[2].outputPath!.split('/').at(-1)).toHaveLength(255);
  });

  it('allows a reviewed title-only candidate but rejects a non-candidate sidecar', async () => {
    const inputs = [photoInput(), sidecarInput('renamed.json'), sidecarInput('unrelated.json', CAPTURE_EPOCH, 'another.jpg')];
    const data = await inventory(inputs);
    const decisions = initialDecisions(data);
    decisions.f0001.action = 'repair';
    decisions.f0001.sidecarId = 'f0003';
    await expect(exportArchive(inputs, data, decisions, POLICY)).rejects.toThrow(/valid capture sidecar/);
    decisions.f0001.sidecarId = 'f0002';
    const result = await exportArchive(inputs, data, decisions, POLICY);
    expect(result.manifest.entries[0].matchConfidence).toBe('title');
  });

  it.each([false, true])('rejects a changed JPEG after review when a previous output was processed = %s', async previous => {
    const inputs = previous
      ? [photoInput('first.jpg', jpegBytes(1)), photoInput('photo.jpg'), sidecarInput()]
      : [photoInput(), sidecarInput()];
    const data = await inventory(inputs);
    const decisions = initialDecisions(data);
    if (previous) decisions.f0001.action = 'keep';
    const index = previous ? 1 : 0;
    const changedInputs = inputs.slice();
    changedInputs[index] = photoInput('photo.jpg', jpegBytes(2));
    const progress = vi.fn();
    await expect(exportArchive(changedInputs, data, decisions, POLICY, progress)).rejects.toThrow(/Selected input changed/);
    expect(progress.mock.calls.some(call => call[2] === 'Packaging verified copies')).toBe(false);
    expect(new Uint8Array(await inputs[index].file.arrayBuffer())).toEqual(jpegBytes());
  });

  it.each(['content', 'path', 'size'])('rejects changed sidecar %s after review without packaging an archive', async change => {
    const inputs = [photoInput(), sidecarInput()];
    const data = await inventory(inputs);
    const changedInputs: Input[] = inputs.slice();
    if (change === 'content') changedInputs[1] = sidecarInput('photo.jpg.json', CAPTURE_EPOCH + 1);
    if (change === 'path') changedInputs[1] = sidecarInput('renamed.json');
    if (change === 'size') changedInputs[1] = sizedInput('photo.jpg.json', LIMITS.jsonBytes + 1);
    const progress = vi.fn();
    await expect(exportArchive(changedInputs, data, initialDecisions(data), POLICY, progress)).rejects.toThrow(/Sidecar changed/);
    expect(progress.mock.calls.some(call => call[2] === 'Packaging verified copies')).toBe(false);
  });

  it('aborts the entire export if a metadata writer changes an unrelated field after a prior copy', async () => {
    const original = withExif({ '0th': { 272: 'Original model' } });
    const inputs = [photoInput('first.jpg', jpegBytes(1)), photoInput('photo.jpg', original), sidecarInput()];
    const data = await inventory(inputs);
    const decisions = initialDecisions(data);
    decisions.f0001.action = 'keep';
    const originalDump = piexif.dump;
    vi.spyOn(piexif, 'dump').mockImplementation(exif => {
      const changed = structuredClone(exif);
      changed['0th'][272] = 'Unexpected model';
      return originalDump(changed);
    });
    const progress = vi.fn();
    await expect(exportArchive(inputs, data, decisions, POLICY, progress)).rejects.toThrow(/unrelated EXIF values changed/);
    expect(progress.mock.calls.some(call => call[2] === 'Packaging verified copies')).toBe(false);
    expect(new Uint8Array(await inputs[1].file.arrayBuffer())).toEqual(original);
  });

  it('aborts a repair if the metadata writer alters a compressed scan byte', async () => {
    const inputs = [photoInput(), sidecarInput()];
    const data = await inventory(inputs);
    const originalInsert = piexif.insert;
    vi.spyOn(piexif, 'insert').mockImplementation((exif, source) => {
      const output = originalInsert(exif, source);
      // A change in the final scan bytes keeps headers readable but invalidates preservation.
      const position = output.length - 5;
      return output.slice(0, position) + String.fromCharCode(output.charCodeAt(position) ^ 1) + output.slice(position + 1);
    });
    const progress = vi.fn();
    await expect(exportArchive(inputs, data, initialDecisions(data), POLICY, progress)).rejects.toThrow(/JPEG scan or non-EXIF segments changed/);
    expect(progress.mock.calls.some(call => call[2] === 'Packaging verified copies')).toBe(false);
    expect(new Uint8Array(await inputs[0].file.arrayBuffer())).toEqual(jpegBytes());
  });

  it('requires acknowledgement, a valid offset, and a resolution for every JPEG', async () => {
    const inputs = [photoInput()];
    const data = await inventory(inputs);
    const decisions = initialDecisions(data);
    await expect(exportArchive(inputs, data, decisions, { ...POLICY, acknowledged: false })).rejects.toThrow(/acknowledge/);
    for (const offsetMinutes of [841, -841, 0.5, Number.NaN]) {
      await expect(exportArchive(inputs, data, decisions, { ...POLICY, offsetMinutes })).rejects.toThrow(/Invalid UTC offset/);
    }
    await expect(exportArchive(inputs, data, decisions, POLICY)).rejects.toThrow(/Resolve every JPEG/);
    await expect(exportArchive(inputs, data, {}, POLICY)).rejects.toThrow(/Resolve every JPEG/);
  });

  it('rejects changed input order, source path, per-file size, sample count, and batch size', async () => {
    const inputs = [photoInput(), sidecarInput()];
    const data = await inventory(inputs);
    const decisions = initialDecisions(data);
    await expect(exportArchive([inputs[1], inputs[0]], data, decisions, POLICY)).rejects.toThrow(/inventoried valid JPEGs/);
    await expect(exportArchive([photoInput('renamed.jpg'), inputs[1]], data, decisions, POLICY)).rejects.toThrow(/inventoried valid JPEGs/);
    await expect(exportArchive([sizedInput('photo.jpg', LIMITS.jpegBytes + 1), inputs[1]], data, decisions, POLICY)).rejects.toThrow(/Input size changed/);
    await expect(exportArchive(inputs.slice(0, 1), data, decisions, POLICY)).rejects.toThrow(/bounded inventory/);
    await expect(exportArchive([sizedInput('photo.jpg', LIMITS.totalBytes + 1), inputs[1]], data, decisions, POLICY)).rejects.toThrow(/bounded inventory/);
  });

  it('rejects a forced keep of unsupported or structurally invalid files', async () => {
    const inputs = [photoInput('image.heic'), bytesInput('invalid.jpg', Uint8Array.of(1, 2, 3))];
    const data = await inventory(inputs);
    for (const id of ['f0001', 'f0002']) {
      const decisions = initialDecisions(data);
      decisions[id].action = 'keep';
      await expect(exportArchive(inputs, data, decisions, POLICY)).rejects.toThrow(/inventoried valid JPEGs/);
    }
  });

  it('supports an explicit exclusion-only archive with an audit record for every input', async () => {
    const inputs = [photoInput(), sidecarInput(), photoInput('movie.mp4')];
    const data = await inventory(inputs);
    const decisions: Decisions = Object.fromEntries(data.entries.map(entry => [entry.id, { action: 'skip', sidecarId: null }]));
    const result = await exportArchive(inputs, data, decisions, POLICY);
    expect(result.manifest.summary).toEqual({ repaired: 0, copied: 0, excluded: 3 });
    expect(result.manifest.entries).toHaveLength(3);
    expect(Object.keys(unzipSync(result.zip)).sort()).toEqual(['README.txt', 'audit.csv', 'audit.html', 'manifest.json'].sort());
  });
});

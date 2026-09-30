import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { decode } from 'jpeg-js';
import { exportArchive, initialDecisions, inventory, safePath, unresolved } from '../src/engine';
import { binary, exifInstant, inspectJpeg, jpegSegments, piexif, sha256 } from '../src/jpeg';
import { CAPTURE_EPOCH, jpegBytes, jsonInput, photoInput, POLICY, sidecarInput, withExif } from './fixtures';

describe('additional exploratory provenance controls', () => {
  it('applies the portable filename limit to UTF-8 bytes and exports a valid Unicode filename intact', async () => {
    const name = 'ә'.repeat(125) + '.jpg';
    const unsafe = 'ә'.repeat(126) + '.jpg';
    expect(new TextEncoder().encode(name)).toHaveLength(254);
    expect(safePath(name)).toBe(true);
    expect(safePath(unsafe)).toBe(false);
    const inputs = [photoInput(name), photoInput(unsafe, jpegBytes(1))];
    const data = await inventory(inputs), decisions = initialDecisions(data);
    expect(data.entries.map(entry => entry.status)).toEqual(['missing', 'invalid']);
    decisions.f0001.action = 'keep';
    const result = await exportArchive(inputs, data, decisions, POLICY);
    expect(result.manifest.entries[0].outputPath).toBe(`photos/f0001/${name}`);
    expect(unzipSync(result.zip)[result.manifest.entries[0].outputPath!]).toEqual(jpegBytes());
    expect(result.manifest.entries[1].outcome).toBe('excluded');
  });

  it('allows two explicit repairs using one shared sidecar while preserving each distinct image', async () => {
    const sources = [jpegBytes(), jpegBytes(1)];
    const inputs = [photoInput('first.jpg', sources[0]), photoInput('second.jpg', sources[1]), sidecarInput('first.jpg.json', CAPTURE_EPOCH, 'second.jpg')];
    const data = await inventory(inputs);
    const decisions = initialDecisions(data);
    expect(data.entries.slice(0, 2).map(entry => entry.status)).toEqual(['ambiguous', 'ambiguous']);
    expect(unresolved(data, decisions)).toBe(2);
    decisions.f0001.action = 'repair';
    expect(unresolved(data, decisions)).toBe(1);
    decisions.f0002.action = 'repair';
    const result = await exportArchive(inputs, data, decisions, POLICY);
    const files = unzipSync(result.zip);
    expect(result.manifest.summary).toEqual({ repaired: 2, copied: 0, excluded: 1 });
    for (const [index, row] of result.manifest.entries.slice(0, 2).entries()) {
      const bytes = files[row.outputPath!];
      expect(row.sidecarPath).toBe('first.jpg.json');
      expect(row.sidecarCaptureEpoch).toBe(CAPTURE_EPOCH);
      expect(row.sourceSha256).toBe(await sha256(sources[index]));
      expect(row.outputSha256).toBe(await sha256(bytes));
      expect(jpegSegments(bytes).preserved).toEqual(jpegSegments(sources[index]).preserved);
      expect(decode(bytes).data).toEqual(decode(sources[index]).data);
    }
    expect(result.manifest.entries[0].sourceSha256).not.toBe(result.manifest.entries[1].sourceSha256);
    expect(result.manifest.entries.slice(0, 2).map(row => row.matchConfidence)).toEqual(['exact', 'title']);
  });

  it('keeps exact sidecars with repeated basenames confined to their own folders and capture instants', async () => {
    const inputs = [photoInput('one/photo.jpg'), sidecarInput('one/photo.jpg.json', CAPTURE_EPOCH), photoInput('two/photo.jpg', jpegBytes(1)), sidecarInput('two/photo.jpg.json', CAPTURE_EPOCH + 60)];
    const data = await inventory(inputs);
    expect(data.entries.filter(entry => entry.kind === 'jpeg').map(entry => entry.status)).toEqual(['ready', 'ready']);
    expect(data.entries[0].candidates.map(candidate => candidate.id)).toEqual(['f0002']);
    expect(data.entries[2].candidates.map(candidate => candidate.id)).toEqual(['f0004']);
    const result = await exportArchive(inputs, data, initialDecisions(data), { ...POLICY, offsetMinutes: -210 });
    expect(result.manifest.entries[0]).toMatchObject({ sidecarPath: 'one/photo.jpg.json', captureAfter: '2023:11:14 18:43:20' });
    expect(result.manifest.entries[2]).toMatchObject({ sidecarPath: 'two/photo.jpg.json', captureAfter: '2023:11:14 18:44:20' });
  });

  it('exports the reviewed capture instant even when creation, original and digitized dates all disagree', async () => {
    const source = withExif({ '0th': { 306: '2001:01:01 01:02:03' }, Exif: { 36867: '2002:02:02 02:03:04', 36868: '2003:03:03 03:04:05', 36881: '+00:00' } });
    const inputs = [photoInput('photo.jpg', source), jsonInput('photo.jpg.json', { title: 'photo.jpg', photoTakenTime: { timestamp: CAPTURE_EPOCH }, creationTime: { timestamp: 1_800_000_000 } })];
    const data = await inventory(inputs), decisions = initialDecisions(data);
    expect(data.entries[0].status).toBe('conflict');
    decisions.f0001.action = 'repair';
    const result = await exportArchive(inputs, data, decisions, { ...POLICY, offsetMinutes: 345 });
    const row = result.manifest.entries[0];
    expect(exifInstant(row.captureAfter!, row.offsetAfter!)).toBe(CAPTURE_EPOCH);
    expect(row.sidecarCaptureEpoch).not.toBe(data.entries[1].sidecar!.created);
    const output = unzipSync(result.zip)[row.outputPath!];
    expect(piexif.load(binary(output)).Exif[36868]).toBe('2003:03:03 03:04:05');
    expect(piexif.load(binary(output))['0th'][306]).toBe('2001:01:01 01:02:03');
    expect(await sha256(source)).toBe(row.sourceSha256);
  });

  it('never adds sidecar GPS to either a new capture repair or a GPS-free kept copy', async () => {
    const geoData = { latitude: 88.876543, longitude: 77.765432, altitude: 1234.56789 };
    const inputs = [photoInput('repair.jpg'), jsonInput('repair.jpg.json', { title: 'repair.jpg', photoTakenTime: { timestamp: CAPTURE_EPOCH }, geoData }), photoInput('keep.jpg', jpegBytes(1)), jsonInput('keep.jpg.json', { title: 'keep.jpg', photoTakenTime: { timestamp: CAPTURE_EPOCH }, geoDataExif: geoData })];
    const data = await inventory(inputs), decisions = initialDecisions(data);
    decisions.f0003.action = 'keep';
    const result = await exportArchive(inputs, data, decisions, POLICY), files = unzipSync(result.zip);
    for (const row of result.manifest.entries.filter(entry => entry.outputPath)) {
      expect((await inspectJpeg(files[row.outputPath!])).embedded.hasGps).toBe(false);
    }
    for (const file of ['manifest.json', 'audit.csv', 'audit.html']) {
      const report = strFromU8(files[file]);
      for (const coordinate of Object.values(geoData)) expect(report).not.toContain(String(coordinate));
    }
    expect(Object.keys(files).some(path => path.endsWith('.jpg.json'))).toBe(false);
  });

  it.each([-2_208_988_800, 4_102_444_799])('repairs an exact supported boundary epoch %s without substituting creation time', async epoch => {
    const inputs = [photoInput(), sidecarInput('photo.jpg.json', epoch)];
    const data = await inventory(inputs);
    const result = await exportArchive(inputs, data, initialDecisions(data), POLICY);
    const row = result.manifest.entries[0];
    expect(exifInstant(row.captureAfter!, row.offsetAfter!)).toBe(epoch);
    expect(row.sidecarCaptureEpoch).toBe(epoch);
    expect(row.metadataVerified).toBe(true);
  });

  it('records upload-only evidence but an unchanged copy retains its digitized and modified metadata', async () => {
    const source = withExif({ '0th': { 306: '2001:01:01 01:02:03' }, Exif: { 36868: '2002:02:02 02:03:04' } });
    const inputs = [photoInput('photo.jpg', source), jsonInput('photo.jpg.json', { title: 'photo.jpg', creationTime: { timestamp: CAPTURE_EPOCH } })];
    const data = await inventory(inputs), decisions = initialDecisions(data);
    expect(data.entries[0].status).toBe('conflict');
    decisions.f0001.action = 'keep';
    const result = await exportArchive(inputs, data, decisions, POLICY);
    const row = result.manifest.entries[0];
    expect(unzipSync(result.zip)[row.outputPath!]).toEqual(source);
    expect(row).toMatchObject({ outcome: 'copied', captureAfter: null, sidecarPath: null, metadataVerified: null });
    expect(row.sourceSha256).toBe(row.outputSha256);
  });
});

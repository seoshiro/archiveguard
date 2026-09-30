import { decode } from 'jpeg-js';
import { parse as independentExif } from 'exifr';
import type { ExifData } from 'piexifjs';
import { describe, expect, it } from 'vitest';
import {
  binary, captureText, exifInstant, fromBinary, inspectJpeg, jpegSegments,
  offsetText, piexif, repairJpeg, sha256, validExifDate, validOffset,
} from '../src/jpeg';
import {
  aliasedTiff, CAPTURE_DATE, CAPTURE_EPOCH, insertSegment, jpegBytes,
  markerOf, rawTiff, withExif, withRawTiff,
} from './fixtures';

describe('capture date and offset validation', () => {
  it.each(['1900:01:01 00:00:00', '2000:02:29 23:59:59', '2099:12:31 23:59:59'])('accepts %s', value => {
    expect(validExifDate(value)).toBe(true);
  });

  it.each([null, '', '1899:12:31 23:59:59', '2100:01:01 00:00:00', '1900:02:29 00:00:00', '2023:02:29 00:00:00', '2024:02:30 00:00:00', '2024:13:01 00:00:00', '2024:01:01 24:00:00', '2024:01:01 00:60:00', '2024:01:01 00:00:60', '2024-01-01T00:00:00', '2024:01:01 00:00:00Z', '2024:1:1 00:00:00'])('rejects invalid date %s', value => {
    expect(validExifDate(value)).toBe(false);
  });

  it.each(['+00:00', '-00:00', '+05:45', '-03:30', '+14:00', '-14:00'])('accepts offset %s', value => {
    expect(validOffset(value)).toBe(true);
  });

  it.each([null, '', 'Z', '+5:30', '05:30', '+14:01', '-14:30', '+15:00', '+01:60', '+01:00:00'])('rejects offset %s', value => {
    expect(validOffset(value)).toBe(false);
  });

  it('converts the sidecar instant with an explicitly chosen fractional-hour offset', () => {
    expect(offsetText(345)).toBe('+05:45');
    expect(offsetText(-210)).toBe('-03:30');
    expect(captureText(CAPTURE_EPOCH, 345)).toBe('2023:11:15 03:58:20');
    expect(exifInstant('2023:11:15 03:58:20', '+05:45')).toBe(CAPTURE_EPOCH);
  });

  it.each([
    [CAPTURE_EPOCH + 0.5, 0], [Number.NaN, 0], [-2_208_988_801, 0], [4_102_444_800, 0],
    [CAPTURE_EPOCH, 0.5], [CAPTURE_EPOCH, 841], [CAPTURE_EPOCH, -841], [CAPTURE_EPOCH, Number.NaN],
  ])('rejects an invalid repair epoch %s or offset %s', async (epoch, offset) => {
    await expect(repairJpeg(jpegBytes(), epoch, offset)).rejects.toThrow('Invalid capture timestamp or UTC offset');
  });

  it.each([[-2_208_988_800, -1], [4_102_444_799, 1]])('rejects an offset that takes epoch %s beyond the supported year range', async (epoch, offset) => {
    await expect(repairJpeg(jpegBytes(), epoch, offset)).rejects.toThrow('outside supported range');
  });
});

describe('JPEG structure and byte checksums', () => {
  it('inspects an actual decodable image and computes a separate content hash', async () => {
    const bytes = jpegBytes();
    const decoded = decode(bytes, { useTArray: true, tolerantDecoding: false });
    const info = await inspectJpeg(bytes);
    expect([decoded.width, decoded.height, info.width, info.height]).toEqual([3, 2, 3, 2]);
    expect(info.repairable).toBe(true);
    expect(info.embedded.original).toBeNull();
    expect(info.payloadHash).toBe(await sha256(jpegSegments(bytes).preserved));
    expect(await sha256(decoded.data)).not.toBe(await sha256(bytes));
  });

  it('hashes the full byte sequence using SHA-256 and round-trips binary strings across chunks', async () => {
    expect(await sha256(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const bytes = Uint8Array.from({ length: 20_000 }, (_, i) => i % 256);
    expect(fromBinary(binary(bytes))).toEqual(bytes);
  });

  it.each(['SOI', 'EOI', 'truncated', 'bad-marker', 'segment-length', 'no-frame', 'no-scan'])('rejects %s corruption', corruption => {
    let bytes = jpegBytes();
    const frame = markerOf(bytes, 0xc0);
    const scan = markerOf(bytes, 0xda);
    if (corruption === 'SOI') bytes[1] = 0;
    if (corruption === 'EOI') bytes[bytes.length - 1] = 0;
    if (corruption === 'truncated') bytes = bytes.subarray(0, bytes.length - 20);
    if (corruption === 'bad-marker') bytes[2] = 0;
    if (corruption === 'segment-length') { bytes[4] = 0xff; bytes[5] = 0xff; }
    if (corruption === 'no-frame') bytes[frame.start + 1] = 0xc3;
    if (corruption === 'no-scan') {
      const shortened = new Uint8Array(scan.start + 2);
      shortened.set(bytes.subarray(0, scan.start));
      shortened.set([0xff, 0xd9], scan.start);
      bytes = shortened;
    }
    expect(() => jpegSegments(bytes)).toThrow();
  });

  it.each(['precision', 'count', 'length', 'duplicate-component', 'sampling', 'quantization', 'zero-width', 'zero-height', 'dimensions'])('rejects malformed frame %s', corruption => {
    const bytes = jpegBytes();
    const p = markerOf(bytes, 0xc0).lengthOffset;
    if (corruption === 'precision') bytes[p + 2] = 12;
    if (corruption === 'count') bytes[p + 7] = 2;
    if (corruption === 'length') bytes[p + 1] = 8;
    if (corruption === 'duplicate-component') bytes[p + 11] = bytes[p + 8];
    if (corruption === 'sampling') bytes[p + 9] = 0;
    if (corruption === 'quantization') bytes[p + 10] = 4;
    if (corruption === 'zero-width') { bytes[p + 5] = 0; bytes[p + 6] = 0; }
    if (corruption === 'zero-height') { bytes[p + 3] = 0; bytes[p + 4] = 0; }
    if (corruption === 'dimensions') { bytes[p + 3] = 0xff; bytes[p + 4] = 0xff; bytes[p + 5] = 0xff; bytes[p + 6] = 0xff; }
    expect(() => jpegSegments(bytes)).toThrow(/frame|dimensions/i);
  });

  it('rejects a duplicate frame', () => {
    const bytes = jpegBytes();
    const frame = markerOf(bytes, 0xc0);
    const data = bytes.subarray(frame.lengthOffset + 2, frame.lengthOffset + frame.length);
    expect(() => jpegSegments(insertSegment(bytes, 0xc0, data))).toThrow('frame layout');
  });

  it.each(['count', 'length', 'selector', 'duplicate-selector', 'table', 'empty'])('rejects malformed scan %s', corruption => {
    let bytes = jpegBytes();
    const scan = markerOf(bytes, 0xda);
    const p = scan.lengthOffset;
    if (corruption === 'count') bytes[p + 2] = 0;
    if (corruption === 'length') bytes[p + 1] = 6;
    if (corruption === 'selector') bytes[p + 3] = 99;
    if (corruption === 'duplicate-selector') bytes[p + 5] = bytes[p + 3];
    if (corruption === 'table') bytes[p + 4] = 0x44;
    if (corruption === 'empty') {
      const shortened = new Uint8Array(p + scan.length + 2);
      shortened.set(bytes.subarray(0, p + scan.length));
      shortened.set([0xff, 0xd9], p + scan.length);
      bytes = shortened;
    }
    expect(() => jpegSegments(bytes)).toThrow(/scan/i);
  });

  it('rejects an unbounded number of pre-scan segments', () => {
    const source = jpegBytes();
    const bytes = new Uint8Array(source.length + 4097 * 4);
    bytes.set(source.subarray(0, 2));
    for (let i = 0; i < 4097; i++) bytes.set([0xff, 0xfe, 0, 2], 2 + i * 4);
    bytes.set(source.subarray(2), 2 + 4097 * 4);
    expect(() => jpegSegments(bytes)).toThrow('Too many JPEG segments');
  });

  it('rejects two EXIF blocks instead of selecting one', async () => {
    const source = withExif({ Exif: { 36867: CAPTURE_DATE } });
    const tiff = rawTiff([{ tag: 272, value: new TextEncoder().encode('Other\0') }]);
    await expect(inspectJpeg(withRawTiff(tiff, source))).rejects.toThrow('Multiple EXIF');
  });
});

describe('bounded TIFF metadata', () => {
  it.each([false, true])('accepts a bounded terminated ASCII tag with little endian = %s', async little => {
    const info = await inspectJpeg(withRawTiff(rawTiff([{ tag: 272, value: new TextEncoder().encode('Camera\0') }], little)));
    expect(info.repairable).toBe(true);
    expect(info.exif?.['0th'][272]).toBe('Camera');
  });

  it.each([
    ['duplicate tags', [{ tag: 272, value: Uint8Array.of(65, 0) }, { tag: 272, value: Uint8Array.of(66, 0) }]],
    ['zero count', [{ tag: 272, count: 0, value: new Uint8Array() }]],
    ['unterminated inline ASCII', [{ tag: 272, value: Uint8Array.of(65, 66, 67, 68) }]],
    ['unterminated pointed ASCII', [{ tag: 272, value: new TextEncoder().encode('camera') }]],
    ['unknown tag', [{ tag: 65500, value: Uint8Array.of(65, 0) }]],
    ['wrong TIFF type', [{ tag: 272, type: 7, value: Uint8Array.of(65, 0) }]],
    ['offset-dependent image data', [{ tag: 273, type: 4, value: Uint8Array.of(0, 0, 0, 8) }]],
  ])('disables repair for %s', async (_label, tags) => {
    const source = withRawTiff(rawTiff(tags));
    const info = await inspectJpeg(source);
    expect(info.repairable).toBe(false);
    expect(info.warning).toBeTruthy();
    expect(info.exif).toBeNull();
    expect(info.payloadHash).toBe(await sha256(jpegBytes()));
    await expect(repairJpeg(source, CAPTURE_EPOCH, 0)).rejects.toThrow();
  });

  it.each(['truncated-header', 'byte-order', 'signature', 'directory-bounds', 'directory-count', 'value-bounds', 'cycle'])('disables repair for invalid TIFF %s', async corruption => {
    let tiff = rawTiff([{ tag: 272, value: new TextEncoder().encode('Camera\0') }]);
    const view = new DataView(tiff.buffer);
    if (corruption === 'truncated-header') tiff = tiff.subarray(0, 7);
    if (corruption === 'byte-order') tiff[0] = 0;
    if (corruption === 'signature') view.setUint16(2, 43);
    if (corruption === 'directory-bounds') view.setUint32(4, tiff.length + 10);
    if (corruption === 'directory-count') view.setUint16(8, 513);
    if (corruption === 'value-bounds') view.setUint32(18, tiff.length - 1);
    if (corruption === 'cycle') tiff = rawTiff([{ tag: 34665, type: 4, value: Uint8Array.of(0, 0, 0, 8) }]);
    const info = await inspectJpeg(withRawTiff(tiff));
    expect(info.repairable).toBe(false);
    expect(info.warning).toMatch(/TIFF|EXIF/i);
  });

  it.each(['Ascii', 'Rational'] as const)('bounds logical expansion of aliased %s values before parsing', async type => {
    const tiff = aliasedTiff(type);
    expect(tiff.length).toBeLessThan(65_536);
    const info = await inspectJpeg(withRawTiff(tiff));
    expect(info.repairable).toBe(false);
    expect(info.warning).toMatch(/bounded logical size/i);
  });

  it('offers unchanged-copy information for a MakerNote without attempting a rewrite', async () => {
    const source = withExif({ Exif: { 37500: 'opaque camera-specific data' } });
    const info = await inspectJpeg(source);
    expect(info.repairable).toBe(false);
    expect(info.warning).toMatch(/MakerNote/);
    expect([info.width, info.height]).toEqual([3, 2]);
    expect(info.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(repairJpeg(source, CAPTURE_EPOCH, 0)).rejects.toThrow(/MakerNote/);
  });

  it.each([
    { Exif: { 36867: '2023:02:30 00:00:00' } },
    { Exif: { 36867: CAPTURE_DATE, 36881: '+14:30' } },
  ] as Partial<ExifData>[])('disables repair for invalid embedded capture metadata %#', async metadata => {
    expect((await inspectJpeg(withExif(metadata))).repairable).toBe(false);
  });
});

describe('verified JPEG repair', () => {
  it('changes only capture fields, preserves decoded pixels and non-EXIF bytes, and confirms two readers', async () => {
    let source = withExif({
      '0th': { 271: 'Synthetic camera', 272: 'Fixture 3x2', 306: '2001:02:03 04:05:06' },
      Exif: { 36867: '2002:03:04 05:06:07', 36868: '2003:04:05 06:07:08', 36881: '+01:00', 36882: '-03:30', 37521: '123', 37522: '456', 33434: [1, 125] },
      GPS: { 1: 'N', 2: [[51, 1], [30, 1], [0, 1]], 3: 'W', 4: [[0, 1], [7, 1], [0, 1]] },
    });
    source = insertSegment(source, 0xfe, new TextEncoder().encode('retain this JPEG comment'));
    source = insertSegment(source, 0xe1, new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>retain XMP</x:xmpmeta>'));
    const originalBytes = source.slice();
    const before = await inspectJpeg(source);
    const beforePixelHash = await sha256(decode(source, { useTArray: true, tolerantDecoding: false }).data);
    const fixed = await repairJpeg(source, CAPTURE_EPOCH, 345);
    const afterPixels = decode(fixed.bytes, { useTArray: true, tolerantDecoding: false });

    expect(source).toEqual(originalBytes);
    expect(fixed.bytes).not.toEqual(source);
    expect(await sha256(fixed.bytes)).not.toBe(await sha256(source));
    expect(await sha256(afterPixels.data)).toBe(beforePixelHash);
    expect(jpegSegments(fixed.bytes).preserved).toEqual(jpegSegments(source).preserved);
    expect(fixed.info.payloadHash).toBe(before.payloadHash);
    expect(fixed.info.embedded).toEqual({ original: '2023:11:15 03:58:20', digitized: '2003:04:05 06:07:08', modified: '2001:02:03 04:05:06', offset: '+05:45', subsecond: null, hasGps: true });

    const firstReader = piexif.load(binary(fixed.bytes));
    expect(firstReader.Exif[36867]).toBe(fixed.writtenDate);
    expect(firstReader.Exif[36881]).toBe(fixed.writtenOffset);
    expect(firstReader.Exif[37521]).toBeUndefined();
    expect(firstReader.Exif[37522]).toBe('456');
    expect(firstReader.Exif[36882]).toBe('-03:30');
    expect(firstReader.Exif[33434]).toEqual([1, 125]);
    expect(firstReader.GPS).toEqual(before.exif?.GPS);
    expect(firstReader['0th'][272]).toBe('Fixture 3x2');

    const secondReader = await independentExif(fixed.bytes, { pick: ['DateTimeOriginal', 'OffsetTimeOriginal'], reviveValues: false, translateValues: false, mergeOutput: true });
    expect(secondReader).toMatchObject({ DateTimeOriginal: fixed.writtenDate, OffsetTimeOriginal: fixed.writtenOffset });
    expect(exifInstant(fixed.writtenDate, fixed.writtenOffset)).toBe(CAPTURE_EPOCH);
  });

  it('adds capture EXIF to a plain JPEG without introducing GPS', async () => {
    const fixed = await repairJpeg(jpegBytes(), CAPTURE_EPOCH, -210);
    expect(fixed.info.embedded.original).toBe('2023:11:14 18:43:20');
    expect(fixed.info.embedded.offset).toBe('-03:30');
    expect(fixed.info.embedded.hasGps).toBe(false);
    expect(fixed.info.exif?.GPS).toEqual({});
  });
});

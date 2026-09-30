import { encode } from 'jpeg-js';
import type { ExifData } from 'piexifjs';
import { binary, fromBinary, piexif } from '../src/jpeg';
import type { Input } from '../src/engine';

export const CAPTURE_EPOCH = 1_700_000_000;
export const CAPTURE_DATE = '2023:11:14 22:13:20';
export const POLICY = { offsetMinutes: 0, acknowledged: true };

export function jpegBytes(seed = 0): Uint8Array {
  const data = new Uint8Array(4 * 3 * 2);
  for (let i = 0; i < 6; i++) {
    data.set([(i * 47 + seed * 37) % 256, (i * 91 + seed * 53) % 256, (i * 13 + seed * 71) % 256, 255], i * 4);
  }
  return new Uint8Array(encode({ data, width: 3, height: 2 }, 85).data);
}

export function withExif(groups: Partial<ExifData>, source = jpegBytes()): Uint8Array {
  const exif: ExifData = { '0th': {}, Exif: {}, GPS: {}, Interop: {}, '1st': {}, thumbnail: null, ...groups };
  return fromBinary(piexif.insert(piexif.dump(exif), binary(source)));
}

export function bytesInput(path: string, bytes: Uint8Array): Input {
  return { path, file: new Blob([bytes.slice().buffer]) };
}

export function photoInput(path = 'photo.jpg', bytes = jpegBytes()): Input {
  return bytesInput(path, bytes);
}

export function jsonInput(path: string, value: unknown): Input {
  return { path, file: new Blob([JSON.stringify(value)], { type: 'application/json' }) };
}

export function sidecarInput(path = 'photo.jpg.json', capture: number | null = CAPTURE_EPOCH, title: string | null = 'photo.jpg'): Input {
  return jsonInput(path, {
    ...(title === null ? {} : { title }),
    ...(capture === null ? {} : { photoTakenTime: { timestamp: String(capture) } }),
  });
}

export function sizedInput(path: string, size: number): Input {
  const file = new Blob([]);
  Object.defineProperty(file, 'size', { value: size });
  return { path, file };
}

export type Marker = { marker: number; start: number; lengthOffset: number; length: number };
export function markers(bytes: Uint8Array): Marker[] {
  const result: Marker[] = [];
  let p = 2;
  while (p < bytes.length - 2) {
    const start = p;
    if (bytes[p++] !== 0xff) throw new Error('Fixture has invalid marker');
    while (bytes[p] === 0xff) p++;
    const marker = bytes[p++];
    const length = (bytes[p] << 8) | bytes[p + 1];
    result.push({ marker, start, lengthOffset: p, length });
    if (marker === 0xda) break;
    p += length;
  }
  return result;
}

export function markerOf(bytes: Uint8Array, marker: number): Marker {
  const result = markers(bytes).find(item => item.marker === marker);
  if (!result) throw new Error(`Fixture marker ${marker} missing`);
  return result;
}

export function insertSegment(source: Uint8Array, marker: number, data: Uint8Array): Uint8Array {
  const length = data.length + 2;
  const output = new Uint8Array(source.length + data.length + 4);
  output.set(source.subarray(0, 2));
  output.set([0xff, marker, length >> 8, length & 0xff], 2);
  output.set(data, 6);
  output.set(source.subarray(2), data.length + 6);
  return output;
}

export function withRawTiff(tiff: Uint8Array, source = jpegBytes()): Uint8Array {
  const data = new Uint8Array(tiff.length + 6);
  data.set([69, 120, 105, 102, 0, 0]);
  data.set(tiff, 6);
  return insertSegment(source, 0xe1, data);
}

export type TiffTag = { tag: number; type?: number; count?: number; value: Uint8Array };
export function rawTiff(tags: TiffTag[], little = false): Uint8Array {
  const headerLength = 8 + 2 + tags.length * 12 + 4;
  const tiff = new Uint8Array(headerLength + tags.reduce((n, tag) => n + (tag.value.length > 4 ? tag.value.length : 0), 0));
  const view = new DataView(tiff.buffer);
  tiff.set(little ? [73, 73] : [77, 77]);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, tags.length, little);
  let valueOffset = headerLength;
  tags.forEach((tag, index) => {
    const p = 10 + index * 12;
    const type = tag.type ?? 2;
    const width = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
    view.setUint16(p, tag.tag, little);
    view.setUint16(p + 2, type, little);
    view.setUint32(p + 4, tag.count ?? tag.value.length / width, little);
    if (tag.value.length > 4) {
      view.setUint32(p + 8, valueOffset, little);
      tiff.set(tag.value, valueOffset);
      valueOffset += tag.value.length;
    } else tiff.set(tag.value, p + 8);
  });
  return tiff;
}

export function aliasedTiff(type: 'Ascii' | 'Rational'): Uint8Array {
  const tags = Object.entries(piexif.TAGS.Image).filter(([, tag]) => tag.type === type);
  const headerLength = 8 + 2 + tags.length * 12 + 4;
  const tiff = new Uint8Array(headerLength + 60_000);
  const view = new DataView(tiff.buffer);
  tiff.set([77, 77, 0, 42, 0, 0, 0, 8]);
  view.setUint16(8, tags.length);
  tags.forEach(([tag], index) => {
    const p = 10 + index * 12;
    view.setUint16(p, Number(tag));
    view.setUint16(p + 2, type === 'Ascii' ? 2 : 5);
    view.setUint32(p + 4, type === 'Ascii' ? 60_000 : 7_500);
    view.setUint32(p + 8, headerLength);
  });
  tiff.fill(type === 'Ascii' ? 65 : 1, headerLength);
  if (type === 'Ascii') tiff[tiff.length - 1] = 0;
  return tiff;
}

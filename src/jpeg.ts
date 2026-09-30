import piexif, { type ExifData } from 'piexifjs';
import exifr from 'exifr';
const { parse: readExif } = exifr;

// EXIF 2.31 offsets are missing from piexifjs's older tag table.
for (const [id, name] of [[36880, 'OffsetTime'], [36881, 'OffsetTimeOriginal'], [36882, 'OffsetTimeDigitized']] as const) {
  piexif.TAGS.Exif[id] = { name, type: 'Ascii' };
}
export { piexif };
export type Embedded = { original: string | null; digitized: string | null; modified: string | null; offset: string | null; subsecond: string | null; hasGps: boolean };
export type JpegInfo = { exif: ExifData | null; embedded: Embedded; repairable: boolean; warning: string | null; width: number; height: number; payloadHash: string };
const EMPTY: Embedded = { original: null, digitized: null, modified: null, offset: null, subsecond: null, hasGps: false };
export const binary = (bytes: Uint8Array): string => {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return chunks.join('');
};
export const fromBinary = (data: string): Uint8Array => Uint8Array.from(data, c => c.charCodeAt(0));
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}
function text(value: unknown): string | null { return typeof value === 'string' ? value.replace(/\0+$/, '') : null; }
export function validExifDate(s: string | null): s is string {
  if (!s || !/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return false;
  const iso = s.slice(0, 10).replaceAll(':', '-') + 'T' + s.slice(11) + 'Z';
  const d = new Date(iso);
  return !isNaN(d.valueOf()) && d.toISOString().slice(0, 19) + 'Z' === iso && d.getUTCFullYear() >= 1900 && d.getUTCFullYear() < 2100;
}
export function validOffset(s: string | null): s is string {
  if (!s || !/^[+-]\d{2}:\d{2}$/.test(s)) return false;
  const h = Number(s.slice(1, 3)), m = Number(s.slice(4));
  return h <= 14 && m < 60 && (h < 14 || m === 0);
}
export function exifInstant(s: string, offset: string): number {
  return Date.parse(s.slice(0, 10).replaceAll(':', '-') + 'T' + s.slice(11) + offset) / 1000;
}
type Segments = { preserved: Uint8Array; exifs: Uint8Array[]; width: number; height: number };
export function jpegSegments(bytes: Uint8Array): Segments {
  if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error('Not a complete JPEG (SOI / EOI markers missing).');
  const keep: Uint8Array[] = [bytes.subarray(0, 2)], exifs: Uint8Array[] = [];
  let p = 2, width = 0, height = 0, hasScan = false, segmentCount = 0;
  let frameComponents: number[] = [];
  while (p < bytes.length - 2) {
    if (++segmentCount > 4096) throw new Error('Too many JPEG segments.');
    const start = p;
    if (bytes[p++] !== 255) throw new Error('Invalid JPEG marker layout.');
    while (bytes[p] === 255) p++;
    const marker = bytes[p++];
    if (marker === 0 || marker === 216 || marker === 217 || (marker >= 208 && marker <= 215)) throw new Error('Unexpected JPEG marker before scan.');
    const size = (bytes[p] << 8) | bytes[p + 1];
    if (size < 2 || p + size > bytes.length - 2) throw new Error('JPEG segment exceeds the file.');
    if ([192, 193, 194].includes(marker)) {
      if (size < 8 || width) throw new Error('Unsupported JPEG frame layout.');
      const components = bytes[p + 7];
      if (bytes[p + 2] !== 8 || ![1, 3, 4].includes(components) || size !== 8 + 3 * components) throw new Error('Unsupported or malformed JPEG frame components.');
      frameComponents = [];
      for (let i = 0; i < components; i++) {
        const position = p + 8 + 3 * i, id = bytes[position], sampling = bytes[position + 1];
        if (frameComponents.includes(id) || (sampling >> 4) < 1 || (sampling >> 4) > 4 || (sampling & 15) < 1 || (sampling & 15) > 4 || bytes[position + 2] > 3) throw new Error('Invalid JPEG frame component.');
        frameComponents.push(id);
      }
      height = (bytes[p + 3] << 8) | bytes[p + 4]; width = (bytes[p + 5] << 8) | bytes[p + 6];
      if (!width || !height || width * height > 80_000_000) throw new Error('JPEG dimensions exceed the 80 megapixel limit.');
    }
    if (marker === 218) {
      if (!width || size < 6) throw new Error('JPEG scan has no valid supported frame.');
      const components = bytes[p + 2], selectors = new Set<number>();
      if (!components || components > frameComponents.length || size !== 6 + 2 * components || p + size >= bytes.length - 2) throw new Error('Malformed or empty JPEG scan.');
      for (let i = 0; i < components; i++) {
        const id = bytes[p + 3 + 2 * i], tables = bytes[p + 4 + 2 * i];
        if (!frameComponents.includes(id) || selectors.has(id) || (tables >> 4) > 3 || (tables & 15) > 3) throw new Error('Invalid JPEG scan selector.');
        selectors.add(id);
      }
      keep.push(bytes.subarray(start)); hasScan = true; break;
    }
    const isExif = marker === 225 && binary(bytes.subarray(p + 2, p + 8)) === 'Exif\0\0';
    if (isExif) { if (exifs.length) throw new Error('Multiple EXIF blocks: unsupported JPEG structure.'); exifs.push(bytes.subarray(p + 8, p + size)); } else keep.push(bytes.subarray(start, p + size));
    p += size;
  }
  if (!hasScan) throw new Error('No supported JPEG image scan.');
  const preserved = new Uint8Array(keep.reduce((n, b) => n + b.length, 0));
  let offset = 0; for (const part of keep) { preserved.set(part, offset); offset += part.length; }
  return { preserved, exifs, width, height };
}
// Validate TIFF bounds and tag coverage BEFORE the metadata engine reads any offsets.
function validateTiff(tiff: Uint8Array): void {
  if (tiff.length < 8) throw new Error('Truncated EXIF TIFF header.');
  const little = tiff[0] === 73 && tiff[1] === 73;
  if (!little && !(tiff[0] === 77 && tiff[1] === 77)) throw new Error('Invalid EXIF byte order.');
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (p: number) => view.getUint16(p, little), u32 = (p: number) => view.getUint32(p, little);
  if (u16(2) !== 42) throw new Error('Invalid TIFF signature.');
  const visited = new Set<number>();
  let logicalBytes = 0, logicalElements = 0;
  const widths: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 };
  const types: Record<string, number> = { Byte: 1, Ascii: 2, Short: 3, Long: 4, Rational: 5, Undefined: 7, SLong: 9, SRational: 10, Float: 11, DFloat: 12 };
  const visit = (offset: number, group: string): void => {
    if (!offset) return;
    if (visited.has(offset) || visited.size >= 5) throw new Error('Cyclic or excessive EXIF directories.');
    visited.add(offset);
    if (offset < 8 || offset + 2 > tiff.length) throw new Error('EXIF directory outside file.');
    const count = u16(offset);
    const hasNextPointer = group === '0th' || group === '1st';
    if (count > 512 || offset + 2 + count * 12 + (hasNextPointer ? 4 : 0) > tiff.length) throw new Error('Invalid EXIF directory size.');
    const pointers: [number, string][] = [];
    const tags = new Set<number>();
    let thumbStart = 0, thumbLength = 0;
    for (let i = 0; i < count; i++) {
      const p = offset + 2 + i * 12, tag = u16(p), type = u16(p + 2), n = u32(p + 4);
      if (tags.has(tag)) throw new Error('Duplicate EXIF tag: repair is disabled.');
      tags.add(tag);
      const known = piexif.TAGS[group === '0th' || group === '1st' ? 'Image' : group]?.[tag];
      if (tag === 37500) throw new Error('Camera MakerNote: keep a byte-identical copy; repair is disabled.');
      if ([273, 279, 330].includes(tag) || ([513, 514].includes(tag) && group !== '1st')) throw new Error('Offset-dependent EXIF data: repair is disabled.');
      if (!known || !widths[type] || types[known.type] !== type) throw new Error(`EXIF tag ${tag} is outside the supported lossless rewrite scope.`);
      const bytes = n * widths[type];
      logicalBytes += bytes; logicalElements += [2, 7].includes(type) ? 1 : n;
      if (!n || n > 65535 || bytes > tiff.length || logicalBytes > 65536 || logicalElements > 4096) throw new Error('EXIF values exceed bounded logical size.');
      if (bytes > 4 && (u32(p + 8) < 8 || u32(p + 8) + bytes > tiff.length)) throw new Error('EXIF value outside file.');
      if (type === 2 && tiff[(bytes > 4 ? u32(p + 8) : p + 8) + bytes - 1] !== 0) throw new Error('Unterminated EXIF text: repair is disabled.');
      if ([34665, 34853, 40965].includes(tag)) {
        if (type !== 4 || n !== 1) throw new Error('Invalid EXIF directory pointer.');
        pointers.push([u32(p + 8), tag === 34665 ? 'Exif' : tag === 34853 ? 'GPS' : 'Interop']);
      }
      if (tag === 513) thumbStart = u32(p + 8);
      if (tag === 514) thumbLength = u32(p + 8);
    }
    if (thumbStart || thumbLength) {
      if (!thumbStart || !thumbLength || thumbLength > 50000 || thumbStart + thumbLength > tiff.length) throw new Error('Invalid EXIF thumbnail bounds.');
    }
    for (const [p, g] of pointers) visit(p, g);
    const next = hasNextPointer ? u32(offset + 2 + count * 12) : 0;
    if (next && group !== '0th') throw new Error('Unsupported chained EXIF directories.');
    if (next) visit(next, '1st');
  };
  visit(u32(4), '0th');
}
export async function inspectJpeg(bytes: Uint8Array): Promise<JpegInfo> {
  const parts = jpegSegments(bytes);
  const base = { width: parts.width, height: parts.height, payloadHash: await sha256(parts.preserved) };
  try {
    if (parts.exifs.length > 1) throw new Error('Multiple EXIF blocks: repair is disabled.');
    for (const exif of parts.exifs) validateTiff(exif);
    const exif = piexif.load(binary(bytes));
    const embedded: Embedded = {
      original: text(exif.Exif[36867]), digitized: text(exif.Exif[36868]), modified: text(exif['0th'][306]),
      offset: text(exif.Exif[36881]), subsecond: text(exif.Exif[37521]), hasGps: Object.keys(exif.GPS).length > 0,
    };
    if (embedded.original && !validExifDate(embedded.original)) throw new Error('Invalid embedded capture date: repair is disabled.');
    if (embedded.offset && !validOffset(embedded.offset)) throw new Error('Invalid embedded timezone: repair is disabled.');
    return { ...base, exif, embedded, repairable: true, warning: null };
  } catch (e) { return { ...base, exif: null, embedded: { ...EMPTY }, repairable: false, warning: e instanceof Error ? e.message : 'EXIF could not be safely read.' }; }
}
export function offsetText(minutes: number): string {
  return `${minutes < 0 ? '-' : '+'}${Math.floor(Math.abs(minutes) / 60).toString().padStart(2, '0')}:${(Math.abs(minutes) % 60).toString().padStart(2, '0')}`;
}
export function captureText(epoch: number, minutes: number): string {
  return new Date((epoch + minutes * 60) * 1000).toISOString().slice(0, 19).replaceAll('-', ':').replace('T', ' ');
}
function canonical(exif: ExifData): string {
  const copy = structuredClone(exif);
  // The engine recalculates structural offsets, not metadata values.
  for (const group of ['0th', 'Exif', 'GPS', 'Interop', '1st'] as const) {
    for (const id of [34665, 34853, 40965, 513, 514]) delete copy[group][id];
  }
  return JSON.stringify(copy, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
}
export async function repairJpeg(bytes: Uint8Array, epoch: number, minutes: number): Promise<{ bytes: Uint8Array; info: JpegInfo; writtenDate: string; writtenOffset: string }> {
  if (!Number.isSafeInteger(epoch) || epoch < -2208988800 || epoch > 4102444799 || !Number.isInteger(minutes) || Math.abs(minutes) > 840) throw new Error('Invalid capture timestamp or UTC offset.');
  const before = await inspectJpeg(bytes);
  if (!before.repairable || !before.exif) throw new Error(before.warning || 'Repair unavailable.');
  const exif = structuredClone(before.exif), writtenDate = captureText(epoch, minutes), writtenOffset = offsetText(minutes);
  if (!validExifDate(writtenDate)) throw new Error('Capture date is outside supported range after timezone conversion.');
  exif.Exif[36867] = writtenDate;
  exif.Exif[36881] = writtenOffset;
  // A second-precision JSON timestamp cannot justify existing fractional seconds.
  delete exif.Exif[37521];
  const output = fromBinary(piexif.insert(piexif.dump(exif), binary(bytes)));
  const after = await inspectJpeg(output);
  if (!after.exif || !after.repairable || after.embedded.original !== writtenDate || after.embedded.offset !== writtenOffset || after.embedded.subsecond !== null) throw new Error('Written EXIF failed read-back verification.');
  if (before.payloadHash !== after.payloadHash) throw new Error('Preservation verification failed: JPEG scan or non-EXIF segments changed.');
  if (canonical(exif) !== canonical(after.exif)) throw new Error('Preservation verification failed: unrelated EXIF values changed.');
  // Corroborate the two written fields using a separate metadata reader.
  const independent = await readExif(output, { pick: ['DateTimeOriginal', 'OffsetTimeOriginal'], reviveValues: false, translateValues: false, mergeOutput: true });
  if (independent?.DateTimeOriginal !== writtenDate || independent?.OffsetTimeOriginal !== writtenOffset) throw new Error('Independent EXIF read-back did not confirm the capture date and offset.');
  return { bytes: output, info: after, writtenDate, writtenOffset };
}

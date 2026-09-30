import fs from 'node:fs/promises';
import jpeg from 'jpeg-js';
import piexif from 'piexifjs';
for (const [id, name] of [[36880, 'OffsetTime'], [36881, 'OffsetTimeOriginal'], [36882, 'OffsetTimeDigitized']]) piexif.TAGS.Exif[id] = { name, type: 'Ascii' };
const root = new URL('../public/demo/', import.meta.url);
await fs.mkdir(root, { recursive: true });
const names = [];
async function save(name, data) { await fs.writeFile(new URL(name, root), data); names.push(name); }
function picture(seed, original = null, offset = null) {
  const width = 240, height = 180, pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, hill = y > 70 + Math.sin(x / 38 + seed) * 30;
    pixels[i] = hill ? 60 + seed * 12 : 180 + seed * 8; pixels[i + 1] = hill ? 120 + seed * 9 : 201; pixels[i + 2] = hill ? 80 + seed * 7 : 166; pixels[i + 3] = 255;
  }
  const bytes = jpeg.encode({ data: pixels, width, height }, 75).data;
  if (!original) return bytes;
  const exif = { '0th': { 271: 'ArchiveGuard synthetic camera', 274: 1 }, Exif: { 36867: original }, GPS: {}, Interop: {}, '1st': {}, thumbnail: null };
  if (offset) exif.Exif[36881] = offset;
  return Buffer.from(piexif.insert(piexif.dump(exif), bytes.toString('binary')), 'binary');
}
const timestamp = '1700000000';
const sidecar = title => JSON.stringify({ title, photoTakenTime: { timestamp }, creationTime: { timestamp: '1710000000' }, geoData: { latitude: 48.8, longitude: 2.3 } }, null, 2);
await save('garden-walk.jpg', picture(1)); await save('garden-walk.jpg.json', sidecar('garden-walk.jpg'));
await save('summer-afternoon.jpg', picture(2, '2020:06:10 14:22:00', '+02:00')); await save('summer-afternoon.jpg.json', sidecar('summer-afternoon.jpg'));
await save('morning-light.jpg', picture(3, '2023:11:14 22:13:20')); await save('morning-light.jpg.json', sidecar('morning-light.jpg'));
await save('intact-memory.jpg', picture(4, '2023:11:14 22:13:20', '+00:00')); await save('intact-memory.jpg.supplemental-metadata.json', sidecar('intact-memory.jpg'));
await save('old-memory.jpg', picture(5));
const twin = picture(6); await save('copy-a.jpg', twin); await save('copy-b.jpg', twin);
await save('broken-sidecar.json', '{"title":');
await save('video-example.mp4', 'Synthetic placeholder for an unsupported-format demonstration.');
await fs.writeFile(new URL('demo.json', root), JSON.stringify(names, null, 2));
console.log(`Created ${names.length} synthetic demo inputs.`);

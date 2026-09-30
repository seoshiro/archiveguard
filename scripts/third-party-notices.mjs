import fs from 'node:fs/promises';
import path from 'node:path';
const names = ['react', 'react-dom', 'scheduler', 'exifr', 'fflate', 'piexifjs', 'lucide-react', '@types/react', 'csstype'];
let text = 'ArchiveGuard third-party notices\nRuntime and included type dependencies; original licenses follow.\n\n';
for (const name of names) {
  const root = path.join('node_modules', name), pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const files = (await fs.readdir(root)).filter(file => /^licen[cs]e(?:\.|$)/i.test(file));
  if (!files.length) throw new Error(`License file not found: ${name}`);
  text += `${'='.repeat(72)}\n${name} ${pkg.version} — ${pkg.license}\n${'='.repeat(72)}\n`;
  for (const file of files) text += (await fs.readFile(path.join(root, file), 'utf8')) + '\n\n';
}
text += `${'='.repeat(72)}\nIBM Plex Sans — @ibm/plex-sans 1.1.0 — SIL Open Font License 1.1\n${'='.repeat(72)}\n`;
text += await fs.readFile('public/fonts/IBMPlexSans-LICENSE.txt', 'utf8');
await fs.writeFile('public/THIRD_PARTY_NOTICES.txt', text.replace(/\r\n/g, '\n').trimEnd() + '\n');
console.log(`Collected unmodified license notices for ${names.length} dependencies and IBM Plex Sans.`);

import fs from 'node:fs/promises';
import path from 'node:path';
const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const rows = [];
for (const group of ['dependencies', 'devDependencies']) {
  for (const name of Object.keys(pkg[group])) {
    const entry = lock.packages[`node_modules/${name}`];
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${entry.version}`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Registry lookup failed for ${name}: ${response.status}`);
    const official = await response.json();
    if (entry.integrity !== official.dist.integrity || entry.resolved !== official.dist.tarball) throw new Error(`Registry integrity mismatch: ${name}`);
    const local = JSON.parse(await fs.readFile(path.join('node_modules', name, 'package.json'), 'utf8'));
    if (local.version !== entry.version) throw new Error(`Local installed version mismatch: ${name}`);
    rows.push({ name, version: entry.version, license: official.license, registryTarball: official.dist.tarball, integrityMatches: true });
  }
}
for (const [name, entry] of Object.entries(lock.packages)) if (name && entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/')) throw new Error(`Non-registry dependency: ${name}`);
await fs.mkdir('evidence', { recursive: true });
await fs.writeFile('evidence/dependency-validation.json', JSON.stringify({ checkedAt: new Date().toISOString(), allLockTarballsUseOfficialNpmRegistry: true, directPackages: rows }, null, 2));
console.log(`Verified ${rows.length} direct dependency versions, licenses and registry integrity values; all locked tarballs use registry.npmjs.org.`);

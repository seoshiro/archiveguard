import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
const candidate = process.env.GITHUB_SHA || git.stdout?.trim();
const commit = /^[a-f0-9]{40}$/.test(candidate || '') ? candidate : 'local';
await fs.writeFile('dist/version.json', JSON.stringify({ product: 'ArchiveGuard', version: pkg.version, commit, scope: 'JPEG + Google Photos JSON; 200 inputs / 64 MiB' }, null, 2) + '\n');
console.log(`Release ${pkg.version}; source ${commit}.`);

import { test, expect } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import exifr from 'exifr';
const { parse: readExif } = exifr;
import { jpegSegments } from '../src/jpeg';
import type { Manifest } from '../src/engine';

const baseURL = process.env.ARCHIVEGUARD_BASE_URL || 'http://127.0.0.1:4318/';
const origin = new URL(baseURL).origin;
const evidenceDir = process.env.ARCHIVEGUARD_EVIDENCE_DIR || 'evidence';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('synthetic preflight, explicit conflicts, policy and verified ZIP download work end to end', async ({ page }) => {
  const errors: string[] = [], outgoing: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => { if ((!request.url().startsWith(origin + '/') || request.method() !== 'GET') && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) outgoing.push(request.url()); });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Photo archive preflight' })).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/desktop-start.png`, fullPage: true });
  await page.getByTestId('demo-start').click();
  await expect(page.getByRole('heading', { name: 'Archive inventory' })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(14);
  await expect(page.getByText('Cannot process', { exact: true })).toBeVisible();
  await expect(page.getByText('Unsupported format', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/desktop-inventory.png`, fullPage: true });
  await page.getByRole('button', { name: 'Review exceptions', exact: true }).click();
  const reviewNames = ['summer-afternoon.jpg', 'morning-light.jpg', 'old-memory.jpg', 'copy-a.jpg', 'copy-b.jpg'];
  for (const name of reviewNames) {
    await page.getByRole('button', { name: new RegExp(name.replaceAll('.', '\\.') + '.*Sample archive') }).click();
    const review = page.getByRole('region', { name: `Review Sample archive/${name}` });
    await expect(review).toBeVisible();
    if (name === 'summer-afternoon.jpg') {
      await expect(review.getByText('2020:06:10 14:22:00', { exact: true })).toBeVisible();
      await page.screenshot({ path: `${evidenceDir}/desktop-conflict.png`, fullPage: true });
      await review.getByRole('radio', { name: /Use sidecar capture time/ }).check();
    } else await review.getByRole('radio', { name: /Keep unchanged/ }).check();
    await review.getByRole('button', { name: 'Close file review' }).click();
    await expect(page.getByRole('button', { name: new RegExp(name.replaceAll('.', '\\.') + '.*Sample archive') })).toBeFocused();
  }
  await page.getByRole('button', { name: 'Continue to export', exact: true }).click();
  const prepare = page.getByRole('button', { name: 'Verify & prepare ZIP' });
  await expect(prepare).toBeDisabled();
  await page.getByLabel('UTC offset for repaired capture times').selectOption('345');
  await page.getByRole('checkbox', { name: /I reviewed the fixed UTC offset/ }).check();
  await prepare.click();
  await expect(page.getByRole('heading', { name: 'Your verified copies are ready.' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download ZIP' }).click();
  const download = await downloadPromise;
  const location = await download.path();
  const zip = unzipSync(await fs.readFile(location!));
  const manifest: Manifest = JSON.parse(strFromU8(zip['manifest.json']));
  expect(manifest.entries).toHaveLength(13);
  expect(manifest.summary).toEqual({ repaired: 2, copied: 5, excluded: 6 });
  expect(manifest.policy.offsetMinutes).toBe(345);
  expect(manifest.entries.filter(e => e.outcome === 'repaired').every(e => e.metadataVerified && e.payloadPreserved && e.sourceSha256 !== e.outputSha256)).toBe(true);
  expect(Object.keys(zip).filter(p => p.endsWith('.jpg'))).toHaveLength(7);
  expect(zip['audit.html']).toBeTruthy(); expect(zip['audit.csv']).toBeTruthy();
  await fs.mkdir(evidenceDir, { recursive: true });
  await download.saveAs(`${evidenceDir}/ArchiveGuard-demo-verified.zip`);
  await page.screenshot({ path: `${evidenceDir}/desktop-export.png`, fullPage: true });
  await page.getByLabel('UTC offset for repaired capture times').selectOption('0');
  await expect(page.getByRole('link', { name: 'Download ZIP' })).toHaveCount(0);
  await expect(prepare).toBeDisabled();
  expect(errors).toEqual([]); expect(outgoing).toEqual([]);
});

test('production preview serves local assets with privacy headers and refuses write requests', async ({ request }) => {
  const response = await request.get('./');
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain('Content-Security-Policy');
  const csp = response.headers()['content-security-policy'];
  if (csp) {
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    if (new URL(baseURL).hostname === '127.0.0.1') {
      expect((await request.post('./')).status()).toBe(405);
      expect((await request.get('./', { headers: { Host: 'attacker.invalid:4318' } })).status()).toBe(403);
    }
  }
  expect((await request.get('./favicon.svg')).status()).toBe(200);
  expect((await request.get('./package.json')).status()).toBe(404);
});

test('new file selection cancels a delayed demo and keeps the newer real-file inventory', async ({ page }) => {
  await page.goto('./');
  await page.route('**/demo/demo.json', async route => { await new Promise(resolve => setTimeout(resolve, 1200)); await route.continue().catch(() => {}); });
  await page.getByTestId('demo-start').click();
  await page.getByLabel('Import JPEG and JSON files').setInputFiles([{ name: 'garden-walk.jpg', mimeType: 'image/jpeg', buffer: await fs.readFile('public/demo/garden-walk.jpg') }, { name: 'garden-walk.jpg.json', mimeType: 'application/json', buffer: await fs.readFile('public/demo/garden-walk.jpg.json') }]);
  await expect(page.getByRole('heading', { name: 'Archive inventory' })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(3);
  await page.waitForTimeout(1600);
  await expect(page.getByRole('row')).toHaveCount(3);
  await expect(page.getByText('Sample archive', { exact: true })).toHaveCount(0);
});

test('actual selected files use the same pipeline and malformed or unsafe inputs stay explicit', async ({ page }) => {
  const original = await fs.readFile('public/demo/garden-walk.jpg'), sourceHash = hash(original);
  const outbound: string[] = [], errors: string[] = [];
  page.on('request', r => { if (r.postData() || (r.method() !== 'GET' && r.method() !== 'HEAD') || (!r.url().startsWith(origin + '/') && !r.url().startsWith('blob:') && !r.url().startsWith('data:'))) outbound.push(r.url()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('./');
  await page.getByLabel('Import JPEG and JSON files').setInputFiles([{ name: 'garden-walk.jpg', mimeType: 'image/jpeg', buffer: original }, { name: 'garden-walk.jpg.json', mimeType: 'application/json', buffer: await fs.readFile('public/demo/garden-walk.jpg.json') }, { name: 'dangerous.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') }, { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') }]);
  await expect(page.getByRole('heading', { name: 'Archive inventory' })).toBeVisible();
  await expect(page.getByText('Ready to restore', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: /bad.json.*Selected input/ }).click();
  await expect(page.getByRole('heading', { name: 'bad.json' })).toBeVisible();
  await page.getByRole('button', { name: 'Close file review' }).click();
  await page.getByRole('button', { name: 'Continue to export', exact: true }).click();
  await page.getByRole('checkbox', { name: /I reviewed/ }).check();
  await page.getByRole('button', { name: 'Verify & prepare ZIP' }).click();
  await expect(page.getByRole('link', { name: 'Download ZIP' })).toBeVisible();
  const promise = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download ZIP' }).click();
  const download = await promise, downloaded = unzipSync(await fs.readFile((await download.path())!));
  const manifest: Manifest = JSON.parse(strFromU8(downloaded['manifest.json']));
  const row = manifest.entries.find(e => e.sourcePath === 'garden-walk.jpg')!;
  expect(row.outcome).toBe('repaired'); expect(row.sourceSha256).toBe(sourceHash);
  const output = downloaded[row.outputPath!];
  expect(hash(output)).toBe(row.outputSha256); expect(row.outputSha256).not.toBe(sourceHash);
  expect(hash(jpegSegments(output).preserved)).toBe(hash(jpegSegments(original).preserved));
  const metadata = await readExif(output, { pick: ['DateTimeOriginal', 'OffsetTimeOriginal'], reviveValues: false });
  expect(metadata.DateTimeOriginal).toBe('2023:11:14 22:13:20'); expect(metadata.OffsetTimeOriginal).toBe('+00:00');
  expect(hash(await fs.readFile('public/demo/garden-walk.jpg'))).toBe(sourceHash);
  expect(outbound).toEqual([]); expect(errors).toEqual([]);
  await fs.mkdir(evidenceDir, { recursive: true });
  await download.saveAs(`${evidenceDir}/actual-import-verified.zip`);
  await fs.writeFile(`${evidenceDir}/actual-import-proof.json`, JSON.stringify({ url: baseURL, sourceSha256: sourceHash, originalUnchanged: true, outputSha256: row.outputSha256, nonExifBytesPreserved: true, twoReaderWriteVerified: row.metadataVerified, independentCaptureReadback: metadata, externalOrBodyRequests: outbound.length, pageErrors: errors.length }, null, 2));
});

test('mobile layout, keyboard access, search and cancellation are usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'ArchiveGuard home' })).toBeFocused();
  await page.screenshot({ path: `${evidenceDir}/mobile-start.png`, fullPage: true });
  await page.getByTestId('demo-start').click();
  await expect(page.getByRole('heading', { name: 'Archive inventory' })).toBeVisible();
  await page.getByLabel('Find a file').fill('summer');
  await expect(page.getByRole('row')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidenceDir}/mobile-review.png`, fullPage: true });
  await page.getByRole('button', { name: 'New sample' }).click();
  await page.route('**/demo/demo.json', async route => { await new Promise(resolve => setTimeout(resolve, 1200)); await route.continue().catch(() => {}); });
  await page.getByTestId('demo-start').click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Archive inventory' })).toHaveCount(0);
});

test('public release metadata, privacy help, and relative assets stay usable', async ({ page, request }) => {
  const response = await request.get('./version.json'); expect(response.status()).toBe(200);
  const version = await response.json(); expect(version.product).toBe('ArchiveGuard'); expect(version.version).toBe('1.1.0');
  if (process.env.ARCHIVEGUARD_EXPECTED_COMMIT) expect(version.commit).toBe(process.env.ARCHIVEGUARD_EXPECTED_COMMIT);
  await page.goto('./');
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Privacy, limits & support' })).toBeVisible();
  await page.goto(new URL('privacy.html', baseURL).href);
  await expect(page.getByRole('heading', { name: 'Your archive stays on your device.' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: /Back to ArchiveGuard/ }).click();
  await expect(page.getByRole('heading', { name: 'Photo archive preflight' })).toBeVisible();
});

test('a browser without local worker support gets a useful error and no partial export', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'Worker', { value: undefined, configurable: true }));
  await page.goto('./');
  await page.getByLabel('Import JPEG and JSON files').setInputFiles([{ name: 'garden-walk.jpg', mimeType: 'image/jpeg', buffer: await fs.readFile('public/demo/garden-walk.jpg') }]);
  await expect(page.getByRole('alert')).toContainText('Private processing needs Web Workers and Web Crypto');
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Download ZIP' })).toHaveCount(0);
});

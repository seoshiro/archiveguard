import { test, expect, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { decode } from 'jpeg-js';
import type { Manifest } from '../src/engine';
import { binary, jpegSegments, piexif } from '../src/jpeg';
import { t } from '../src/i18n';
import { CAPTURE_EPOCH, jpegBytes, withExif } from './fixtures';

type SelectedFile = { name: string; mimeType: string; buffer: Buffer };
const evidenceDir = process.env.ARCHIVEGUARD_QA_EVIDENCE_DIR || 'evidence/qa/regression';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const telemetry = new Map<Page, { errors: string[]; outbound: string[] }>();

function photo(name: string, seed = 0, groups: Parameters<typeof withExif>[0] = {}): SelectedFile {
  const bytes = Object.keys(groups).length ? withExif(groups, jpegBytes(seed)) : jpegBytes(seed);
  return { name, mimeType: 'image/jpeg', buffer: Buffer.from(bytes) };
}
function json(name: string, value: unknown): SelectedFile {
  return { name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) };
}
function sidecar(name: string, title: string, epoch = CAPTURE_EPOCH, extra: Record<string, unknown> = {}): SelectedFile {
  return json(name, { title, photoTakenTime: { timestamp: String(epoch) }, ...extra });
}
async function select(page: Page, files: SelectedFile[]) {
  await page.getByTestId('file-input').setInputFiles(files);
  await expect(page.getByTestId('inventory-table')).toBeVisible();
  await expect(page.getByTestId('inventory-table').getByRole('row')).toHaveCount(files.length + 1);
}
async function review(page: Page, id = 'f0001') {
  await page.getByTestId(`review-file-${id}`).click();
  const panel = page.getByTestId('review-panel');
  await expect(panel).toBeVisible();
  return panel;
}
async function prepare(page: Page, offset = '0') {
  await page.getByTestId('nav-export').click();
  await page.getByTestId('offset-select').selectOption(offset);
  await page.getByTestId('policy-ack').check();
  await page.getByTestId('prepare-export').click();
  await expect(page.getByTestId('download-zip')).toBeVisible();
}
async function download(page: Page) {
  const waiting = page.waitForEvent('download');
  await page.getByTestId('download-zip').click();
  const item = await waiting;
  expect(await item.failure()).toBeNull();
  const bytes = await fs.readFile((await item.path())!);
  const files = unzipSync(bytes);
  const manifest: Manifest = JSON.parse(strFromU8(files['manifest.json']));
  return { bytes, files, manifest, item };
}
async function capture(page: Page, info: TestInfo, suffix: string) {
  await fs.mkdir(evidenceDir, { recursive: true });
  const name = info.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 130);
  const path = `${evidenceDir}/${name}-${suffix}.png`;
  await page.screenshot({ path, fullPage: true });
  await info.attach(suffix, { path, contentType: 'image/png' });
}
async function assertNoDocumentOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
}
async function assertKeyboardScrollableTable(page: Page) {
  const overflow = await page.getByTestId('inventory-table').evaluate(table => {
    let element = table.parentElement;
    while (element && element.tagName !== 'MAIN') {
      if (element.scrollWidth > element.clientWidth + 1) {
        const style = getComputedStyle(element);
        return { overflowX: style.overflowX, tabIndex: element.tabIndex, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      }
      element = element.parentElement;
    }
    return null;
  });
  if (overflow) {
    expect(overflow.overflowX, JSON.stringify(overflow)).toMatch(/auto|scroll/);
    expect(overflow.tabIndex, 'A horizontally scrolling table needs a keyboard focus target').toBeGreaterThanOrEqual(0);
  }
}
async function delayWorker(page: Page, operation: 'scan' | 'export', milliseconds = 800) {
  await page.addInitScript(({ operation: delayedOperation, milliseconds: delay }) => {
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      stopped = false;
      override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        const send = () => {
          if (this.stopped) return;
          if (Array.isArray(options)) super.postMessage(message, options);
          else super.postMessage(message, options);
        };
        if ((message as { operation?: string }).operation === delayedOperation) setTimeout(send, delay);
        else send();
      }
      override terminate() { this.stopped = true; super.terminate(); }
    };
  }, { operation, milliseconds });
}

test.beforeEach(async ({ page }) => {
  const record = { errors: [] as string[], outbound: [] as string[] };
  telemetry.set(page, record);
  page.on('pageerror', error => record.errors.push(error.message));
  page.on('request', request => {
    const url = request.url();
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    const expectedOrigin = new URL(process.env.ARCHIVEGUARD_BASE_URL || 'http://127.0.0.1:4318/').origin;
    if (!url.startsWith(expectedOrigin + '/') || !['GET', 'HEAD'].includes(request.method()) || request.postData()) record.outbound.push(`${request.method()} ${url}`);
  });
  await page.addInitScript(() => { try { if (!localStorage.getItem('archiveguard.locale')) localStorage.setItem('archiveguard.locale', 'en'); } catch { /* Tests also exercise unavailable preference storage. */ } });
});

test.afterEach(async ({ page }, info) => {
  const record = telemetry.get(page)!;
  await fs.mkdir(evidenceDir, { recursive: true });
  const slug = info.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 150);
  await fs.writeFile(`${evidenceDir}/${slug}.json`, JSON.stringify({ title: info.title, status: info.status, url: page.url(), syntheticFixturesOnly: true, pageErrors: record.errors, outgoingOrBodyRequests: record.outbound }, null, 2));
  telemetry.delete(page);
  expect(record.errors, 'Unexpected browser exceptions').toEqual([]);
  expect(record.outbound, 'Photo processing must not send bodies or contact another origin').toEqual([]);
});

test('competing sidecars require a candidate and changing it resets the decision', async ({ page }, info) => {
  await page.goto('./');
  await select(page, [photo('ambiguous.jpg'), sidecar('ambiguous.jpg.json', 'ambiguous.jpg'), sidecar('ambiguous.jpg.supplemental-metadata.json', 'ambiguous.jpg', CAPTURE_EPOCH + 10)]);
  await page.getByTestId('nav-export').click();
  await page.getByTestId('policy-ack').check();
  await expect(page.getByTestId('prepare-export')).toBeDisabled();
  await page.getByTestId('nav-inventory').click();
  await review(page);
  await expect(page.getByTestId('decision-repair')).toBeDisabled();
  await page.getByTestId('sidecar-select').selectOption('f0002');
  await page.getByTestId('decision-repair').check();
  await page.getByTestId('sidecar-select').selectOption('f0003');
  await expect(page.getByTestId('decision-repair')).not.toBeChecked();
  await expect(page.getByTestId('decision-keep')).not.toBeChecked();
  await page.getByTestId('decision-repair').check();
  await capture(page, info, 'selected-candidate');
  await page.getByTestId('close-review').click();
  await expect(page.getByTestId('review-file-f0001')).toBeFocused();
  await prepare(page);
  const result = await download(page);
  expect(result.manifest.entries[0]).toMatchObject({ status: 'ambiguous', outcome: 'repaired', sidecarPath: 'ambiguous.jpg.supplemental-metadata.json', sidecarCaptureEpoch: CAPTURE_EPOCH + 10 });
});

test('shared sidecars keep independent decisions and export the reviewed sources', async ({ page }) => {
  await page.goto('./');
  const first = photo('first.jpg'), second = photo('second.jpg', 1);
  await select(page, [first, second, sidecar('first.jpg.json', 'second.jpg')]);
  await review(page, 'f0001');
  await page.getByTestId('decision-keep').check();
  await page.getByTestId('close-review').click();
  await review(page, 'f0002');
  await expect(page.getByTestId('decision-keep')).not.toBeChecked();
  await page.getByTestId('decision-repair').check();
  await page.getByTestId('close-review').click();
  await prepare(page);
  const result = await download(page);
  expect(result.manifest.summary).toEqual({ repaired: 1, copied: 1, excluded: 1 });
  expect(result.manifest.entries.slice(0, 2).map(entry => entry.status)).toEqual(['ambiguous', 'ambiguous']);
  expect(result.files[result.manifest.entries[0].outputPath!]).toEqual(new Uint8Array(first.buffer));
  expect(result.manifest.entries[1]).toMatchObject({ sourceSha256: hash(second.buffer), sidecarPath: 'first.jpg.json', matchConfidence: 'title' });
});

test('timezone and multiple embedded dates stay explicit while GPS remains private', async ({ page }, info) => {
  await page.goto('./');
  const original = photo('dates.jpg', 2, { '0th': { 306: '2001:01:01 01:02:03' }, Exif: { 36867: '2002:02:02 02:03:04', 36868: '2003:03:03 03:04:05', 37521: '123' }, GPS: { 1: 'N', 2: [[51, 1], [30, 1], [0, 1]], 3: 'E', 4: [[7, 1], [0, 1], [0, 1]] } });
  await select(page, [original, sidecar('dates.jpg.json', 'dates.jpg', CAPTURE_EPOCH, { creationTime: { timestamp: '1800000000' }, geoData: { latitude: 88.876543, longitude: 77.765432 } })]);
  const panel = await review(page);
  await expect(panel).toContainText('2003:03:03 03:04:05');
  await expect(panel).toContainText('2001:01:01 01:02:03');
  await expect(panel).toContainText('2027');
  expect(await page.locator('body').innerText()).not.toContain('88.876543');
  await page.getByTestId('decision-repair').check();
  await capture(page, info, 'evidence-before-repair');
  await page.getByTestId('close-review').click();
  await prepare(page, '345');
  const result = await download(page);
  const entry = result.manifest.entries[0], output = result.files[entry.outputPath!];
  expect(entry).toMatchObject({ status: 'timezone', captureAfter: '2023:11:15 03:58:20', offsetAfter: '+05:45', metadataVerified: true, payloadPreserved: true });
  expect(entry.sourceSha256).toBe(hash(original.buffer));
  expect(entry.outputSha256).toBe(hash(output));
  expect(hash(jpegSegments(output).preserved)).toBe(hash(jpegSegments(original.buffer).preserved));
  expect(decode(output).data).toEqual(decode(original.buffer).data);
  const metadata = piexif.load(binary(output));
  expect(metadata.Exif[36868]).toBe('2003:03:03 03:04:05');
  expect(metadata['0th'][306]).toBe('2001:01:01 01:02:03');
  expect(metadata.Exif[37521]).toBeUndefined();
  expect(metadata.GPS).toEqual(piexif.load(binary(original.buffer)).GPS);
  for (const name of ['manifest.json', 'audit.csv', 'audit.html']) {
    expect(strFromU8(result.files[name])).not.toContain('88.876543');
    expect(strFromU8(result.files[name])).not.toContain('77.765432');
  }
  await result.item.saveAs(`${evidenceDir}/multiple-dates-verified.zip`);
});

test('creation-only and digitized-only evidence require distinct explicit outcomes', async ({ page }) => {
  await page.goto('./');
  const digitized = photo('digitized.jpg', 3, { Exif: { 36868: '2000:01:01 00:00:00' } });
  await select(page, [photo('creation.jpg'), json('creation.jpg.json', { title: 'creation.jpg', creationTime: { timestamp: String(CAPTURE_EPOCH) } }), digitized, sidecar('digitized.jpg.json', 'digitized.jpg')]);
  await review(page);
  await expect(page.getByTestId('decision-repair')).toBeDisabled();
  await page.getByTestId('decision-skip').check();
  await page.getByTestId('close-review').click();
  await review(page, 'f0003');
  await expect(page.getByTestId('review-panel')).toContainText('2000:01:01 00:00:00');
  await page.getByTestId('decision-keep').check();
  await page.getByTestId('close-review').click();
  await prepare(page);
  const result = await download(page);
  expect(result.manifest.summary).toEqual({ repaired: 0, copied: 1, excluded: 3 });
  expect(result.files[result.manifest.entries[2].outputPath!]).toEqual(new Uint8Array(digitized.buffer));
});

test('malformed, empty and oversized files do not prevent a healthy file from exporting', async ({ page }, info) => {
  await page.goto('./');
  const invalid: SelectedFile[] = [
    { name: 'empty.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(0) },
    { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') },
    { name: 'oversized.json', mimeType: 'application/json', buffer: Buffer.alloc(1024 * 1024 + 1, 32) },
    { name: 'large.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(12 * 1024 * 1024 + 1) },
    { name: 'duplicate-key.json', mimeType: 'application/json', buffer: Buffer.from('{"title":"x.jpg","title":"y.jpg"}') },
  ];
  await select(page, [photo('healthy.jpg'), sidecar('healthy.jpg.json', 'healthy.jpg'), ...invalid]);
  await review(page, 'f0006');
  await expect(page.getByTestId('review-panel')).toContainText('12 MiB');
  await expect(page.getByTestId('decision-keep')).toHaveCount(0);
  await page.getByTestId('close-review').click();
  await capture(page, info, 'invalid-files-audited');
  await prepare(page);
  const result = await download(page);
  expect(result.manifest.summary).toEqual({ repaired: 1, copied: 0, excluded: 6 });
  expect(result.manifest.entries.slice(2).every(entry => entry.status === 'invalid' && entry.outputPath === null)).toBe(true);
});

test('a sample above 200 files reports the limit and supports a clean subsequent selection', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('file-input').setInputFiles(Array.from({ length: 201 }, (_, index) => json(`file-${index}.json`, { title: `file-${index}.jpg` })));
  await expect(page.getByTestId('error-alert')).toContainText('200');
  await expect(page.getByTestId('download-zip')).toHaveCount(0);
  await select(page, [photo('recovered.jpg'), sidecar('recovered.jpg.json', 'recovered.jpg')]);
  await expect(page.getByTestId('error-alert')).toHaveCount(0);
  await prepare(page);
  expect((await download(page)).manifest.summary.repaired).toBe(1);
});

test('native folder selection keeps same basenames in separate folders and matches each capture source', async ({ page }, info) => {
  const directory = info.outputPath('synthetic-folders');
  for (const [name, seed, epoch] of [['one', 1, CAPTURE_EPOCH], ['two', 2, CAPTURE_EPOCH + 60]] as const) {
    const path = `${directory}/${name}`;
    await fs.mkdir(path, { recursive: true });
    await fs.writeFile(`${path}/photo.jpg`, photo('photo.jpg', seed).buffer);
    await fs.writeFile(`${path}/photo.jpg.json`, sidecar('photo.jpg.json', 'photo.jpg', epoch).buffer);
  }
  await page.goto('./');
  await page.getByTestId('folder-input').setInputFiles(directory);
  await expect(page.getByTestId('inventory-table').getByRole('row')).toHaveCount(5);
  await prepare(page);
  const result = await download(page);
  expect(result.manifest.summary).toEqual({ repaired: 2, copied: 0, excluded: 2 });
  const first = result.manifest.entries.find(row => /\/one\/photo\.jpg$/.test(row.sourcePath))!;
  const second = result.manifest.entries.find(row => /\/two\/photo\.jpg$/.test(row.sourcePath))!;
  expect(first.sidecarPath).toMatch(/\/one\/photo\.jpg\.json$/);
  expect(second.sidecarPath).toMatch(/\/two\/photo\.jpg\.json$/);
  expect(first.sidecarCaptureEpoch).toBe(CAPTURE_EPOCH);
  expect(second.sidecarCaptureEpoch).toBe(CAPTURE_EPOCH + 60);
  expect(first.outputPath).not.toBe(second.outputPath);
});

test('a batch above 64 MiB is rejected before inventory and a smaller batch remains usable', async ({ page }, info) => {
  const large = info.outputPath('synthetic-batch-over-64MiB.jpg');
  await fs.writeFile(large, Buffer.alloc(64 * 1024 * 1024 + 1));
  await page.goto('./');
  await page.getByTestId('file-input').setInputFiles(large);
  await expect(page.getByTestId('error-alert')).toContainText('64 MiB');
  await expect(page.getByTestId('inventory-table')).toHaveCount(0);
  await expect(page.getByTestId('download-zip')).toHaveCount(0);
  await select(page, [photo('small.jpg'), sidecar('small.jpg.json', 'small.jpg')]);
  await prepare(page);
  expect((await download(page)).manifest.summary.repaired).toBe(1);
});

test('filters and search expose specific evidence and reset for the next selection', async ({ page }) => {
  await page.goto('./');
  await select(page, [photo('first.jpg'), sidecar('first.jpg.json', 'first.jpg'), photo('needs-review.jpg', 1), json('orphan.json', { title: 'unselected.jpg' })]);
  await page.getByTestId('filter-json').click();
  await expect(page.getByTestId('inventory-table').getByRole('row')).toHaveCount(3);
  await page.getByTestId('search-input').fill('orphan');
  await expect(page.getByTestId('file-row-f0004')).toBeVisible();
  await expect(page.getByTestId('file-row-f0002')).toHaveCount(0);
  await page.getByTestId('search-input').fill('does-not-exist');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await select(page, [photo('second.jpg', 2), sidecar('second.jpg.json', 'second.jpg')]);
  await expect(page.getByTestId('search-input')).toHaveValue('');
  await expect(page.getByTestId('inventory-table').getByRole('row')).toHaveCount(3);
});

test('keyboard review, clear search and browser back preserve the reviewed dataset', async ({ page }) => {
  await page.goto('./');
  await select(page, [photo('keyboard.jpg')]);
  const panel = await review(page);
  await expect(panel).toBeFocused();
  await page.getByTestId('decision-keep').focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('decision-keep')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('review-panel')).toHaveCount(0);
  await expect(page.getByTestId('review-file-f0001')).toBeFocused();
  await page.getByTestId('search-input').fill('keyboard');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.getByTestId('search-input')).toHaveValue('');
  await expect(page.getByTestId('search-input')).toBeFocused();
  await page.getByTestId('nav-export').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/view=export/);
  await page.goBack();
  await expect(page.getByTestId('inventory-table')).toContainText('keyboard.jpg');
  await review(page);
  await expect(page.getByTestId('decision-keep')).toBeChecked();
  await page.getByTestId('close-review').click();
  await prepare(page);
  const result = await download(page);
  expect(result.manifest.summary).toEqual({ repaired: 0, copied: 1, excluded: 0 });
});

test('reselecting the same files resets policy and revokes stale output while canceling a picker preserves it', async ({ page }) => {
  await page.goto('./');
  const files = [photo('again.jpg'), sidecar('again.jpg.json', 'again.jpg')];
  await select(page, files);
  await prepare(page);
  const firstUrl = await page.getByTestId('download-zip').getAttribute('href');
  await page.getByTestId('file-input').setInputFiles([]);
  await expect(page.getByTestId('download-zip')).toHaveAttribute('href', firstUrl!);
  await select(page, files);
  await expect(page.getByTestId('download-zip')).toHaveCount(0);
  await page.getByTestId('nav-export').click();
  await expect(page.getByTestId('policy-ack')).not.toBeChecked();
  await expect(page.getByTestId('prepare-export')).toBeDisabled();
  await prepare(page);
  expect(await page.getByTestId('download-zip').getAttribute('href')).not.toBe(firstUrl);
  expect((await download(page)).manifest.summary.repaired).toBe(1);
});

test('newer selection replaces an in-flight preflight and never adopts its stale result', async ({ page }) => {
  await delayWorker(page, 'scan');
  await page.goto('./');
  await page.getByTestId('file-input').setInputFiles([photo('old.jpg'), sidecar('old.jpg.json', 'old.jpg')]);
  await expect(page.getByTestId('progress-panel')).toBeVisible();
  await select(page, [photo('new.jpg', 1), sidecar('new.jpg.json', 'new.jpg')]);
  await expect(page.getByTestId('inventory-table')).toContainText('new.jpg');
  await expect(page.getByTestId('inventory-table')).not.toContainText('old.jpg');
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('inventory-table')).not.toContainText('old.jpg');
  await prepare(page);
  expect((await download(page)).manifest.entries[0].sourcePath).toBe('new.jpg');
});

test('canceling export prevents a delayed ZIP and allows a fresh verified export', async ({ page }) => {
  await delayWorker(page, 'export');
  await page.goto('./');
  await select(page, [photo('cancel.jpg'), sidecar('cancel.jpg.json', 'cancel.jpg')]);
  await page.getByTestId('nav-export').click();
  await page.getByTestId('policy-ack').check();
  await page.getByTestId('prepare-export').click();
  await expect(page.getByTestId('progress-panel')).toBeVisible();
  await page.getByTestId('cancel-task').click();
  await expect(page.getByTestId('progress-panel')).toHaveCount(0);
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('download-zip')).toHaveCount(0);
  await expect(page.getByTestId('prepare-export')).toBeEnabled();
  await page.getByTestId('prepare-export').click();
  await expect(page.getByTestId('download-zip')).toBeVisible();
  expect((await download(page)).manifest.summary.repaired).toBe(1);
});

test('a local ZIP allocation failure is visible and retry succeeds without another import', async ({ page }) => {
  await page.goto('./');
  await select(page, [photo('allocation.jpg'), sidecar('allocation.jpg.json', 'allocation.jpg')]);
  await page.evaluate(() => {
    const original = URL.createObjectURL.bind(URL);
    let failed = false;
    URL.createObjectURL = object => {
      if (object instanceof Blob && object.type === 'application/zip' && !failed) {
        failed = true;
        throw new DOMException('Synthetic ZIP allocation failure', 'QuotaExceededError');
      }
      return original(object);
    };
  });
  await page.getByTestId('nav-export').click();
  await page.getByTestId('policy-ack').check();
  await page.getByTestId('prepare-export').click();
  await expect(page.getByTestId('error-alert')).toBeVisible();
  await expect(page.getByTestId('progress-panel')).toHaveCount(0);
  await expect(page.getByTestId('download-zip')).toHaveCount(0);
  await expect(page.getByTestId('prepare-export')).toBeEnabled();
  await page.getByTestId('prepare-export').click();
  await expect(page.getByTestId('download-zip')).toBeVisible();
  expect((await download(page)).manifest.summary.repaired).toBe(1);
});

test('a downloaded package remains usable offline and a second download has identical bytes', async ({ page, context }) => {
  await page.goto('./');
  await select(page, [photo('offline.jpg'), sidecar('offline.jpg.json', 'offline.jpg')]);
  await prepare(page);
  const first = await download(page);
  await context.setOffline(true);
  try {
    const second = await download(page);
    expect(hash(second.bytes)).toBe(hash(first.bytes));
    expect(second.manifest).toEqual(first.manifest);
  } finally { await context.setOffline(false); }
});

const localeCopy = {
  en: { sample: 'Try a synthetic sample', heading: 'Photo archive preflight' },
  ru: { sample: '', heading: '' },
  kk: { sample: '', heading: '' },
};

const workerLoadHint = 'The local processor could not run. Check the connection or choose a smaller sample. If this app was updated, refresh this page and import again. Originals stay untouched.';

for (const locale of ['en', 'ru', 'kk'] as const) {
  test(`focused worker load failure ${locale} shows a translated refresh hint and a later import succeeds`, async ({ page }) => {
    await page.addInitScript(() => {
      const OriginalWorker = window.Worker;
      let failNext = true;
      window.Worker = class extends OriginalWorker {
        failThisInstance: boolean;
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
          super(scriptURL, options);
          this.failThisInstance = failNext;
          failNext = false;
          if (this.failThisInstance) setTimeout(() => this.dispatchEvent(new Event('error')), 0);
        }
        override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
          if (this.failThisInstance) return;
          if (Array.isArray(options)) super.postMessage(message, options);
          else super.postMessage(message, options);
        }
      };
    });
    await page.goto('./');
    await page.getByTestId('locale-select').selectOption(locale);
    const files = [photo('worker-retry.jpg'), sidecar('worker-retry.jpg.json', 'worker-retry.jpg')];
    await page.getByTestId('file-input').setInputFiles(files);
    await expect(page.getByTestId('error-alert')).toContainText(t(locale, workerLoadHint));
    if (locale === 'en') await expect(page.getByTestId('error-alert')).toContainText('refresh this page');
    else await expect(page.getByTestId('error-alert')).not.toContainText('The local processor could not run');
    await expect(page.getByTestId('progress-panel')).toHaveCount(0);
    await expect(page.getByTestId('download-zip')).toHaveCount(0);
    await select(page, files);
    await expect(page.getByTestId('error-alert')).toHaveCount(0);
    await prepare(page);
    expect((await download(page)).manifest.summary.repaired).toBe(1);
  });

  test(`focused privacy popup ${locale} is translated and keeps inventory and decisions in the archive tab`, async ({ page }, info) => {
    await page.goto('./');
    await page.getByTestId('locale-select').selectOption(locale);
    await select(page, [photo('privacy-preserved.jpg')]);
    await review(page);
    await page.getByTestId('decision-keep').check();
    await page.getByTestId('close-review').click();
    const waiting = page.waitForEvent('popup');
    await page.locator('a[href*="privacy.html"]').first().click();
    const popup = await waiting;
    const record = telemetry.get(page)!;
    popup.on('pageerror', error => record.errors.push('privacy popup: ' + error.message));
    popup.on('request', request => {
      const url = request.url();
      if (!url.startsWith(new URL(page.url()).origin + '/') && !url.startsWith('blob:') && !url.startsWith('data:')) record.outbound.push('privacy popup: ' + url);
      if (!['GET', 'HEAD'].includes(request.method()) || request.postData()) record.outbound.push('privacy popup: ' + request.method() + ' ' + url);
    });
    await expect(popup.locator('html')).toHaveAttribute('lang', locale);
    await expect(popup.getByRole('heading', { level: 1 })).toHaveText(t(locale, 'Your archive stays on your device.'));
    await expect(popup.getByRole('heading', { name: t(locale, 'Safe copies and GPS'), exact: true })).toBeVisible();
    await assertNoDocumentOverflow(popup);
    await capture(popup, info, 'privacy');
    const nextLocale = locale === 'en' ? 'kk' : 'en';
    await popup.getByTestId('locale-select').selectOption(nextLocale);
    await expect(page.getByTestId('locale-select')).toHaveValue(nextLocale);
    await expect(page.getByTestId('inventory-table')).toContainText('privacy-preserved.jpg');
    await popup.close();
    await review(page);
    await expect(page.getByTestId('decision-keep')).toBeChecked();
    await page.getByTestId('close-review').click();
    await prepare(page);
    expect((await download(page)).manifest.summary).toEqual({ repaired: 0, copied: 1, excluded: 0 });
  });

  test(`focused 200 percent CSS zoom ${locale} keeps review and export controls usable at 768 and 1440`, async ({ page }, info) => {
    for (const width of [768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('./');
      await page.getByTestId('locale-select').selectOption(locale);
      await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
      await assertNoDocumentOverflow(page);
      const languageBounds = await page.getByTestId('locale-select').boundingBox();
      expect(languageBounds!.x + languageBounds!.width).toBeLessThanOrEqual(width + 1);
      const privacyContents = await page.locator('a[href*="privacy.html"]').first().evaluate(link => [link, ...link.querySelectorAll('span,svg')].map(element => element.getBoundingClientRect().right));
      expect(Math.max(...privacyContents), 'Privacy link text and arrow must remain visible instead of being clipped').toBeLessThanOrEqual(width + 1);
      await select(page, [photo('zoomed-review.jpg')]);
      await review(page);
      await page.getByTestId('decision-keep').check();
      await assertNoDocumentOverflow(page);
      await page.getByTestId('close-review').click();
      await prepare(page);
      await assertNoDocumentOverflow(page);
      const bounds = await page.getByTestId('download-zip').boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      await capture(page, info, `zoom200-${width}`);
      expect((await download(page)).manifest.summary.copied).toBe(1);
    }
  });
}

test('focused blocked preference storage keeps all three choices usable in the tab and safely defaults on reload', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException('Synthetic blocked storage', 'SecurityError'); };
    Storage.prototype.setItem = () => { throw new DOMException('Synthetic blocked storage', 'SecurityError'); };
  });
  await page.goto('./');
  await expect(page.getByTestId('locale-select')).toHaveValue('en');
  await select(page, [photo('blocked-preference.jpg')]);
  for (const locale of ['en', 'ru', 'kk'] as const) {
    await page.getByTestId('locale-select').selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('.storage-note')).toContainText(t(locale, 'Language preference could not be saved; it still applies in this tab.'));
    await expect(page.getByTestId('inventory-table')).toContainText('blocked-preference.jpg');
  }
  await review(page);
  await page.getByTestId('decision-keep').check();
  await page.getByTestId('close-review').click();
  await prepare(page);
  expect((await download(page)).manifest.summary.copied).toBe(1);
  await page.reload();
  await expect(page.getByTestId('locale-select')).toHaveValue('en');
  await expect(page.getByTestId('inventory-table')).toHaveCount(0);
});

test('focused invalid preference key safely defaults and only the chosen locale persists after archive reload', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.setItem('archiveguard.locale', '<script>invalid-locale</script>'));
  await page.reload();
  await expect(page.getByTestId('locale-select')).toHaveValue('en');
  await page.getByTestId('locale-select').selectOption('kk');
  await select(page, [photo('not-persisted.jpg')]);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['archiveguard.locale']);
  await page.reload();
  await expect(page.getByTestId('locale-select')).toHaveValue('kk');
  await expect(page.getByTestId('inventory-table')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('archiveguard.locale'))).toBe('kk');
});

for (const locale of ['en', 'ru', 'kk'] as const) {
  test(`locale ${locale} persists, preserves review decisions, and reports retain stable schema`, async ({ page }) => {
    await page.goto('./');
    await page.getByTestId('locale-select').selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    if (localeCopy[locale].heading) await expect(page.getByRole('heading', { level: 1 })).toHaveText(localeCopy[locale].heading);
    await page.reload();
    await expect(page.getByTestId('locale-select')).toHaveValue(locale);
    await select(page, [photo('localization.jpg'), sidecar('localization.jpg.json', 'localization.jpg')]);
    await expect(page.locator('.session-bar > div > span')).toContainText(/\b(?:0[.,]\d*[1-9]\d*|[1-9]\d*(?:[.,]\d+)?)\s+KiB\b/);
    await expect(page.locator('.session-bar > div > span')).not.toContainText(/\b0(?:[.,]0+)?\s+(?:MiB|KiB)\b/);
    await review(page);
    await page.getByTestId('decision-keep').check();
    await page.getByTestId('locale-select').selectOption(locale === 'en' ? 'ru' : 'en');
    await expect(page.getByTestId('decision-keep')).toBeChecked();
    await page.getByTestId('locale-select').selectOption(locale);
    await page.getByTestId('close-review').click();
    await prepare(page);
    const result = await download(page);
    expect(result.manifest).toMatchObject({ schemaVersion: 1, product: 'ArchiveGuard', summary: { repaired: 0, copied: 1, excluded: 1 } });
    expect(strFromU8(result.files['audit.csv'])).toContain('"sourceSha256"');
    expect(strFromU8(result.files['audit.html'])).toContain(`lang="${locale}"`);
  });

  for (const width of [320, 360, 390, 414, 768, 1280, 1440]) {
    test(`locale ${locale} controls fit viewport ${width} in portrait and landscape with long filenames`, async ({ page }, info) => {
      const height = width >= 1280 ? 900 : width === 768 ? 1024 : 844;
      const longName = 'Synthetic archive photo with a deliberately long descriptive filename ' + 'ә'.repeat(30) + '.jpg';
      const files = [photo(longName), sidecar(longName + '.json', longName), photo('review-only.jpg', 1)];
      for (const size of [{ width, height }, { width: height, height: width }]) {
        await page.setViewportSize(size);
        await page.goto('./');
        await page.getByTestId('locale-select').selectOption(locale);
        await assertNoDocumentOverflow(page);
        await capture(page, info, `${size.width}x${size.height}-initial`);
        await select(page, files);
        await assertNoDocumentOverflow(page);
        await assertKeyboardScrollableTable(page);
        await review(page, 'f0003');
        await expect(page.getByTestId('decision-repair')).toBeDisabled();
        await page.getByTestId('decision-keep').check();
        await assertNoDocumentOverflow(page);
        const bounds = await page.getByTestId('decision-keep').boundingBox();
        expect(bounds).not.toBeNull();
        const targetHeight = await page.getByTestId('decision-keep').evaluate(control => (control.closest('label') || control).getBoundingClientRect().height);
        expect(targetHeight).toBeGreaterThanOrEqual(44);
        await capture(page, info, `${size.width}x${size.height}-review`);
        await page.getByTestId('close-review').click();
        await prepare(page, '-210');
        await assertNoDocumentOverflow(page);
        const downloadBounds = await page.getByTestId('download-zip').boundingBox();
        expect(downloadBounds!.x).toBeGreaterThanOrEqual(0);
        expect(downloadBounds!.x + downloadBounds!.width).toBeLessThanOrEqual(size.width + 1);
        expect(downloadBounds!.height).toBeGreaterThanOrEqual(44);
        await capture(page, info, `${size.width}x${size.height}-export`);
        const result = await download(page);
        expect(result.manifest.summary).toEqual({ repaired: 1, copied: 1, excluded: 1 });
        expect(result.manifest.entries[0].sourcePath).toBe(longName);
      }
    });
  }
}

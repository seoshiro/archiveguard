import { defineConfig } from '@playwright/test';
const baseURL = process.env.ARCHIVEGUARD_BASE_URL || 'http://127.0.0.1:4318/';
export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts', fullyParallel: false, workers: 1,
  timeout: 45000, expect: { timeout: 10000 }, reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL, headless: true, channel: process.env.ARCHIVEGUARD_BROWSER_CHANNEL || 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: process.env.ARCHIVEGUARD_BASE_URL || process.platform === 'win32' ? undefined : { command: 'node scripts/serve.mjs', url: baseURL, reuseExistingServer: !process.env.CI, timeout: 20000 },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});

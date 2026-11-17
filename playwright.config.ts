import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: { timeout: 7_000 },
  workers: 1,
  reporter: 'list',
  projects: [
    { name: 'unit', testMatch: /unit\.spec\.ts/ },
    { name: 'chromium-extension', testMatch: /extension\.spec\.ts/ },
  ],
});

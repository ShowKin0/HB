import { defineConfig } from '@playwright/test'

/**
 * 开发模式端到端验证。
 *
 * 编辑器只在 DEV 构建里存在（见 src/App.tsx 的路由判断）；
 * StrictMode 的双挂载泄漏同样只在 DEV 出现。这两类检查都跑 dev server。
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['**/editor.spec.ts', '**/dev.spec.ts', '**/editorLoss.spec.ts'],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5199',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'npm run ink:build && npx vite --port 5199 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})

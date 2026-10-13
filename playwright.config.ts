import { defineConfig, devices } from '@playwright/test'

/**
 * 端到端验证。
 *
 * 走的是**生产构建产物**（vite build + vite preview），而不是开发服务器，
 * 这样首包体积、代码压缩、资源路径这些只有上线才会暴露的问题都能覆盖到。
 */
export default defineConfig({
  testDir: './tests/e2e',
  // 编辑器与 StrictMode 泄漏检查都跑在 dev server 上，由 playwright.editor.config.ts 负责。
  // dev.spec 必须在这里也排除：它测的是只在 DEV 出现的行为，
  // 在生产构建上跑永远通过，属于无效绿灯。
  testIgnore: ['**/editor.spec.ts', '**/dev.spec.ts'],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mobile-safari-like',
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    // --host 127.0.0.1 是必需的：Windows 上 localhost 可能解析到 ::1，
    // 而 Playwright 的就绪探测走 IPv4，端口对不上就会一直等到超时。
    command: 'npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})

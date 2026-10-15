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
  /*
   * 编辑器与检查器只存在于 DEV 构建（见 src/App.tsx 的路由判断），
   * 在生产构建上跑永远通过，属于无效绿灯。**新增编辑器用例必须加到这里**，
   * 否则它会在生产配置里失败（而不是被跳过）。
   */
  testIgnore: ['**/editor.spec.ts', '**/editorLoss.spec.ts', '**/dev.spec.ts'],
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
    /*
     * 主要验收机型。
     *
     * Playwright 内置的 `iPhone 14 landscape` 是 750×340 —— 偏保守。
     * 真实 iPhone 14 横屏的 CSS 视口是 **844×390**（全屏/PWA，或 Safari
     * 工具栏收起），工具栏展开时约 **844×346**。
     *
     * 取 844×346：既是最常见的使用状态，也是更紧的那个约束 ——
     * 屏高越小，对话浮层与场景争抢得越厉害，拿它当基准更安全。
     */
    {
      name: 'iphone14-landscape',
      use: {
        ...devices['iPhone 14 landscape'],
        viewport: { width: 844, height: 346 },
      },
    },
    /*
     * 竖屏：**只**验证横屏引导本身。
     *
     * 这个游戏以横屏为主要形态，竖屏下会盖一层"请把手机横过来"并暂停模拟。
     * 玩法用例在竖屏必然点不动 —— 那不是回归，是设计。所以这里只跑
     * orientation.spec.ts，其余用例交给横屏项目。
     */
    {
      name: 'iphone14-portrait',
      testMatch: ['**/orientation.spec.ts'],
      use: { ...devices['iPhone 14'] },
    },
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        // 暴露 gc()：内存测试要先强制回收再量，否则测的只是垃圾还没被收的噪声
        launchOptions: { args: ['--js-flags=--expose-gc'] },
      },
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

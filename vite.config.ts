import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    /**
     * 构建产物放到 _bundle/ 而不是默认的 assets/。
     *
     * 原因是 public/assets/ 会被原样拷进 dist/assets/，两者撞在同一个目录里。
     * 而它们的缓存策略必须相反：构建产物带内容哈希、可以永久缓存；
     * 你自己放的素材没有哈希、必须每次校验。分开目录才谈得上分别配置。
     */
    assetsDir: '_bundle',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        /**
         * 把体积大且几乎不会变的依赖拆成独立 chunk。
         *
         * 两个好处：
         *   1. 并行下载与解析，首屏更快
         *   2. 改剧情/改代码时这几个 chunk 的哈希不变，回访直接命中缓存
         *
         * 拆完之后构建日志会分别报出每个库的体积，也顺带当成体积监控。
         */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules[/\\](react|react-dom|scheduler)[/\\]/.test(id)) return 'react'
          if (/node_modules[/\\]inkjs[/\\]/.test(id)) return 'ink'
          if (/node_modules[/\\]zod[/\\]/.test(id)) return 'schema'
          if (/node_modules[/\\]howler[/\\]/.test(id)) return 'audio'
          return undefined
        },
      },
    },
  },
})

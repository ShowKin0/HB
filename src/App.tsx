import { lazy, Suspense, useEffect } from 'react'
import { GameShell } from './ui/GameShell.tsx'
import { ErrorBoundary } from './ui/ErrorBoundary.tsx'
import { installGlobalErrorReporting } from './ui/reportError.ts'

/**
 * 开发模式下访问 /edit 进入场景编辑器；其余情况一律是游戏本体。
 *
 * ⚠️ 这里**必须用动态 import**，不能静态 import。
 *
 * 静态 import 时，即使渲染被 `import.meta.env.DEV` 挡住，打包器也只会摇掉
 * 编辑器自身的代码 —— 它的**依赖链**（Editor → schema/scene.ts → zod）
 * 会因为 zod 顶层的类定义"看起来有副作用"而整个留下来。
 * 结果就是生产首包白背 26 kB gzip，而所有"编辑器代码在不在包里"的字符串检查
 * 都查不出来，因为编辑器代码本身确实被摇掉了。
 *
 * 用 `import.meta.env.DEV ? lazy(...) : null` 之后，生产构建里这一整个三元
 * 会折叠成 null，动态 import 落在死分支里，chunk 根本不会被生成。
 */
const EditorLazy = import.meta.env.DEV
  ? lazy(async () => {
      const mod = await import('./editor/Editor.tsx')
      return { default: mod.Editor }
    })
  : null

function isEditorRoute(): boolean {
  return window.location.pathname.replace(/\/+$/, '') === '/edit'
}

export default function App(): React.ReactElement {
  /*
   * 异步错误不走错误边界（它只接渲染期异常），必须自己接。
   * 装在应用根上，保证任何路径下都生效。
   */
  useEffect(() => {
    installGlobalErrorReporting()
  }, [])

  const content =
    EditorLazy && isEditorRoute() ? (
      <Suspense fallback={null}>
        <EditorLazy />
      </Suspense>
    ) : (
      <GameShell />
    )

  // 兜底：渲染期抛错时不白屏（React 19 默认会卸载整棵树）
  return <ErrorBoundary>{content}</ErrorBoundary>
}

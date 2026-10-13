import { parseDirective, parseDirectiveArgs, type RawDirective } from '../../schema/directive.rules.ts'

/**
 * 演出指令注册表。
 *
 * 剧本里写成 `# name: value`，引擎按名字查表执行。**新增演出效果不需要
 * 改引擎**，只要注册一个处理器，然后在 .ink 里写标签即可。
 */
export interface DirectiveContext {
  /** 当前场景 id。 */
  readonly sceneId: string | null
  setScene(id: string): void
  /** 临时替换当前场景的背景图；null 表示恢复场景自带的背景。 */
  setBackground(path: string | null): void
  setPortrait(id: string | null): void
  setSpeaker(name: string | null): void
  playBgm(path: string, fadeSeconds: number): void
  stopBgm(fadeSeconds: number): void
  playSfx(path: string): void
  playVo(path: string): void
  runFx(name: string, args: string[]): void
  wait(seconds: number): Promise<void>
  /** 给角色下达指令，如 actor: hero -> walkTo(0.3, 0.7)。 */
  actorCommand(actorId: string, command: string, args: string[]): void
  /** 挂起剧情，运行一个小游戏，返回它的结果。 */
  runMiniGame(id: string, args: string[]): Promise<unknown>
  setFlag(key: string, value: string | number | boolean): void
  award(itemId: string): void
  unlock(id: string): void
  log(message: string): void
}

export type DirectiveHandler = (
  value: string,
  args: string[],
  ctx: DirectiveContext,
) => void | Promise<void>

const handlers = new Map<string, DirectiveHandler>()

export function registerDirective(name: string, handler: DirectiveHandler): void {
  handlers.set(name, handler)
}

export function getDirective(name: string): DirectiveHandler | undefined {
  return handlers.get(name)
}

export function listDirectives(): string[] {
  return [...handlers.keys()].sort()
}

/** 解析 tag 列表并逐条执行。未知指令只记日志，不阻断流程。 */
export async function applyDirectives(
  tags: readonly string[],
  ctx: DirectiveContext,
): Promise<void> {
  for (const tag of tags) {
    const parsed = parseDirective(tag)
    if (!parsed) continue
    const handler = handlers.get(parsed.name)
    if (!handler) {
      ctx.log(`未知演出指令 "${parsed.name}"（原文：${parsed.raw}）`)
      continue
    }
    try {
      await handler(parsed.value, parseDirectiveArgs(parsed.value), ctx)
    } catch (error) {
      ctx.log(`指令 "${parsed.name}" 执行失败：${(error as Error).message}`)
    }
  }
}

/** 便于指令处理器复用：把 "0.5" 解析成数字并夹紧。 */
export function numberArg(args: string[], index: number, fallback: number): number {
  const raw = args[index]
  if (raw === undefined) return fallback
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : fallback
}

export type { RawDirective }

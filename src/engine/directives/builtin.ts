import { numberArg, registerDirective } from './registry.ts'

/**
 * 内置演出指令。
 *
 * 这里只实现"引擎能力"，不含任何具体剧情。指令清单：
 *
 *   # bg: bg/room_night.avif      切换背景（不换场景）
 *   # bgm: bgm/theme.ogg          播放背景乐，第二个参数是淡入秒数
 *   # bgm: none                   停止背景乐
 *   # sfx: sfx/box_open.ogg       播放音效
 *   # vo: line_042                播放配音，按 line_id 找文件
 *   # portrait: expr_smile        切换立绘
 *   # speaker: 她                  设置说话人
 *   # fx: shake(0.3)              触发画面效果
 *   # wait: 0.5                   等待若干秒（会暂停剧情推进）
 *   # scene: hall                 切换场景
 *   # flag: met_her = true        设置引擎侧标记
 *   # award: item_key             获得物品
 *   # unlock: door_open           标记解锁
 *   # actor: hero walkTo(0.3,0.7) 给角色下达指令
 *   # minigame: tapSequence(3)     挂起剧情运行小游戏，结果写回 minigame_success / minigame_skipped
 */
export function registerBuiltinDirectives(): void {
  registerDirective('bg', (value, _args, ctx) => {
    ctx.setBackground(value === 'none' || value === '' ? null : value)
  })

  registerDirective('bgm', (value, args, ctx) => {
    const fade = numberArg(args, 1, 1.2)
    if (value === 'none' || value === '') ctx.stopBgm(fade)
    else ctx.playBgm(value, fade)
  })

  registerDirective('sfx', (value, _args, ctx) => {
    if (value) ctx.playSfx(value)
  })

  registerDirective('vo', (value, _args, ctx) => {
    if (value) ctx.playVo(value)
  })

  registerDirective('portrait', (value, _args, ctx) => {
    ctx.setPortrait(value === 'none' || value === '' ? null : value)
  })

  registerDirective('speaker', (value, _args, ctx) => {
    ctx.setSpeaker(value === '' ? null : value)
  })

  registerDirective('fx', (value, args, ctx) => {
    const [name, ...rest] = args
    if (name) ctx.runFx(name, rest)
    else if (value) ctx.runFx(value, [])
  })

  registerDirective('wait', (value, args, ctx) => {
    return ctx.wait(Math.max(0, numberArg(args, 0, Number.parseFloat(value) || 0)))
  })

  registerDirective('scene', (value, _args, ctx) => {
    if (value) ctx.setScene(value)
  })

  registerDirective('flag', (value, _args, ctx) => {
    // 支持 "key" 与 "key = value" 两种写法
    const eq = value.indexOf('=')
    if (eq === -1) {
      ctx.setFlag(value.trim(), true)
      return
    }
    const key = value.slice(0, eq).trim()
    const raw = value.slice(eq + 1).trim()
    ctx.setFlag(key, coerce(raw))
  })

  registerDirective('award', (value, _args, ctx) => {
    if (value) ctx.award(value)
  })

  registerDirective('unlock', (value, _args, ctx) => {
    if (value) ctx.unlock(value)
  })

  registerDirective('actor', (value, _args, ctx) => {
    // 形如 "hero walkTo(0.3, 0.7)" 或 "hero stop"
    const match = /^([A-Za-z0-9_-]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\((.*)\))?$/.exec(value.trim())
    if (!match) {
      ctx.log(`actor 指令格式应为 "<id> <命令>(<参数>)"，收到："${value}"`)
      return
    }
    const [, actorId, command, argText = ''] = match
    const args = argText
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    ctx.actorCommand(actorId, command, args)
  })

  registerDirective('minigame', async (value, args, ctx) => {
    // 形如 "tapSequence(3)" 或 "tapSequence(3, 500)"
    const [id, ...rest] = args
    if (!id) {
      ctx.log(`minigame 指令需要一个 id，收到："${value}"`)
      return
    }
    await ctx.runMiniGame(id, rest)
  })
}

function coerce(raw: string): string | number | boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  const n = Number.parseFloat(raw)
  if (Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(raw)) return n
  return raw
}

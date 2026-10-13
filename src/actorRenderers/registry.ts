import type { ActorSpec } from '../schema/scene.ts'
import type { AssetStore } from '../engine/assets.ts'
import { glideRenderer } from './glide.ts'
import { partRigRenderer } from './partRig.ts'
import { spriteSheetRenderer } from './spriteSheet.ts'
import type { ActorRenderer } from './types.ts'

/**
 * 角色渲染器注册表。
 *
 * 引擎完全不知道角色长什么样 —— 它只认这个接口。要换画风、接入
 * Rive / Spine，或者自己写一套部件图，都只需要在这里注册一行，
 * 场景 JSON 里的 `renderer` 字段换成新 id 即可。
 */
const registry = new Map<string, ActorRenderer>()

export function registerActorRenderer(renderer: ActorRenderer): void {
  registry.set(renderer.id, renderer)
}

/**
 * 取渲染器。未注册的 id 一律退到部件骨架 —— 因为它不依赖任何素材，
 * 是唯一保证"一定有角色可看"的实现。
 */
export function getActorRenderer(id: string): ActorRenderer {
  return registry.get(id) ?? partRigRenderer
}

export function listActorRenderers(): string[] {
  return [...registry.keys()].sort()
}

/** 准备该角色需要的素材。程序化渲染器不需要任何素材，直接返回 undefined。 */
export async function prepareActorRenderer(spec: ActorSpec, assets: AssetStore): Promise<unknown> {
  const renderer = getActorRenderer(spec.renderer)
  return renderer.prepare ? renderer.prepare(spec, assets) : undefined
}

registerActorRenderer(partRigRenderer)
registerActorRenderer(glideRenderer)
registerActorRenderer(spriteSheetRenderer)

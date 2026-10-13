import type { MiniGame } from './types.ts'
import { tapSequence } from './tapSequence.ts'

const registry = new Map<string, MiniGame<never, never>>()

export function registerMiniGame<P, R>(game: MiniGame<P, R>): void {
  registry.set(game.id, game as unknown as MiniGame<never, never>)
}

export function getMiniGame(id: string): MiniGame<never, never> | undefined {
  return registry.get(id)
}

export function listMiniGames(): { id: string; title: string; hint?: string }[] {
  return [...registry.values()]
    .map((game) => ({ id: game.id, title: game.title, hint: game.hint }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

registerMiniGame(tapSequence)

import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

export const CONTENT_DIR = path.join(ROOT, 'content')
export const SCENES_DIR = path.join(CONTENT_DIR, 'scenes')
export const STORY_DIR = path.join(CONTENT_DIR, 'story')
export const VOICE_CSV = path.join(CONTENT_DIR, 'voice-lines.csv')

export const PUBLIC_DIR = path.join(ROOT, 'public')
export const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets')
export const MANIFEST_FILE = path.join(CONTENT_DIR, 'assets.manifest.json')

/** 相对 ROOT 的展示路径，让报错信息短一点。 */
export function rel(p: string): string {
  return path.relative(ROOT, p).replace(/\\/g, '/')
}

import { describe, expect, it } from 'vitest'
import { emptyEngineState, migrateSave, SAVE_VERSION, type Save } from '../src/schema/save.ts'

/**
 * `saveCompatibility` 的读写。
 *
 * 这个字段曾经是"声明了、校验了、归一化了、README 也承诺了，但全仓无人读"——
 * 改成任何值都零行为差异。要让它真的参与判断，前提是它得先被**写进存档**，
 * 否则读档时永远拿不到作者写这份存档时的意图。
 */
function saveWith(extra: Record<string, unknown>): unknown {
  return {
    saveVersion: SAVE_VERSION,
    createdAt: 1000,
    updatedAt: 2000,
    label: '存档',
    contentVersion: 'abc-def',
    inkState: '{}',
    engine: emptyEngineState('start'),
    ...extra,
  }
}

describe('saveCompatibility 会随存档一起走', () => {
  it('写进去的值能原样读回来', () => {
    const parsed = migrateSave(saveWith({ saveCompatibility: '2' }))
    expect(parsed?.saveCompatibility).toBe('2')
  })

  it('老存档没有这个字段时读成空串，而不是"不匹配"', () => {
    const parsed = migrateSave(saveWith({}))
    expect(parsed).not.toBeNull()
    expect(
      parsed!.saveCompatibility,
      '缺字段被当成某个具体值的话，所有老存档读档时都会报"内容不匹配"',
    ).toBe('')
  })

  it('字段是脏数据时也退回空串，不拖垮整份存档', () => {
    for (const bad of [42, null, { a: 1 }, ['1']]) {
      const parsed = migrateSave(saveWith({ saveCompatibility: bad }))
      expect(parsed, `saveCompatibility=${JSON.stringify(bad)} 把整份存档判死了`).not.toBeNull()
      expect(parsed!.saveCompatibility).toBe('')
    }
  })

  it('类型上就是必填 —— 写入方漏了就编译不过', () => {
    const payload: Save = {
      saveVersion: SAVE_VERSION,
      createdAt: 1,
      updatedAt: 2,
      label: 'l',
      contentVersion: 'c',
      saveCompatibility: '1',
      inkState: '{}',
      engine: emptyEngineState('start'),
    }
    expect(migrateSave(payload)?.saveCompatibility).toBe('1')
  })
})

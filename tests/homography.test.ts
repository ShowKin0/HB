import { describe, expect, it } from 'vitest'
import {
  type Pt,
  identityHomography,
  invert,
  isAffine,
  localScale,
  project,
  solveHomography,
  unproject,
  UNIT_SQUARE,
} from '../src/render/homography.ts'

/** 轴对齐矩形：透视项应为 0，退化为仿射。 */
const RECT: readonly [Pt, Pt, Pt, Pt] = [
  [0.1, 0.6],
  [0.9, 0.6],
  [0.9, 0.98],
  [0.1, 0.98],
]

/** 上窄下宽的梯形：真实透视照片里最常见的形状。 */
const TRAPEZOID: readonly [Pt, Pt, Pt, Pt] = [
  [0.2, 0.5],
  [0.8, 0.5],
  [0.95, 0.95],
  [0.05, 0.95],
]

function close(actual: number, expected: number, digits = 6): void {
  expect(actual).toBeCloseTo(expected, digits)
}

describe('solveHomography', () => {
  it('单位正方形得到恒等变换', () => {
    const h = solveHomography(UNIT_SQUARE)
    expect(h).not.toBeNull()
    const [x, y] = project(h!, 0.37, 0.62)
    close(x, 0.37)
    close(y, 0.62)
    close(localScale(h!, 0.5, 0.5), 1)
  })

  it('矩形四角退化为仿射变换', () => {
    const h = solveHomography(RECT)
    expect(h).not.toBeNull()
    expect(isAffine(h!)).toBe(true)
  })

  it('梯形保留透视项', () => {
    const h = solveHomography(TRAPEZOID)
    expect(h).not.toBeNull()
    expect(isAffine(h!)).toBe(false)
  })

  it('四点共线时返回 null', () => {
    const line: readonly [Pt, Pt, Pt, Pt] = [
      [0.1, 0.1],
      [0.3, 0.3],
      [0.6, 0.6],
      [0.9, 0.9],
    ]
    expect(solveHomography(line)).toBeNull()
  })
})

describe('project', () => {
  it('把四角映射到指定位置', () => {
    const h = solveHomography(TRAPEZOID)!
    for (let i = 0; i < 4; i++) {
      const [u, v] = UNIT_SQUARE[i]
      const [x, y] = project(h, u, v)
      close(x, TRAPEZOID[i][0], 9)
      close(y, TRAPEZOID[i][1], 9)
    }
  })

  it('矩形场景下平面中线落在场景中线上', () => {
    const h = solveHomography(RECT)!
    const [x, y] = project(h, 0.5, 0.5)
    close(x, 0.5)
    close(y, 0.79)
  })
})

describe('localScale', () => {
  it('矩形场景下处处相等', () => {
    const h = solveHomography(RECT)!
    const a = localScale(h, 0.2, 0.1)
    const b = localScale(h, 0.9, 0.9)
    close(a, b, 9)
    close(a, Math.sqrt(0.8 * 0.38), 9)
  })

  it('梯形场景下后远小于前，实现近大远小', () => {
    const h = solveHomography(TRAPEZOID)!
    const back = localScale(h, 0.5, 0.05)
    const front = localScale(h, 0.5, 0.95)
    expect(front).toBeGreaterThan(back * 1.5)
  })
})

describe('unproject', () => {
  it('与 project 互为逆运算', () => {
    const h = solveHomography(TRAPEZOID)!
    for (const [u, v] of [
      [0.1, 0.1],
      [0.5, 0.5],
      [0.9, 0.9],
      [0.25, 0.75],
    ]) {
      const [x, y] = project(h, u, v)
      const back = unproject(h, x, y)
      expect(back).not.toBeNull()
      close(back![0], u, 6)
      close(back![1], v, 6)
    }
  })
})

describe('invert', () => {
  it('逆矩阵与投影复合得到恒等', () => {
    const h = solveHomography(RECT)!
    const inv = invert(h)
    expect(inv).not.toBeNull()
    const x = project(inv!, ...project(h, 0.42, 0.73))
    close(x[0], 0.42, 9)
    close(x[1], 0.73, 9)
  })

  it('恒等矩阵的逆是自身', () => {
    const inv = invert(identityHomography())
    expect(inv).not.toBeNull()
    expect([...inv!.m]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
  })
})

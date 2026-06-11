/**
 * 歧义澄清单测（规格 §5.7）
 */
import { describe, expect, it } from 'vitest'
import type { SceneObject } from '../engine/scene'
import { buildAmbiguityClarify, matchExpecting } from './clarify'

function circle(id: string, x: number, y: number, fill?: string): SceneObject {
  return { id, shape: 'circle', x, y, radius: 40, fill, rotation: 0, z: 1, createdSeq: 1 }
}

describe('buildAmbiguityClarify', () => {
  it('颜色可区分：列举颜色名，expecting 带对象 id', () => {
    const plan = buildAmbiguityClarify([circle('circle#1', 200, 300, '#FF4136'), circle('circle#2', 600, 300, '#0074D9')])
    expect(plan.kind).toBe('choices')
    if (plan.kind === 'choices') {
      expect(plan.question).toBe('有红色和蓝色两个圆，要哪个？')
      expect(plan.expecting).toEqual([
        { label: '红色', id: 'circle#1' },
        { label: '蓝色', id: 'circle#2' },
      ])
    }
  })

  it('颜色相同 → 按位置区分（左右），expecting 按 x 排序', () => {
    const plan = buildAmbiguityClarify([circle('circle#2', 700, 300, '#FF4136'), circle('circle#1', 200, 300, '#FF4136')])
    expect(plan.kind).toBe('choices')
    if (plan.kind === 'choices') {
      expect(plan.question).toBe('左边的还是右边的？')
      expect(plan.expecting).toEqual([
        { label: '左边', id: 'circle#1' },
        { label: '右边', id: 'circle#2' },
      ])
    }
  })

  it('垂直分布 → 上下；三个候选 → 含中间', () => {
    const v = buildAmbiguityClarify([circle('a', 300, 100, '#FF4136'), circle('b', 300, 600, '#FF4136')])
    if (v.kind === 'choices') expect(v.expecting.map((e) => e.label)).toEqual(['上面', '下面'])
    const three = buildAmbiguityClarify([
      circle('a', 100, 300, '#FF4136'),
      circle('b', 500, 300, '#FF4136'),
      circle('c', 900, 300, '#FF4136'),
    ])
    if (three.kind === 'choices') expect(three.expecting.map((e) => e.label)).toEqual(['左边', '中间', '右边'])
  })

  it('无名颜色（任意 hex）回退位置区分', () => {
    const plan = buildAmbiguityClarify([circle('a', 200, 300, '#ABCDEF'), circle('b', 600, 300, '#123456')])
    if (plan.kind === 'choices') expect(plan.expecting.map((e) => e.label)).toEqual(['左边', '右边'])
  })

  it('候选 >3：提示说具体，不开快匹配窗口', () => {
    const plan = buildAmbiguityClarify([
      circle('a', 100, 100, '#FF4136'),
      circle('b', 300, 100, '#0074D9'),
      circle('c', 500, 100, '#2ECC40'),
      circle('d', 700, 100, '#FFDC00'),
    ])
    expect(plan.kind).toBe('too-many')
    if (plan.kind === 'too-many') expect(plan.question).toContain('4 个圆')
  })
})

describe('matchExpecting（包含匹配，唯一命中才算）', () => {
  const expecting = [
    { label: '红色', id: 'a' },
    { label: '蓝色', id: 'b' },
  ]

  it('"红色的"/"要红色" → 命中红色', () => {
    expect(matchExpecting('红色的', expecting)?.id).toBe('a')
    expect(matchExpecting('要红色那个', expecting)?.id).toBe('a')
  })

  it('未命中 / 同时命中多个 → null', () => {
    expect(matchExpecting('大的那个', expecting)).toBeNull()
    expect(matchExpecting('红色和蓝色都行', expecting)).toBeNull()
  })
})

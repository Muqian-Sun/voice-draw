/**
 * 流式 Op 提取器单测（协议 v1.4）：任意切片下增量产出完整 Op。
 */
import { describe, expect, it } from 'vitest'
import { OpStreamExtractor } from './streamOps'

const SAMPLE =
  '{"intent":"ops","confidence":0.9,"ops":[' +
  '{"op":"create","shape":"circle","name":"头{含括号}","size":80},' +
  '{"op":"create","shape":"text","text":"引号\\"和\\\\转义","at":{"x":1,"y":2}},' +
  '{"op":"move","target":{"byName":"头{含括号}"},"delta":[60,0]}' +
  '],"say":"好了"}'

function feedInChunks(text: string, size: number) {
  const ex = new OpStreamExtractor()
  const ops: unknown[] = []
  for (let i = 0; i < text.length; i += size) ops.push(...ex.feed(text.slice(i, i + size)))
  return { ex, ops }
}

describe('OpStreamExtractor', () => {
  it.each([1, 3, 7, 1000])('切片大小 %d：三个 Op 按序完整产出，head 先于 ops 捕获', (size) => {
    const { ex, ops } = feedInChunks(SAMPLE, size)
    expect(ops).toHaveLength(3)
    expect((ops[0] as { name: string }).name).toBe('头{含括号}')
    expect((ops[1] as { text: string }).text).toBe('引号"和\\转义')
    expect((ops[2] as { op: string }).op).toBe('move')
    expect(ex.head).toEqual({ intent: 'ops', confidence: 0.9 })
    expect(ex.fullText()).toBe(SAMPLE)
  })

  it('字符串里的 "ops":[ 不会被误识别', () => {
    const tricky = '{"intent":"ops","confidence":0.8,"say":"假的\\"ops\\":[{}]","ops":[{"op":"undo"}]}'
    const { ops } = feedInChunks(tricky, 5)
    expect(ops).toHaveLength(1)
    expect((ops[0] as { op: string }).op).toBe('undo')
  })

  it('clarify 输出（ops 为空数组）：不产出，head 可用于路由', () => {
    const clarify = '{"intent":"clarify","confidence":0.5,"ops":[],"say":"","clarify":{"question":"哪个？","expecting":["红"]}}'
    const { ex, ops } = feedInChunks(clarify, 4)
    expect(ops).toHaveLength(0)
    expect(ex.head.intent).toBe('clarify')
  })

  it('流中断（文本不完整）：已完成的 Op 照常产出', () => {
    const ex = new OpStreamExtractor()
    const cut = SAMPLE.slice(0, SAMPLE.indexOf('"op":"move"') + 5)
    const ops = ex.feed(cut)
    expect(ops).toHaveLength(2)
  })
})

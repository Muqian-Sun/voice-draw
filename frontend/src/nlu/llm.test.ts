/**
 * LLM 前端客户端单测（协议 §2.2-2.3）：
 * SceneSummary 截断、输出业务校验四条、mock fetch 的重试链路。
 */
import { describe, expect, it, vi } from 'vitest'
import { executeTransaction } from '../engine/interpreter'
import { createEmptyScene, type SceneState } from '../engine/scene'
import { buildSceneSummary, parseWithLlm, validateLlmOutput } from './llm'

function sceneWith(n: number): SceneState {
  let s = createEmptyScene()
  for (let i = 0; i < n; i++) {
    const r = executeTransaction(s, [
      { op: 'create', shape: i % 2 === 0 ? 'circle' : 'rect', at: { x: 100 + i * 5, y: 100 }, size: 20 },
    ])
    s = r.state
  }
  return s
}

describe('buildSceneSummary（协议 §1.6 / §2.2 截断）', () => {
  it('≤30 对象全量输出，含 bbox 与 focusId', () => {
    const s = sceneWith(3)
    const sum = buildSceneSummary(s, '画一个圆')
    expect(sum.objects).toHaveLength(3)
    expect(sum.truncated).toBeUndefined()
    expect(sum.focusId).toBe(s.focusId)
    expect(sum.objects[0].bbox).toHaveLength(4)
  })

  it('>30 对象截断：焦点 + 特征匹配 + 最近 10 个，truncated=true', () => {
    const s = sceneWith(40)
    const sum = buildSceneSummary(s, '把矩形删掉')
    expect(sum.truncated).toBe(true)
    expect(sum.objects.length).toBeLessThan(40)
    // 焦点在列；提及"矩形"→ 全部 rect 保留
    expect(sum.objects.some((o) => o.id === s.focusId)).toBe(true)
    const rects = s.objects.filter((o) => o.shape === 'rect').length
    expect(sum.objects.filter((o) => o.shape === 'rect')).toHaveLength(rects)
  })
})

describe('validateLlmOutput（协议 §2.3 业务校验）', () => {
  const okOps = JSON.stringify({
    intent: 'ops',
    confidence: 0.9,
    ops: [{ op: 'create', shape: 'circle', fill: '#FF4136' }],
    say: '画好了',
  })

  it('合法输出通过，Op 经 zod 校验', () => {
    const r = validateLlmOutput(okOps, 'parse')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result.ops[0]).toMatchObject({ op: 'create', shape: 'circle' })
  })

  it('非 JSON / intent=ops 但 ops 空 → 失败', () => {
    expect(validateLlmOutput('画好了', 'parse').ok).toBe(false)
    expect(validateLlmOutput(JSON.stringify({ intent: 'ops', confidence: 0.9, ops: [], say: 'x' }), 'parse').ok).toBe(false)
  })

  it('clear/undo 来自 LLM → 失败（只能本地产生）', () => {
    const bad = JSON.stringify({ intent: 'ops', confidence: 0.9, ops: [{ op: 'clear' }], say: 'x' })
    const r = validateLlmOutput(bad, 'parse')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('clear')
  })

  it('plan 模式 create 缺 desc / 超 20 个 Op → 失败', () => {
    const noDesc = JSON.stringify({
      intent: 'ops',
      confidence: 0.9,
      ops: [{ op: 'create', shape: 'circle' }],
      say: 'x',
    })
    expect(validateLlmOutput(noDesc, 'plan').ok).toBe(false)
    const tooMany = JSON.stringify({
      intent: 'ops',
      confidence: 0.9,
      ops: Array.from({ length: 21 }, () => ({ op: 'create', shape: 'circle', desc: 'd' })),
      say: 'x',
    })
    expect(validateLlmOutput(tooMany, 'plan').ok).toBe(false)
  })

  it('confidence <0.6 的 ops → 转 clarify（§2.3 第 4 条）', () => {
    const low = JSON.stringify({
      intent: 'ops',
      confidence: 0.4,
      ops: [{ op: 'create', shape: 'circle' }],
      say: 'x',
    })
    const r = validateLlmOutput(low, 'parse')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.intent).toBe('clarify')
      expect(r.result.ops).toHaveLength(0)
    }
  })

  it('clarify 输出合法通过', () => {
    const c = JSON.stringify({
      intent: 'clarify',
      confidence: 0.5,
      ops: [],
      say: '',
      clarify: { question: '哪个圆？', expecting: ['红色', '蓝色'] },
    })
    const r = validateLlmOutput(c, 'parse')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result.clarify?.expecting).toEqual(['红色', '蓝色'])
  })
})

describe('parseWithLlm（mock fetch：成功 / 校验失败重试）', () => {
  const ctx = (fetchFn: typeof fetch) => ({ scene: sceneWith(1), fetchFn, baseUrl: 'http://test' })
  const httpOk = (content: string) =>
    new Response(JSON.stringify({ content, latencyMs: 5 }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  it('一次通过：返回 ParseResult，source 随 mode', async () => {
    const fetchFn = vi.fn(async () =>
      httpOk(JSON.stringify({ intent: 'ops', confidence: 0.9, ops: [{ op: 'create', shape: 'circle' }], say: '好了' })),
    ) as unknown as typeof fetch
    const r = await parseWithLlm('画个圆', 'parse', ctx(fetchFn))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.source).toBe('llm-parse')
      expect(r.result.ops).toHaveLength(1)
    }
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('首轮校验失败 → 带 retry 重试一次 → 通过', async () => {
    const calls: unknown[] = []
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return calls.length === 1
        ? httpOk('不是JSON')
        : httpOk(JSON.stringify({ intent: 'ops', confidence: 0.9, ops: [{ op: 'create', shape: 'rect' }], say: '好' }))
    }) as unknown as typeof fetch
    const r = await parseWithLlm('画个方块', 'parse', ctx(fetchFn))
    expect(r.ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const second = calls[1] as { retry?: { previous: string; error: string } }
    expect(second.retry?.previous).toBe('不是JSON')
    expect(second.retry?.error).toBeTruthy()
  })

  it('重试后仍失败 → 返回错误（本轮丢弃，§2.3）', async () => {
    const fetchFn = vi.fn(async () => httpOk('还是不是JSON')) as unknown as typeof fetch
    const r = await parseWithLlm('画个方块', 'parse', ctx(fetchFn))
    expect(r.ok).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('backend 503（未配密钥）→ 返回错误信息', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'LLM_NOT_CONFIGURED', message: '未配置 ARK_API_KEY（火山方舟）' }), { status: 503 }),
    ) as unknown as typeof fetch
    const r = await parseWithLlm('画个圆', 'parse', ctx(fetchFn))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('ARK_API_KEY')
  })
})

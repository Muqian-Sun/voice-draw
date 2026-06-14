/**
 * planLayout 单测（按角色拆子计划设计 Phase 1）
 * 用 mock fetchFn 覆盖成功路径与非法 JSON 路径。
 */
import { describe, expect, it, vi } from 'vitest'
import { createEmptyScene } from '../engine/scene'
import { planLayout } from './planner'

const SNOW_WHITE_LAYOUT = JSON.stringify({
  background: '森林草地',
  style: '绘本插画',
  subjects: [
    { label: '白雪公主', cx: 512, cy: 360, w: 240, h: 420 },
    { label: '小矮人1', cx: 150, cy: 520, w: 120, h: 200 },
    { label: '小矮人2', cx: 290, cy: 560, w: 120, h: 200 },
    { label: '小矮人3', cx: 430, cy: 600, w: 120, h: 200 },
    { label: '小矮人4', cx: 600, cy: 600, w: 120, h: 200 },
    { label: '小矮人5', cx: 740, cy: 560, w: 120, h: 200 },
    { label: '小矮人6', cx: 880, cy: 520, w: 120, h: 200 },
    { label: '小矮人7', cx: 512, cy: 640, w: 120, h: 200 },
  ],
})

function makeCtx(fetchFn: typeof fetch) {
  return { scene: createEmptyScene(), fetchFn, baseUrl: 'http://test' }
}

function httpOk(content: string): Response {
  return new Response(JSON.stringify({ content, latencyMs: 5 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('planLayout（mock fetch）', () => {
  it('后端返回合法布局 JSON → ok:true，subjects 长度与字段正确', async () => {
    const fetchFn = vi.fn(async () => httpOk(SNOW_WHITE_LAYOUT)) as unknown as typeof fetch
    const r = await planLayout('画白雪公主和七个小矮人', makeCtx(fetchFn))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.layout.subjects).toHaveLength(8)
    expect(r.layout.background).toBe('森林草地')
    expect(r.layout.style).toBe('绘本插画')
    const princess = r.layout.subjects.find((s) => s.label === '白雪公主')!
    expect(princess.w).toBe(240)
    expect(princess.cx).toBe(512)
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('后端返回非法 JSON 字符串 → ok:false，error 说明原因', async () => {
    const fetchFn = vi.fn(async () => httpOk('这不是JSON')) as unknown as typeof fetch
    const r = await planLayout('画白雪公主', makeCtx(fetchFn))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBeTruthy()
  })

  it('后端返回 subjects 为空数组 → schema 校验失败 → ok:false', async () => {
    const fetchFn = vi.fn(async () =>
      httpOk(JSON.stringify({ subjects: [] })),
    ) as unknown as typeof fetch
    const r = await planLayout('画什么', makeCtx(fetchFn))
    expect(r.ok).toBe(false)
  })

  it('后端 503 → ok:false，error 含状态码', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'LLM_NOT_CONFIGURED', message: '未配置 ARK_API_KEY' }), { status: 503 }),
    ) as unknown as typeof fetch
    const r = await planLayout('画个场景', makeCtx(fetchFn))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('ARK_API_KEY')
  })

  it('请求发出时 body 包含 mode:layout 与 scene', async () => {
    let capturedBody: unknown
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return httpOk(SNOW_WHITE_LAYOUT)
    }) as unknown as typeof fetch
    await planLayout('画白雪公主', makeCtx(fetchFn))
    const b = capturedBody as { mode: string; utterance: string; scene: unknown }
    expect(b.mode).toBe('layout')
    expect(b.utterance).toBe('画白雪公主')
    expect(b.scene).toBeDefined()
  })
})

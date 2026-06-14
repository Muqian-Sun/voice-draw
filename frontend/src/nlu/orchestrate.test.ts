/**
 * orchestrate 单测（按角色拆子计划设计 Phase 1 PR-2）
 */
import { describe, expect, it, vi } from 'vitest'
import { createEmptyScene } from '../engine/scene'
import { looksMultiSubject, orchestrateSubplans } from './orchestrate'

// ---------- looksMultiSubject ----------

describe('looksMultiSubject', () => {
  it('含「和」→ true', () => {
    expect(looksMultiSubject('画白雪公主和七个小矮人')).toBe(true)
  })
  it('七个（数量词）→ true', () => {
    expect(looksMultiSubject('七个小矮人')).toBe(true)
  })
  it('单个苹果 → false', () => {
    expect(looksMultiSubject('画一个苹果')).toBe(false)
  })
  it('一只猫 → false', () => {
    expect(looksMultiSubject('画一只猫')).toBe(false)
  })
  it('只有形状词 → false', () => {
    expect(looksMultiSubject('三角形')).toBe(false)
  })
})

// ---------- orchestrateSubplans ----------

/** 布局响应（2 个主体） */
const LAYOUT_RESP = JSON.stringify({
  background: '草地',
  subjects: [
    { label: '白雪公主', cx: 300, cy: 384, w: 200, h: 400 },
    { label: '小矮人', cx: 700, cy: 450, w: 160, h: 280 },
  ],
})

/** plan 响应 — 简单两个 create op，带 desc（plan 校验需要） */
function planResp(label: string) {
  return JSON.stringify({
    intent: 'ops',
    confidence: 0.95,
    ops: [
      { op: 'create', shape: 'circle', size: 40, name: `${label}-头`, desc: `${label}的头` },
      { op: 'create', shape: 'rect', width: 60, height: 90, name: `${label}-身`, desc: `${label}的身体` },
    ],
    say: `${label}画好了`,
  })
}

/** 构造 mock fetchFn：按 body.mode/stream 返回不同内容
 *  - layout（非流式）：返回 { content: <布局JSON字符串> }（callBackend 格式）
 *  - plan（stream:true）：返回裸 LLM JSON 字符串作为 body（parseWithLlmStream 直接 getReader 读取）
 *
 *  注意：背景改为瞬时直接画（不走 LLM），故 plan 请求只有两个角色各自的（layout 1 次 + plan 2 次）。
 */
function makeFetchFn() {
  const callCount = { layout: 0, plan: 0 }
  const fn = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { mode: string; stream?: boolean; utterance?: string }
    if (body.mode === 'layout') {
      callCount.layout++
      return new Response(JSON.stringify({ content: LAYOUT_RESP }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    // plan 模式（stream:true）：裸 LLM JSON 作为 body，parseWithLlmStream 经 res.body.getReader() 读取
    callCount.plan++
    const label = (body.utterance ?? '').includes('白雪公主') ? '白雪公主' : '小矮人'
    return new Response(planResp(label), { status: 200 })
  }) as unknown as typeof fetch
  return { fn, callCount }
}

describe('orchestrateSubplans（mock fetchFn）', () => {
  it('2 个主体 → ok:true，subjectCount===2，对象含各主体 groupId，onScene 被多次调用', async () => {
    const { fn, callCount } = makeFetchFn()
    const baseScene = createEmptyScene()
    const sceneCalls: number[] = []
    let firstPaintFired = false

    const result = await orchestrateSubplans(
      '画白雪公主和一个小矮人',
      baseScene,
      { scene: baseScene, fetchFn: fn, baseUrl: 'http://test' },
      {
        onScene: (s) => { sceneCalls.push(s.objects.length) },
        onFirstPaint: () => { firstPaintFired = true },
        onLog: () => { /* 静默 */ },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.subjectCount).toBe(2)

    // onScene 至少在每个主体绘制时被调用（每 op 一次 + 每角色 applyAutoGroup 一次）
    expect(sceneCalls.length).toBeGreaterThan(0)

    // 首帧回调触发
    expect(firstPaintFired).toBe(true)

    // 最终场景含各主体对象；每个主体应当有各自的 groupId（applyAutoGroup 已按 label 编组）
    const { objects } = result.scene
    expect(objects.length).toBeGreaterThan(0)

    // 至少有一个对象属于「白雪公主」组，一个属于「小矮人」组
    const groups = new Set(objects.map((o) => o.groupId).filter(Boolean))
    expect(groups.has('白雪公主')).toBe(true)
    expect(groups.has('小矮人')).toBe(true)

    // 背景不再走 LLM：plan 请求只有两个角色各自的（layout 1 + plan 2，背景不产生 plan 调用）
    expect(callCount.layout).toBe(1)
    expect(callCount.plan).toBe(2)

    // 最终场景含背景天空和背景地面两个 rect，且它们属于「背景」组
    const bgSky = objects.find((o) => o.name === '背景天空')
    const bgGround = objects.find((o) => o.name === '背景地面')
    expect(bgSky).toBeDefined()
    expect(bgGround).toBeDefined()
    expect(bgSky?.shape).toBe('rect')
    expect(bgGround?.shape).toBe('rect')
    expect(bgSky?.groupId).toBe('背景')
    expect(bgGround?.groupId).toBe('背景')
  })

  it('planLayout 失败 → ok:false fallback:true', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ message: '服务不可用' }), { status: 503 }),
    ) as unknown as typeof fetch

    const result = await orchestrateSubplans(
      '画白雪公主和七个小矮人',
      createEmptyScene(),
      { scene: createEmptyScene(), fetchFn, baseUrl: 'http://test' },
      { onScene: () => { /* noop */ }, onLog: () => { /* noop */ } },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fallback).toBe(true)
  })

  it('planLayout 返回单主体 → ok:false fallback:true', async () => {
    const singleSubjectLayout = JSON.stringify({
      subjects: [{ label: '白雪公主', cx: 512, cy: 384, w: 200, h: 400 }],
    })
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ content: singleSubjectLayout }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch

    const result = await orchestrateSubplans(
      '画白雪公主',
      createEmptyScene(),
      { scene: createEmptyScene(), fetchFn, baseUrl: 'http://test' },
      { onScene: () => { /* noop */ }, onLog: () => { /* noop */ } },
    )

    expect(result.ok).toBe(false)
  })
})

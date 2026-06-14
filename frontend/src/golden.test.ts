/**
 * Golden 测试集（瘦身版）
 *
 * 绘图规则模板已删（绘图全走 LLM）。离线部分仅保留 **系统指令**（撤销/重做/清空/保存，
 * 走 纠错 → 规则 通道）与 **离线歧义澄清**（直接构造 op，不经规则层）。
 * 绘图正确性改由 B3/B4 真实 LLM 守护：GOLDEN_LIVE=1 且本机 backend 已启动（含 ARK 密钥）时实跑：
 *   cd backend && pnpm dev          # 终端 1
 *   GOLDEN_LIVE=1 pnpm test golden  # 终端 2（frontend 下）
 */
import { describe, expect, it } from 'vitest'
import { createHistory, executeWithHistory, type HistoryState } from './engine/history'
import { buildAmbiguityClarify, matchExpecting } from './nlu/clarify'
import { correctTranscript } from './nlu/correction'
import { parseWithLlm } from './nlu/llm'
import { extractPlanSubject, parseRule, type RuleParseResult } from './nlu/rules'
import { CONFIRM_YES_WORDS } from './shared/lexicon'
import type { Op } from './dsl'

/** 与 App 同构的理解通道（纠错 → 规则），不含 LLM */
function route(text: string, h: HistoryState): { corrected: string; rule: RuleParseResult | null } {
  const corr = correctTranscript(text)
  const scene = h.scene
  const names = [
    ...new Set(scene.objects.flatMap((o) => [o.name, o.groupId]).filter((n): n is string => n !== undefined)),
  ]
  return {
    corrected: corr.corrected,
    rule: parseRule(corr.corrected, { names, hasFocus: scene.focusId !== undefined }),
  }
}

/** 直接灌 DSL 建场景（绘图已不走规则层，测试用引擎直接构造），断言无错 */
function seed(h: HistoryState, ops: Op[]): HistoryState {
  const r = executeWithHistory(h, ops)
  expect(r.error, r.error?.message).toBeUndefined()
  return r.history
}

describe('Golden 系统指令（撤销/重做/清空/保存，零 LLM 调用）', () => {
  it('#10~#12 撤销 / 撤销三步 / 重做', () => {
    expect(route('撤销', createHistory()).rule!.ops).toEqual([{ op: 'undo' }])
    expect(route('撤销三步', createHistory()).rule!.ops).toEqual([{ op: 'undo', steps: 3 }])
    expect(route('重做', createHistory()).rule!.ops).toEqual([{ op: 'redo' }])
  })

  it('系统指令延迟 <50ms、source=rule', () => {
    const r = route('清空', createHistory()).rule!
    expect(r.latencyMs, '系统指令延迟 <50ms').toBeLessThan(50)
    expect(r.source).toBe('rule')
  })

  it('#13~#15 清空确认流：confirm-pending 不直接执行；确定→清空；算了→丢弃', () => {
    const h = seed(createHistory(), [{ op: 'create', shape: 'circle' }])
    const { rule } = route('清空画布', h)
    expect(rule!.intent).toBe('confirm-pending')
    expect(rule!.ops).toEqual([{ op: 'clear' }])
    expect(h.scene.objects).toHaveLength(1) // #13：确认前画布不变

    expect(CONFIRM_YES_WORDS).toContain('确定') // #14：确定 → 执行
    const cleared = executeWithHistory(h, rule!.ops)
    expect(cleared.history.scene.objects).toHaveLength(0)

    expect(CONFIRM_YES_WORDS).not.toContain('算了') // #15：算了 → 否定（保守策略）
  })

  it('#19 保存图片 → export png', () => {
    expect(route('保存图片', createHistory()).rule!.ops).toEqual([{ op: 'export', format: 'png' }])
  })
})

describe('Golden 纠错 → 系统指令', () => {
  it('#23 车销 → 撤销', () => {
    expect(route('车销', createHistory()).rule!.ops).toEqual([{ op: 'undo' }])
  })
})

describe('Golden #26/#27 歧义澄清（离线，直接构造 op，不发起 LLM 调用）', () => {
  it('双圆歧义 → expecting 含红/蓝；澄清快匹配 byId 补全只改红圆', () => {
    const h = seed(createHistory(), [
      { op: 'create', shape: 'circle', fill: '#FF4136', at: { x: 300, y: 384 } },
      { op: 'create', shape: 'circle', fill: '#0074D9', at: { x: 700, y: 384 } },
    ])

    // 绘图已不走规则层；直接构造"把那个圆变大"对应 op（byQuery shape=circle 命中两个 → 歧义）
    const ambiguousOp: Op = { op: 'resize', target: { byQuery: { shape: 'circle' } }, scale: 1.3 }
    const r = executeWithHistory(h, [ambiguousOp])
    expect(r.error?.code).toBe('AMBIGUOUS_TARGET')
    const candidates = r.error!.candidateIds!.map((id) => h.scene.objects.find((o) => o.id === id)!)
    const plan = buildAmbiguityClarify(candidates)
    expect(plan.kind).toBe('choices')
    if (plan.kind !== 'choices') return
    expect(plan.expecting.map((e) => e.label).sort()).toEqual(['红色', '蓝色'])

    // 红色的 → 快匹配 → byId 补全执行（全程无 LLM 参与）
    const hit = matchExpecting('红色的', plan.expecting)
    expect(hit).not.toBeNull()
    const fixed = [{ ...ambiguousOp, target: { byId: hit!.id } } as Op]
    const done = executeWithHistory(h, fixed)
    expect(done.error).toBeUndefined()
    const red = done.history.scene.objects.find((o) => o.fill === '#FF4136')!
    const blue = done.history.scene.objects.find((o) => o.fill === '#0074D9')!
    expect(red.radius).toBeCloseTo(80 * 1.3)
    expect(blue.radius).toBe(80)
  })
})

// ---------- B3/B4：真实 LLM（GOLDEN_LIVE=1 + 本机 backend + ARK 密钥） ----------

const LIVE = process.env.GOLDEN_LIVE === '1'
const BASE = 'http://localhost:8787'

describe.runIf(LIVE)('Golden B3 LLM-parse（#25/#28，实跑）', () => {
  it('#25 在房子左边画一棵比它矮的树', { timeout: 60_000 }, async () => {
    const h = seed(createHistory(), [{ op: 'create', shape: 'rect', name: '房子' }])
    const r = await parseWithLlm('在房子左边画一棵比它矮的树', 'parse', { scene: h.scene, baseUrl: BASE })
    expect(r.ok, !r.ok ? r.error : '').toBe(true)
    if (!r.ok) return
    const creates = r.result.ops.filter((o) => o.op === 'create')
    expect(creates.length).toBeGreaterThanOrEqual(1)
    const json = JSON.stringify(r.result.ops)
    expect(json).toContain('"byName":"房子"')
    const factors = [...json.matchAll(/"factor":([0-9.]+)/g)].map((m) => Number(m[1]))
    expect(factors.some((f) => f < 1)).toBe(true)
  })

  it('#28 画个红圆，再在它右边画个蓝方块：2 Op 同事务，一次 undo 全回退', { timeout: 60_000 }, async () => {
    const h0 = createHistory()
    const r = await parseWithLlm('画个红圆，再在它右边画个蓝方块', 'parse', { scene: h0.scene, baseUrl: BASE })
    expect(r.ok, !r.ok ? r.error : '').toBe(true)
    if (!r.ok) return
    expect(r.result.ops.length).toBeGreaterThanOrEqual(2)
    const done = executeWithHistory(h0, r.result.ops)
    expect(done.error).toBeUndefined()
    expect(done.history.scene.objects.length).toBeGreaterThanOrEqual(2)
    const undone = executeWithHistory(done.history, [{ op: 'undo' }])
    expect(undone.history.scene.objects).toHaveLength(0)
  })
})

describe.runIf(LIVE)('Golden B4 LLM-plan（#29/#30，实跑）', () => {
  it('#29 画一个雪人：5~20 create 均带 desc，自动编组「雪人」；#30 整组移动', { timeout: 120_000 }, async () => {
    const h0 = createHistory()
    const utterance = '画一个雪人'
    const r = await parseWithLlm(utterance, 'plan', { scene: h0.scene, baseUrl: BASE })
    expect(r.ok, !r.ok ? r.error : '').toBe(true)
    if (!r.ok) return
    expect(r.result.source).toBe('llm-plan')
    const creates = r.result.ops.filter((o) => o.op === 'create')
    expect(creates.length).toBeGreaterThanOrEqual(5)
    expect(creates.length).toBeLessThanOrEqual(20)
    expect(creates.every((o) => o.op === 'create' && o.desc !== undefined)).toBe(true)

    const groupName = extractPlanSubject(utterance)
    expect(groupName).toBe('雪人')
    const done = executeWithHistory(h0, r.result.ops, { autoGroupName: groupName! })
    expect(done.error).toBeUndefined()
    const scene = done.history.scene
    expect(scene.objects.every((o) => o.groupId === '雪人')).toBe(true)
    expect(scene.objects.some((o) => o.id === scene.focusId)).toBe(true) // 焦点=组成员

    // #30 把它移到右边：byFocus 命中组成员 → 整组移动，相对位置不变
    const xsBefore = scene.objects.map((o) => o.x)
    const moved = executeWithHistory(done.history, [{ op: 'move', target: { byFocus: true }, delta: [240, 0] }])
    expect(moved.error).toBeUndefined()
    const deltas = moved.history.scene.objects.map((o, i) => o.x - xsBefore[i])
    expect(new Set(deltas.map((d) => Math.round(d))).size).toBe(1)
  })
})

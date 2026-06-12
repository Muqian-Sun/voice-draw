/**
 * Golden 测试集（规格 附录 B，30 句）
 *
 * B1 规则层（#1~20）+ B2 纠错层（#21~24）+ #26/#27 歧义澄清：离线全自动，
 * 走与 App 相同的 纠错 → 规则 → 执行 通道（不经 React）。
 * B3/B4（#25/#28/#29/#30）依赖真实 LLM：GOLDEN_LIVE=1 且本机 backend 已启动
 * （含 ARK 密钥）时实跑，平时跳过：
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

/** 规则命中 + 执行，断言无错并返回新历史 */
function hitAndRun(text: string, h: HistoryState): { h: HistoryState; rule: RuleParseResult } {
  const { rule } = route(text, h)
  expect(rule, `「${text}」应命中规则层`).not.toBeNull()
  expect(rule!.latencyMs, 'B1 延迟 <50ms').toBeLessThan(50)
  expect(rule!.source).toBe('rule')
  const r = executeWithHistory(h, rule!.ops)
  expect(r.error, r.error?.message).toBeUndefined()
  return { h: r.history, rule: rule! }
}

describe('Golden B1 规则层（#1~#20，零 LLM 调用）', () => {
  it('#1 画一个圆：缺省 medium，自动布局画布中心', () => {
    const { h } = hitAndRun('画一个圆', createHistory())
    const o = h.scene.objects[0]
    expect(o.shape).toBe('circle')
    expect(o.radius).toBe(80)
    expect([o.x, o.y]).toEqual([512, 384])
  })

  it('#2 在左上角画一个大的蓝色矩形', () => {
    const { rule } = hitAndRun('在左上角画一个大的蓝色矩形', createHistory())
    expect(rule.ops[0]).toMatchObject({
      op: 'create',
      shape: 'rect',
      size: 'large',
      fill: '#0074D9',
      at: { ref: 'canvas', anchor: 'top-left' },
    })
  })

  it('#3 画一条横线：水平', () => {
    const { h } = hitAndRun('画一条横线', createHistory())
    const o = h.scene.objects[0]
    expect(o.shape).toBe('line')
    expect(o.rotation).toBe(0)
    expect(o.points![1]).toBe(o.points![3]) // 两端 y 相同 = 水平
  })

  it('#4 写上你好：create text', () => {
    const { rule } = hitAndRun('写上你好', createHistory())
    expect(rule.ops[0]).toMatchObject({ op: 'create', shape: 'text', text: '你好' })
  })

  it('#5 把圆往右移一点：delta=[60,0]', () => {
    let h = hitAndRun('画一个圆', createHistory()).h
    const { rule } = hitAndRun('把圆往右移一点', h)
    expect(rule.ops[0]).toMatchObject({ op: 'move', target: { byQuery: { shape: 'circle' } }, delta: [60, 0] })
  })

  it('#6 把它变大一点：byFocus scale=1.3 ｜ #7 缩小一半：scale=0.5', () => {
    let h = hitAndRun('画一个圆', createHistory()).h
    const r6 = hitAndRun('把它变大一点', h)
    expect(r6.rule.ops[0]).toMatchObject({ op: 'resize', target: { byFocus: true }, scale: 1.3 })
    const r7 = hitAndRun('缩小一半', r6.h)
    expect(r7.rule.ops[0]).toMatchObject({ op: 'resize', target: { byFocus: true }, scale: 0.5 })
    expect(r7.h.scene.objects[0].radius).toBeCloseTo(80 * 1.3 * 0.5)
  })

  it('#8 把房子涂成红色：byName', () => {
    let h = hitAndRun('画一个方块', createHistory()).h
    h = hitAndRun('这个叫房子', h).h
    const { h: h2 } = hitAndRun('把房子涂成红色', h)
    expect(h2.scene.objects[0].fill).toBe('#FF4136')
  })

  it('#9 把那个蓝色的圆删掉：byQuery 含 fill', () => {
    let h = hitAndRun('画一个蓝色的圆', createHistory()).h
    h = hitAndRun('画一个红色的方块', h).h
    const { rule, h: h2 } = hitAndRun('把那个蓝色的圆删掉', h)
    expect(rule.ops[0]).toMatchObject({ op: 'delete', target: { byQuery: { shape: 'circle', fill: '#0074D9' } } })
    expect(h2.scene.objects).toHaveLength(1)
  })

  it('#10~#12 撤销 / 撤销三步 / 重做', () => {
    expect(route('撤销', createHistory()).rule!.ops).toEqual([{ op: 'undo' }])
    expect(route('撤销三步', createHistory()).rule!.ops).toEqual([{ op: 'undo', steps: 3 }])
    expect(route('重做', createHistory()).rule!.ops).toEqual([{ op: 'redo' }])
  })

  it('#13~#15 清空确认流：confirm-pending 不直接执行；确定→清空；算了→丢弃', () => {
    const h = hitAndRun('画一个圆', createHistory()).h
    const { rule } = route('清空画布', h)
    expect(rule!.intent).toBe('confirm-pending')
    expect(rule!.ops).toEqual([{ op: 'clear' }])
    expect(h.scene.objects).toHaveLength(1) // #13：确认前画布不变

    expect(CONFIRM_YES_WORDS).toContain('确定') // #14：确定 → 执行
    const cleared = executeWithHistory(h, rule!.ops)
    expect(cleared.history.scene.objects).toHaveLength(0)

    expect(CONFIRM_YES_WORDS).not.toContain('算了') // #15：算了 → 否定（保守策略）
  })

  it('#16 把三角形转45度 ｜ #17 这个叫屋顶 ｜ #18 选中那个红色的圆 ｜ #19 保存图片', () => {
    let h = hitAndRun('画一个三角形', createHistory()).h
    const r16 = hitAndRun('把三角形转45度', h)
    expect(r16.h.scene.objects[0].rotation).toBe(45)
    const r17 = hitAndRun('这个叫屋顶', r16.h)
    expect(r17.h.scene.objects[0].name).toBe('屋顶')
    let h2 = hitAndRun('画一个红色的圆', r17.h).h
    const r18 = route('选中那个红色的圆', h2)
    expect(r18.rule!.ops[0]).toMatchObject({ op: 'focus', target: { byQuery: { shape: 'circle', fill: '#FF4136' } } })
    const r19 = route('保存图片', h2)
    expect(r19.rule!.ops).toEqual([{ op: 'export', format: 'png' }])
  })

  it('#20 画两个绿色的圆：2×create，自动布局位置错开', () => {
    const { h, rule } = hitAndRun('画两个绿色的圆', createHistory())
    expect(rule.ops).toHaveLength(2)
    const [a, b] = h.scene.objects
    expect(a.fill).toBe('#2ECC40')
    expect(b.fill).toBe('#2ECC40')
    expect(a.x !== b.x || a.y !== b.y).toBe(true)
  })
})

describe('Golden B2 纠错层（#21~#24）', () => {
  it('#21 花一个园 → 画一个圆', () => {
    const { corrected, rule } = route('花一个园', createHistory())
    expect(corrected).toBe('画一个圆')
    expect(rule!.ops[0]).toMatchObject({ op: 'create', shape: 'circle' })
  })

  it('#22 把它涂成篮色 → 蓝色', () => {
    const h = hitAndRun('画一个圆', createHistory()).h
    const { rule } = route('把它涂成篮色', h)
    expect(rule!.ops[0]).toMatchObject({ op: 'style', fill: '#0074D9' })
  })

  it('#23 车销 → 撤销 ｜ #24 三角型 → 三角形', () => {
    expect(route('车销', createHistory()).rule!.ops).toEqual([{ op: 'undo' }])
    expect(route('画一个三角型', createHistory()).rule!.ops[0]).toMatchObject({ op: 'create', shape: 'triangle' })
  })
})

describe('Golden #26/#27 歧义澄清（离线，不发起 LLM 调用）', () => {
  it('双圆歧义 → expecting 含红/蓝；澄清快匹配 byId 补全只改红圆', () => {
    let h = hitAndRun('画一个红色的圆', createHistory()).h
    h = executeWithHistory(h, [
      { op: 'create', shape: 'circle', fill: '#0074D9', at: { x: 700, y: 384 } },
    ]).history

    // #26：把那个圆变大 → AMBIGUOUS → 澄清问题
    const { rule } = route('把那个圆变大', h)
    expect(rule).not.toBeNull()
    const r = executeWithHistory(h, rule!.ops)
    expect(r.error?.code).toBe('AMBIGUOUS_TARGET')
    const candidates = r.error!.candidateIds!.map((id) => h.scene.objects.find((o) => o.id === id)!)
    const plan = buildAmbiguityClarify(candidates)
    expect(plan.kind).toBe('choices')
    if (plan.kind !== 'choices') return
    expect(plan.expecting.map((e) => e.label).sort()).toEqual(['红色', '蓝色'])

    // #27：红色的 → 快匹配 → byId 补全执行（全程无 LLM 参与）
    const hit = matchExpecting('红色的', plan.expecting)
    expect(hit).not.toBeNull()
    const fixed = [{ ...rule!.ops[0], target: { byId: hit!.id } } as Op]
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
    let h = hitAndRun('画一个方块', createHistory()).h
    h = hitAndRun('这个叫房子', h).h
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

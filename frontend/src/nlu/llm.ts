/**
 * LLM 理解层前端客户端（协议 §2）
 *
 * 职责：构建 SceneSummary（§1.6，含 >30 对象截断）→ 调 backend /api/llm/parse
 * → JSON.parse + zod + 业务校验（§2.3 四条）→ 失败重试 1 次（追加校验错误）
 * → 输出与规则层同构的 ParseResult。clear 永不来自 LLM（业务校验拦截）。
 */
import { z } from 'zod'
import { opSchema, type Op } from '../dsl'
import { getBBox, type SceneState } from '../engine/scene'
import { COLOR_WORDS, SHAPE_ALIASES } from '../shared/lexicon'

// ---------- SceneSummary（协议 §1.6） ----------

export interface SceneSummary {
  canvas: { width: 1024; height: 768 }
  objects: Array<{
    id: string
    name?: string
    shape: string
    fill?: string
    stroke?: string
    center: [number, number] // 图形中心（与输出 at.x/y 同坐标系，免去从 bbox 角换算——尤其圆）
    bbox: [number, number, number, number]
    z: number
    groupId?: string
  }>
  focusId?: string
  /** 人类可读焦点 + 粒度，让模型清楚"它"指什么、byFocus 会动什么（§5.1 v1.1） */
  focus?: { name?: string; id: string; scope: 'group' | 'object' }
  /** 组结构：组名 → 成员名清单。模型据此精确引用部件、避免误用组名/byFocus 动整组 */
  groups?: Array<{ name: string; members: string[] }>
  lastTransaction?: { utterance: string; opCount: number }
  truncated?: true
}

const MAX_SCENE_OBJECTS = 30
const KEEP_RECENT = 10

/** >30 对象时截断：焦点 + utterance 特征匹配（形状/颜色词）+ 最近创建 10 个（协议 §2.2） */
export function buildSceneSummary(
  scene: SceneState,
  utterance: string,
  lastTransaction?: { utterance: string; opCount: number },
): SceneSummary {
  let objects = scene.objects
  let truncated = false
  if (objects.length > MAX_SCENE_OBJECTS) {
    const mentionedShapes = new Set(
      Object.entries(SHAPE_ALIASES)
        .filter(([w]) => utterance.includes(w))
        .map(([, a]) => a.kind),
    )
    const mentionedFills = new Set(
      Object.entries(COLOR_WORDS)
        .filter(([w]) => utterance.includes(w))
        .map(([, hex]) => hex),
    )
    const recentIds = new Set(
      [...objects]
        .sort((a, b) => b.createdSeq - a.createdSeq)
        .slice(0, KEEP_RECENT)
        .map((o) => o.id),
    )
    objects = objects.filter(
      (o) =>
        o.id === scene.focusId ||
        recentIds.has(o.id) ||
        mentionedShapes.has(o.shape) ||
        (o.fill !== undefined && mentionedFills.has(o.fill)) ||
        (o.name !== undefined && utterance.includes(o.name)),
    )
    truncated = true
  }
  // 组结构汇总（成员名清单），供模型精确引用部件
  const groupMap = new Map<string, string[]>()
  for (const o of objects) {
    if (o.groupId === undefined) continue
    const list = groupMap.get(o.groupId) ?? []
    if (o.name !== undefined) list.push(o.name)
    groupMap.set(o.groupId, list)
  }
  const groups = [...groupMap.entries()].map(([name, members]) => ({ name, members }))

  const focusObj = scene.focusId !== undefined ? scene.objects.find((o) => o.id === scene.focusId) : undefined

  return {
    canvas: { width: 1024, height: 768 },
    objects: objects.map((o) => {
      const [bx, by, bw, bh] = getBBox(o)
      return {
        id: o.id,
        ...(o.name !== undefined && { name: o.name }),
        shape: o.shape,
        ...(o.fill !== undefined && { fill: o.fill }),
        ...(o.stroke !== undefined && { stroke: o.stroke }),
        center: [Math.round(bx + bw / 2), Math.round(by + bh / 2)] as [number, number],
        bbox: [bx, by, bw, bh] as [number, number, number, number],
        z: o.z,
        ...(o.groupId !== undefined && { groupId: o.groupId }),
      }
    }),
    ...(scene.focusId !== undefined && {
      focusId: scene.focusId,
      focus: {
        ...(focusObj?.name !== undefined && { name: focusObj.name }),
        id: scene.focusId,
        scope: scene.focusScope ?? 'object',
      },
    }),
    ...(groups.length > 0 && { groups }),
    ...(lastTransaction !== undefined && { lastTransaction }),
    ...(truncated && { truncated: true as const }),
  }
}

// ---------- 输出校验（协议 §2.3） ----------

const llmOutputSchema = z
  .object({
    intent: z.enum(['ops', 'clarify', 'reject']),
    confidence: z.number().min(0).max(1),
    ops: z.array(z.unknown()),
    say: z.string().optional(),
    clarify: z.object({ question: z.string(), expecting: z.array(z.string()) }).optional(),
    reason: z.string().optional(),
  })
  .passthrough() // 多余字段不致命（say 之外的注释字段等），strict 留给 Op 层

export interface LlmParseResult {
  source: 'llm-parse' | 'llm-plan'
  intent: 'ops' | 'clarify' | 'reject'
  ops: Op[]
  say?: string
  clarify?: { question: string; expecting: string[] }
  confidence: number
  latencyMs: number
}

export type ValidateResult = { ok: true; result: Omit<LlmParseResult, 'latencyMs' | 'source'> } | { ok: false; error: string }

/** JSON.parse + zod + 业务校验四条（§2.3）；mode=plan 额外校验 desc 与 Op 总数 */
export function validateLlmOutput(content: string, mode: 'parse' | 'plan'): ValidateResult {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return { ok: false, error: '不是合法 JSON' }
  }
  const head = llmOutputSchema.safeParse(json)
  if (!head.success) {
    return { ok: false, error: head.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；') }
  }
  const out = head.data

  // 业务校验 1：intent=ops ⇔ ops 非空
  if ((out.intent === 'ops') !== (out.ops.length > 0)) {
    return { ok: false, error: 'intent=ops 时 ops 必须非空，clarify/reject 时必须为空数组' }
  }

  const ops: Op[] = []
  for (const [i, raw] of out.ops.entries()) {
    const r = opSchema.safeParse(raw)
    if (!r.success) {
      return { ok: false, error: `ops[${i}] 非法：${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('；')}` }
    }
    // 业务校验 2：clear/undo/redo/export 不允许来自 LLM
    if (r.data.op === 'clear' || r.data.op === 'undo' || r.data.op === 'redo' || r.data.op === 'export') {
      return { ok: false, error: `ops[${i}]：${r.data.op} 只能由本地规则层产生` }
    }
    ops.push(r.data)
  }

  // 业务校验 3：plan 模式 create 必须带 desc，总 Op 数 ≤ 50（放宽：多主体场景按角色给足 op，避免各角色残缺）
  if (mode === 'plan') {
    if (ops.length > 50) return { ok: false, error: `plan 模式 Op 总数 ${ops.length} 超过 50` }
    const missing = ops.findIndex((o) => o.op === 'create' && o.desc === undefined)
    if (missing >= 0) return { ok: false, error: `plan 模式 ops[${missing}] 缺少 desc（进度播报用）` }
  }

  if (out.intent === 'ops' && (out.say === undefined || out.say.length === 0)) {
    return { ok: false, error: 'intent=ops 时 say 必填' }
  }

  // 业务校验 4：confidence < 0.6 → 改走 clarify
  if (out.intent === 'ops' && out.confidence < 0.6) {
    return {
      ok: true,
      result: {
        intent: 'clarify',
        ops: [],
        say: out.clarify?.question ?? '我不太确定你的意思，能换个说法吗？',
        ...(out.clarify !== undefined && { clarify: out.clarify }),
        confidence: out.confidence,
      },
    }
  }

  return {
    ok: true,
    result: {
      intent: out.intent,
      ops,
      ...(out.say !== undefined && { say: out.say }),
      ...(out.clarify !== undefined && { clarify: out.clarify }),
      confidence: out.confidence,
    },
  }
}

// ---------- 调用入口（含一次重试，协议 §2.3） ----------

export interface LlmCallContext {
  scene: SceneState
  asrAlternatives?: string[]
  recent?: Array<{ utterance: string; summary: string }>
  lastTransaction?: { utterance: string; opCount: number }
  /** 画布截图 dataURL（视觉自检按需附带，backend 自动切多模态模型） */
  image?: string
  /** 测试注入；缺省 fetch */
  fetchFn?: typeof fetch
  baseUrl?: string
}

export type LlmParseOutcome = { ok: true; result: LlmParseResult } | { ok: false; error: string }

async function callBackend(
  payload: Record<string, unknown>,
  fetchFn: typeof fetch,
  baseUrl: string,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  let res: Response
  try {
    res = await fetchFn(`${baseUrl}/api/llm/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    return { ok: false, error: `backend 不可达：${(e as Error).message}` }
  }
  const body = (await res.json().catch(() => null)) as { content?: string; error?: string; message?: string } | null
  if (!res.ok || body === null || typeof body.content !== 'string') {
    return { ok: false, error: body?.message ?? `backend ${res.status}` }
  }
  return { ok: true, content: body.content }
}

/**
 * 流式解析（协议 v1.4 渐进绘制）：边收 LLM 增量边提取完整 Op，逐个回调 onOp
 * （已过 Op 级 zod + 本地操作禁单；仅 intent=ops 且 confidence 达标才回调）。
 * 流结束后用完整文本做权威校验：通过即返回结果（ops 已在回调中交付，调用方
 * 不应重复执行）；失败返回错误——调用方回滚画布后退回缓冲模式（含重试）。
 */
export async function parseWithLlmStream(
  utterance: string,
  mode: 'parse' | 'plan',
  ctx: LlmCallContext,
  onOp: (op: Op) => void,
): Promise<LlmParseOutcome & { painted: number }> {
  const t0 = performance.now()
  const fetchFn = ctx.fetchFn ?? fetch
  const baseUrl = ctx.baseUrl ?? `http://${location.hostname}:8787`
  const payload: Record<string, unknown> = {
    utterance,
    mode,
    stream: true,
    scene: buildSceneSummary(ctx.scene, utterance, ctx.lastTransaction),
    ...(ctx.asrAlternatives !== undefined && ctx.asrAlternatives.length > 0 && { asr_alternatives: ctx.asrAlternatives }),
    ...(ctx.recent !== undefined && ctx.recent.length > 0 && { recent: ctx.recent }),
    ...(ctx.image !== undefined && { image: ctx.image }),
  }

  let res: Response
  try {
    res = await fetchFn(`${baseUrl}/api/llm/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    return { ok: false, error: `backend 不可达：${(e as Error).message}`, painted: 0 }
  }
  if (!res.ok || res.body === null) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    return { ok: false, error: body?.message ?? `backend ${res.status}`, painted: 0 }
  }

  const { OpStreamExtractor } = await import('./streamOps')
  const ex = new OpStreamExtractor()
  let painted = 0
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (const raw of ex.feed(decoder.decode(value, { stream: true }))) {
      // 渐进绘制门槛：明确 intent=ops 且置信度达标（字段顺序由 System Prompt 约定在 ops 之前）
      if (ex.head.intent !== 'ops') continue
      if (ex.head.confidence !== undefined && ex.head.confidence < 0.6) continue
      const r = opSchema.safeParse(raw)
      if (!r.success) continue // 单 Op 非法不上屏，整体校验兜底
      if (r.data.op === 'clear' || r.data.op === 'undo' || r.data.op === 'redo' || r.data.op === 'export') continue
      onOp(r.data)
      painted++
    }
  }

  const v = validateLlmOutput(ex.fullText(), mode)
  if (!v.ok) return { ok: false, error: `流式输出未通过校验：${v.error}`, painted }
  if (v.result.intent === 'ops' && painted !== v.result.ops.length) {
    // 渐进交付与终验清单不一致（极端乱序/字段后置），按失败处理走回滚+缓冲重试
    return { ok: false, error: `渐进交付不完整（${painted}/${v.result.ops.length}）`, painted }
  }
  return {
    ok: true,
    painted,
    result: {
      source: mode === 'plan' ? 'llm-plan' : 'llm-parse',
      ...v.result,
      latencyMs: performance.now() - t0,
    },
  }
}

export async function parseWithLlm(
  utterance: string,
  mode: 'parse' | 'plan',
  ctx: LlmCallContext,
): Promise<LlmParseOutcome> {
  const t0 = performance.now()
  const fetchFn = ctx.fetchFn ?? fetch
  const baseUrl = ctx.baseUrl ?? `http://${location.hostname}:8787`
  const payload: Record<string, unknown> = {
    utterance,
    mode,
    scene: buildSceneSummary(ctx.scene, utterance, ctx.lastTransaction),
    ...(ctx.asrAlternatives !== undefined && ctx.asrAlternatives.length > 0 && { asr_alternatives: ctx.asrAlternatives }),
    ...(ctx.recent !== undefined && ctx.recent.length > 0 && { recent: ctx.recent }),
    ...(ctx.image !== undefined && { image: ctx.image }),
  }

  const first = await callBackend(payload, fetchFn, baseUrl)
  if (!first.ok) return first
  let v = validateLlmOutput(first.content, mode)
  if (!v.ok) {
    // 重试 1 次：原输入 + 上一轮输出 + 校验错误（协议 §2.3）
    const second = await callBackend({ ...payload, retry: { previous: first.content, error: v.error } }, fetchFn, baseUrl)
    if (!second.ok) return second
    v = validateLlmOutput(second.content, mode)
    if (!v.ok) return { ok: false, error: `重试后仍未通过校验：${v.error}` }
  }
  return {
    ok: true,
    result: {
      source: mode === 'plan' ? 'llm-plan' : 'llm-parse',
      ...v.result,
      latencyMs: performance.now() - t0,
    },
  }
}

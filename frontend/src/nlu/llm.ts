/**
 * LLM 理解层前端客户端（协议 §2）
 *
 * 职责：构建 SceneSummary（§1.6，分层场景上下文）→ 调 backend /api/llm/parse
 * → JSON.parse + zod + 业务校验（§2.3 四条）→ 失败重试 1 次（追加校验错误）
 * → 输出与规则层同构的 ParseResult。clear 永不来自 LLM（业务校验拦截）。
 *
 * 分层设计（治多角色复杂场景"看不全/找不到角色"）：
 *   Layer 1 画布地图（永远全量）：所有组的 union 包围盒 + 成员名清单；未编组顶层对象摘要。
 *           不受任何截断——LLM 无论画布多复杂都看得到完整角色清单。
 *   Layer 2 聚焦详情（按需展开）：focus 所在组 + utterance 提到名字的组/对象，展开部件级细节。
 *           其余组只在地图层、不展开部件。展开部件总数 ≤ DETAIL_BUDGET（地图不计入）。
 */
import { z } from 'zod'
import { opSchema, type Op } from '../dsl'
import { getBBox, type SceneObject, type SceneState } from '../engine/scene'

// ---------- SceneSummary（协议 §1.6，v2 分层） ----------

/** 画布地图层：一个条目代表一个组或未编组顶层对象（永远全量给出） */
export interface CanvasMapEntry {
  /** 组名 / 对象名（对象有名时）/ 对象 id（无名时） */
  name: string
  /** 'group' | 'object' */
  kind: 'group' | 'object'
  /** union 包围盒（组内所有成员合并；单对象即自身 bbox）[x, y, w, h] */
  bbox: [number, number, number, number]
  /** 组/对象的几何中心 */
  center: [number, number]
  /** 成员数（group 才有；object 为 1） */
  memberCount: number
  /** 成员名清单（group 才有，对象可由此精确引用） */
  members?: string[]
  /** 组内对象的形状摘要（去重；group 才有，帮助 LLM 判断主体类型） */
  shapes?: string[]
}

/** 详情层：已展开部件级细节的对象列表 */
export interface DetailObject {
  id: string
  name?: string
  shape: string
  fill?: string
  stroke?: string
  center: [number, number]
  bbox: [number, number, number, number]
  z: number
  groupId?: string
}

export interface SceneSummary {
  canvas: { width: 1024; height: 768 }
  /** Layer 1：画布地图，永远全量（不截断） */
  canvasMap: CanvasMapEntry[]
  /** Layer 2：已展开部件详情（focus 所在组 + utterance 提及的组/对象） */
  details: DetailObject[]
  focusId?: string
  /** 人类可读焦点 + 粒度，让模型清楚"它"指什么、byFocus 会动什么（§5.1 v1.1） */
  focus?: { name?: string; id: string; scope: 'group' | 'object' }
  lastTransaction?: { utterance: string; opCount: number }
  /**
   * 是否有组因预算不足未在 details 中展开（地图层仍全量）。
   * 取代旧版"对象数量截断"的粗暴 truncated 标识。
   */
  truncated?: true
}

/** 展开部件级详情的预算（总部件数上限，地图层不计入） */
const DETAIL_BUDGET = 40

/** 计算 union 包围盒（合并多个对象的 [x,y,w,h]） */
function unionBBox(objects: SceneObject[]): [number, number, number, number] {
  if (objects.length === 0) return [0, 0, 0, 0]
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const o of objects) {
    const [bx, by, bw, bh] = getBBox(o)
    minX = Math.min(minX, bx)
    minY = Math.min(minY, by)
    maxX = Math.max(maxX, bx + bw)
    maxY = Math.max(maxY, by + bh)
  }
  return [Math.round(minX), Math.round(minY), Math.round(maxX - minX), Math.round(maxY - minY)]
}

/**
 * 分层场景上下文（协议 §2.2 v2）：
 *   画布地图永远全量（治"找不到角色"）；
 *   聚焦详情只对相关组展开（治 token 随对象数线性膨胀）。
 */
export function buildSceneSummary(
  scene: SceneState,
  utterance: string,
  lastTransaction?: { utterance: string; opCount: number },
): SceneSummary {
  // ---- Step 1：按 groupId 分桶 ----
  const groupBuckets = new Map<string, SceneObject[]>()   // groupId → 成员列表
  const ungrouped: SceneObject[] = []                     // 未编组对象
  for (const o of scene.objects) {
    if (o.groupId !== undefined) {
      const bucket = groupBuckets.get(o.groupId) ?? []
      bucket.push(o)
      groupBuckets.set(o.groupId, bucket)
    } else {
      ungrouped.push(o)
    }
  }

  // ---- Step 2：构建画布地图（Layer 1，永远全量） ----
  const canvasMap: CanvasMapEntry[] = []

  // 2a. 每个组
  for (const [groupId, members] of groupBuckets) {
    const ub = unionBBox(members)
    const cx = Math.round(ub[0] + ub[2] / 2)
    const cy = Math.round(ub[1] + ub[3] / 2)
    const memberNames = members.map((o) => o.name).filter((n): n is string => n !== undefined)
    const shapes = [...new Set(members.map((o) => o.shape))]
    canvasMap.push({
      name: groupId,
      kind: 'group',
      bbox: ub,
      center: [cx, cy],
      memberCount: members.length,
      members: memberNames.length > 0 ? memberNames : undefined,
      shapes,
    })
  }

  // 2b. 未编组的顶层对象
  for (const o of ungrouped) {
    const [bx, by, bw, bh] = getBBox(o)
    const cx = Math.round(bx + bw / 2)
    const cy = Math.round(by + bh / 2)
    const label = o.name ?? o.id
    canvasMap.push({
      name: label,
      kind: 'object',
      bbox: [bx, by, bw, bh],
      center: [cx, cy],
      memberCount: 1,
    })
  }

  // ---- Step 3：确定需展开详情的范围（Layer 2） ----
  // 3a. focus 所在组 / 对象
  const focusObj = scene.focusId !== undefined
    ? scene.objects.find((o) => o.id === scene.focusId)
    : undefined
  const relevantGroups = new Set<string>()
  const relevantIds = new Set<string>()

  if (focusObj !== undefined) {
    if (focusObj.groupId !== undefined) {
      relevantGroups.add(focusObj.groupId)
    } else {
      relevantIds.add(focusObj.id)
    }
  }

  // 3b. utterance 提及名字的组 / 对象
  for (const [groupId] of groupBuckets) {
    if (utterance.includes(groupId)) relevantGroups.add(groupId)
  }
  for (const o of scene.objects) {
    if (o.name !== undefined && utterance.includes(o.name)) {
      if (o.groupId !== undefined) {
        relevantGroups.add(o.groupId)
      } else {
        relevantIds.add(o.id)
      }
    }
  }

  // ---- Step 4：在预算内展开相关组/对象的部件详情 ----
  const details: DetailObject[] = []
  let budget = DETAIL_BUDGET
  let truncated = false

  function toDetail(o: SceneObject): DetailObject {
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
  }

  // 先展开相关组
  for (const groupId of relevantGroups) {
    const members = groupBuckets.get(groupId)
    if (members === undefined) continue
    if (budget <= 0) {
      truncated = true
      break
    }
    const toAdd = members.slice(0, budget)
    if (toAdd.length < members.length) truncated = true
    for (const o of toAdd) details.push(toDetail(o))
    budget -= toAdd.length
  }

  // 再展开相关未编组对象（逐个，各占 1 预算）
  for (const id of relevantIds) {
    if (budget <= 0) {
      truncated = true
      break
    }
    const o = scene.objects.find((x) => x.id === id)
    if (o === undefined) continue
    details.push(toDetail(o))
    budget--
  }

  return {
    canvas: { width: 1024, height: 768 },
    canvasMap,
    details,
    ...(scene.focusId !== undefined && {
      focusId: scene.focusId,
      focus: {
        ...(focusObj?.name !== undefined && { name: focusObj.name }),
        id: scene.focusId,
        scope: scene.focusScope ?? 'object',
      },
    }),
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

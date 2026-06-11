/**
 * DSL 解释器（规格 §5 执行语义）
 *
 * 已支持：create / style / move / delete / clear + 目标解析（§1.3）+ 焦点规则（§5.1）。
 * undo/redo 由上层 history.ts 快照栈处理（§5.4），不进入本解释器。
 * 暂不支持（按 PR 计划逐步消除，返回 UNSUPPORTED_OP）：
 * - 相对定位与自动布局（计划 PR #6）、
 *   resize/rotate/rename/setText/zorder/group/focus/export（随对应功能 PR 接入）
 *
 * executeTransaction 是纯函数：不修改入参，返回新 SceneState——
 * 这是 PR #4 快照式 undo 的前提。事务内逐 Op 执行，失败时保留已成功的 Op（协议 §1.5）。
 */
import type { CreateOp, Op, Position, SizeSpec, TargetSelector } from '../dsl'
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../dsl'
import { DEFAULT_STYLE, SEMANTIC_SIZE } from '../shared/lexicon'
import type { SceneObject, SceneState } from './scene'
import { getCenter } from './scene'

// ---------- 错误模型（协议 §1.5 错误码表） ----------

export type EngineErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'AMBIGUOUS_TARGET'
  | 'INVALID_OP'
  | 'NOTHING_TO_UNDO'
  | 'NOTHING_TO_REDO'
  | 'UNSUPPORTED_OP'

export interface EngineError {
  code: EngineErrorCode
  message: string
  /** AMBIGUOUS_TARGET 时的候选对象 id（供澄清流程列举，规格 §5.7） */
  candidateIds?: string[]
}

export interface ExecOutcome {
  state: SceneState
  /** 成功执行的 Op 数（失败时已成功的部分保留） */
  executed: number
  error?: EngineError
}

const err = (code: EngineErrorCode, message: string, candidateIds?: string[]): EngineError => ({
  code,
  message,
  ...(candidateIds ? { candidateIds } : {}),
})

// ---------- 目标解析（协议 §1.3 TargetSelector 解析规则） ----------

type ResolveResult = { ok: true; obj: SceneObject } | { ok: false; error: EngineError }

export function resolveTarget(state: SceneState, sel: TargetSelector): ResolveResult {
  if ('byId' in sel) {
    const obj = state.objects.find((o) => o.id === sel.byId)
    return obj ? { ok: true, obj } : { ok: false, error: err('TARGET_NOT_FOUND', `画布上没有 ${sel.byId}`) }
  }
  if ('byName' in sel) {
    const hits = state.objects.filter((o) => o.name === sel.byName)
    if (hits.length === 0) return { ok: false, error: err('TARGET_NOT_FOUND', `画布上没有「${sel.byName}」`) }
    if (hits.length > 1)
      return {
        ok: false,
        error: err('AMBIGUOUS_TARGET', `有 ${hits.length} 个「${sel.byName}」`, hits.map((o) => o.id)),
      }
    return { ok: true, obj: hits[0] }
  }
  if ('byFocus' in sel) {
    const obj = state.focusId ? state.objects.find((o) => o.id === state.focusId) : undefined
    return obj ? { ok: true, obj } : { ok: false, error: err('TARGET_NOT_FOUND', '当前没有焦点对象') }
  }
  // byQuery：按 shape/fill 过滤，createdSeq 排序后取 ordinal
  const q = sel.byQuery
  const hits = state.objects
    .filter((o) => (q.shape === undefined || o.shape === q.shape))
    .filter((o) => (q.fill === undefined || o.fill?.toLowerCase() === q.fill.toLowerCase()))
    .sort((a, b) => a.createdSeq - b.createdSeq)
  if (hits.length === 0) return { ok: false, error: err('TARGET_NOT_FOUND', '画布上没有符合条件的图形') }
  if (q.ordinal !== undefined) {
    const idx = q.ordinal === 'first' ? 0 : q.ordinal === 'last' ? hits.length - 1 : q.ordinal - 1
    const obj = hits[idx]
    return obj
      ? { ok: true, obj }
      : { ok: false, error: err('TARGET_NOT_FOUND', `只有 ${hits.length} 个符合条件的图形`) }
  }
  if (hits.length > 1)
    return {
      ok: false,
      error: err('AMBIGUOUS_TARGET', `有 ${hits.length} 个符合条件的图形`, hits.map((o) => o.id)),
    }
  return { ok: true, obj: hits[0] }
}

// ---------- 尺寸与几何（规格 §2.4 特征尺寸换算） ----------

type SizeResolution = { ok: true; v: number } | { ok: false; error: EngineError }

function resolveSize(spec: SizeSpec | undefined, fallback: number): SizeResolution {
  if (spec === undefined) return { ok: true, v: fallback }
  if (typeof spec === 'number') return { ok: true, v: spec }
  if (typeof spec === 'string') return { ok: true, v: SEMANTIC_SIZE[spec] }
  // {relativeTo, factor} 依赖 bbox 参照解析，随计划 PR #6（相对定位）支持
  return { ok: false, error: err('UNSUPPORTED_OP', '相对尺寸（relativeTo）将在后续 PR 支持') }
}

type GeometryResult = { ok: true; geo: Partial<SceneObject> } | { ok: false; error: EngineError }

/** 按 §2.4 表把特征尺寸 v 换算为各形状几何；width/height 显式给出时优先（rect/ellipse/circle） */
function buildGeometry(op: CreateOp): GeometryResult {
  const size = resolveSize(op.size, SEMANTIC_SIZE.medium)
  if (!size.ok) return size
  const v = size.v
  const width = resolveSize(op.width, NaN)
  if (!width.ok) return width
  const height = resolveSize(op.height, NaN)
  if (!height.ok) return height
  const w = width.v
  const h = height.v

  switch (op.shape) {
    case 'circle':
      return { ok: true, geo: { radius: Number.isNaN(w) ? v : w / 2 } }
    case 'ellipse':
      return {
        ok: true,
        geo: {
          radiusX: Number.isNaN(w) ? v : w / 2,
          radiusY: Number.isNaN(h) ? 0.6 * v : h / 2,
        },
      }
    case 'rect': {
      // 仅 size 时默认长方形（宽 2v 高 1.5v）；正方形由理解层显式给 width=height
      const rw = Number.isNaN(w) ? 2 * v : w
      return { ok: true, geo: { width: rw, height: Number.isNaN(h) ? 0.75 * rw : h } }
    }
    case 'triangle':
      // 边长 2v → 外接圆半径 R = 边长/√3
      return { ok: true, geo: { radius: (2 * v) / Math.sqrt(3) } }
    case 'star':
      return { ok: true, geo: { radius: v, innerRadius: 0.5 * v } }
    case 'line': {
      // 无 points 时生成水平线（长 3v），方向由 rotation 表达
      if (op.points) return { ok: true, geo: { points: op.points.flat() } }
      const len = 3 * v
      return { ok: true, geo: { points: [-len / 2, 0, len / 2, 0] } }
    }
    case 'polyline':
    case 'path':
      return { ok: true, geo: { points: (op.points ?? []).flat() } }
    case 'text':
      return { ok: true, geo: { text: op.text, fontSize: op.fontSize ?? Math.max(16, 0.5 * v) } }
  }
}

// ---------- 位置（绝对定位；相对/自动布局随 PR #6） ----------

type PositionResult = { ok: true; x: number; y: number } | { ok: false; error: EngineError }

function resolveCreatePosition(at: Position | undefined): PositionResult {
  if (at === undefined) {
    // 临时策略：画布中心。计划 PR #6 替换为 §5.2 自动布局算法
    return { ok: true, x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 }
  }
  if ('x' in at) return { ok: true, x: at.x, y: at.y }
  return { ok: false, error: err('UNSUPPORTED_OP', '相对定位（ref/anchor）将在后续 PR 支持') }
}

// ---------- 单 Op 执行 ----------

type OpResult = { ok: true; state: SceneState } | { ok: false; error: EngineError }

const LINE_SHAPES = new Set(['line', 'polyline'])

function execCreate(state: SceneState, op: CreateOp): OpResult {
  const geo = buildGeometry(op)
  if (!geo.ok) return geo
  const pos = resolveCreatePosition(op.at)
  if (!pos.ok) return pos

  const shapeSeq = (state.seqByShape[op.shape] ?? 0) + 1
  const id = `${op.shape}#${shapeSeq}`
  const isLine = LINE_SHAPES.has(op.shape)
  const isText = op.shape === 'text'
  const maxZ = state.objects.reduce((m, o) => Math.max(m, o.z), 0)

  const obj: SceneObject = {
    id,
    ...(op.name ? { name: op.name } : {}),
    shape: op.shape,
    x: pos.x,
    y: pos.y,
    ...geo.geo,
    // 缺省样式（规格 §2.4）：闭合图形缺省填充，线类缺省描边，文字缺省深色
    ...(isLine || isText
      ? {
          ...(isText ? { fill: op.fill ?? DEFAULT_STYLE.textFill } : {}),
          stroke: op.stroke ?? (isLine ? DEFAULT_STYLE.lineStroke : undefined),
          strokeWidth: op.strokeWidth ?? (isLine ? DEFAULT_STYLE.lineStrokeWidth : undefined),
        }
      : {
          fill: op.fill ?? DEFAULT_STYLE.fill,
          ...(op.stroke ? { stroke: op.stroke } : {}),
          ...(op.strokeWidth ? { strokeWidth: op.strokeWidth } : {}),
        }),
    rotation: op.rotation ?? 0,
    z: maxZ + 1,
    createdSeq: state.seq + 1,
  }

  return {
    ok: true,
    state: {
      objects: [...state.objects, obj],
      focusId: id, // 焦点规则 §5.1：create → 焦点 = 新对象
      seq: state.seq + 1,
      seqByShape: { ...state.seqByShape, [op.shape]: shapeSeq },
    },
  }
}

function patchObject(state: SceneState, id: string, patch: Partial<SceneObject>): SceneState {
  return {
    ...state,
    objects: state.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    focusId: id, // 焦点规则 §5.1：修改类操作 → 焦点 = 被操作对象
  }
}

function execOp(state: SceneState, op: Op): OpResult {
  switch (op.op) {
    case 'create':
      return execCreate(state, op)

    case 'style': {
      const t = resolveTarget(state, op.target)
      if (!t.ok) return t
      const patch: Partial<SceneObject> = {}
      if (op.fill !== undefined) patch.fill = op.fill
      if (op.stroke !== undefined) patch.stroke = op.stroke
      if (op.strokeWidth !== undefined) patch.strokeWidth = op.strokeWidth
      if (op.opacity !== undefined) patch.opacity = op.opacity
      return { ok: true, state: patchObject(state, t.obj.id, patch) }
    }

    case 'move': {
      const t = resolveTarget(state, op.target)
      if (!t.ok) return t
      if (op.delta) {
        return {
          ok: true,
          state: patchObject(state, t.obj.id, { x: t.obj.x + op.delta[0], y: t.obj.y + op.delta[1] }),
        }
      }
      // to：移动到目标中心（points 类图形按 bbox 中心换算）
      const to = op.to!
      if (!('x' in to)) return { ok: false, error: err('UNSUPPORTED_OP', '相对定位（ref/anchor）将在后续 PR 支持') }
      const c = getCenter(t.obj)
      return {
        ok: true,
        state: patchObject(state, t.obj.id, { x: t.obj.x + (to.x - c.x), y: t.obj.y + (to.y - c.y) }),
      }
    }

    case 'delete': {
      const t = resolveTarget(state, op.target)
      if (!t.ok) return t
      return {
        ok: true,
        state: {
          ...state,
          objects: state.objects.filter((o) => o.id !== t.obj.id),
          focusId: undefined, // 焦点规则 §5.1：delete → 焦点清空
        },
      }
    }

    case 'clear':
      // 普通事务语义、可被撤销（规格 §5.4）；id 计数不重置，保证 id 全程不复用
      return { ok: true, state: { ...state, objects: [], focusId: undefined } }

    default:
      return { ok: false, error: err('UNSUPPORTED_OP', `操作 ${op.op} 将在后续 PR 支持`) }
  }
}

// ---------- 事务执行（协议 §1.5） ----------

export function executeTransaction(state: SceneState, ops: Op[]): ExecOutcome {
  let current = state
  for (let i = 0; i < ops.length; i++) {
    const r = execOp(current, ops[i])
    if (!r.ok) return { state: current, executed: i, error: r.error }
    current = r.state
  }
  return { state: current, executed: ops.length }
}

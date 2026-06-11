/**
 * DSL 解释器（规格 §5 执行语义）
 *
 * 已支持：create / style / move / resize / rotate / rename / setText / delete /
 *         zorder / focus / export / clear + 目标解析（§1.3）+ 焦点规则（§5.1）
 *         + 自动布局/相对定位/越界 clamp（§5.2-5.5）+ 相对尺寸（§2.4）。
 * undo/redo 由上层 history.ts 快照栈处理（§5.4），不进入本解释器。
 * 暂不支持（返回 UNSUPPORTED_OP）：group/ungroup（随 plan 模式自动编组 PR 接入）
 *
 * executeTransaction 是纯函数：不修改入参，返回新 SceneState——
 * 这是快照式 undo 的前提。事务内逐 Op 执行，失败时保留已成功的 Op（协议 §1.5）。
 */
import type { CreateOp, Op, Position, SizeSpec, TargetSelector } from '../dsl'
import { CANVAS_PADDING, DEFAULT_GAP, DEFAULT_STYLE, SEMANTIC_SIZE } from '../shared/lexicon'
import { autoPlace, clampCenter, placeInside, placeOutside, type BBox, type Point } from './layout'
import type { SceneObject, SceneState } from './scene'
import { getBBox, getCenter } from './scene'

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
  /** 非错误提示（如越界 clamp，§5.5：不播报，调试面板可见） */
  notices?: string[]
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
    if (hits.length === 0) {
      // 名称也可指组（"把雪人移到右边"）：命中任一成员，几何类 Op 经组提升作用整组（§5.6）
      const member = state.objects.find((o) => o.groupId === sel.byName)
      if (member !== undefined) return { ok: true, obj: member }
      return { ok: false, error: err('TARGET_NOT_FOUND', `画布上没有「${sel.byName}」`) }
    }
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
  let hits = state.objects
    .filter((o) => (q.shape === undefined || o.shape === q.shape))
    .filter((o) => (q.fill === undefined || o.fill?.toLowerCase() === q.fill.toLowerCase()))
    .sort((a, b) => a.createdSeq - b.createdSeq)
  // §5.6：组内外都有命中时优先组外独立对象
  const ungrouped = hits.filter((o) => o.groupId === undefined)
  if (ungrouped.length > 0 && ungrouped.length < hits.length) hits = ungrouped
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

const bboxOf = (o: SceneObject): BBox => {
  const [x, y, w, h] = getBBox(o)
  return { x, y, w, h }
}

// ---------- group 引用语义（§5.6） ----------

/** 几何类 Op（move/resize/rotate/delete/zorder）目标命中组内成员时提升为整组 */
function membersOf(state: SceneState, obj: SceneObject): SceneObject[] {
  if (obj.groupId === undefined) return [obj]
  return state.objects.filter((o) => o.groupId === obj.groupId)
}

function unionBBox(objs: SceneObject[]): BBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const o of objs) {
    const b = bboxOf(o)
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** 批量修补对象 + 设置焦点（修改类操作焦点跟随，§5.1） */
function patchMany(
  state: SceneState,
  patches: ReadonlyMap<string, Partial<SceneObject>>,
  focusId: string,
): SceneState {
  return {
    ...state,
    objects: state.objects.map((o) => (patches.has(o.id) ? { ...o, ...patches.get(o.id) } : o)),
    focusId,
  }
}

// ---------- 尺寸与几何（规格 §2.4 特征尺寸换算 + 相对尺寸维度规则） ----------

type SizeDim = 'feature' | 'width' | 'height'
type SizeResolution = { ok: true; v: number } | { ok: false; error: EngineError }

function resolveSize(state: SceneState, spec: SizeSpec | undefined, fallback: number, dim: SizeDim): SizeResolution {
  if (spec === undefined) return { ok: true, v: fallback }
  if (typeof spec === 'number') return { ok: true, v: spec }
  if (typeof spec === 'string') return { ok: true, v: SEMANTIC_SIZE[spec] }
  // 相对尺寸维度规则（§2.4）：width → 参照宽；height → 参照高；size → max(参照宽,高)/2
  const t = resolveTarget(state, spec.relativeTo)
  if (!t.ok) return t
  const b = bboxOf(t.obj)
  const base = dim === 'width' ? b.w : dim === 'height' ? b.h : Math.max(b.w, b.h) / 2
  return { ok: true, v: spec.factor * base }
}

type GeometryResult = { ok: true; geo: Partial<SceneObject> } | { ok: false; error: EngineError }

/** 按 §2.4 表把特征尺寸 v 换算为各形状几何；width/height 显式给出时优先（rect/ellipse/circle） */
function buildGeometry(state: SceneState, op: CreateOp): GeometryResult {
  const size = resolveSize(state, op.size, SEMANTIC_SIZE.medium, 'feature')
  if (!size.ok) return size
  const v = size.v
  const width = resolveSize(state, op.width, NaN, 'width')
  if (!width.ok) return width
  const height = resolveSize(state, op.height, NaN, 'height')
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

/** 提取对象的几何字段子集（resize 缩放的作用域） */
function pickGeometry(o: SceneObject): Partial<SceneObject> {
  const out: Partial<SceneObject> = {}
  for (const k of ['radius', 'innerRadius', 'radiusX', 'radiusY', 'width', 'height', 'fontSize'] as const) {
    if (o[k] !== undefined) out[k] = o[k]
  }
  if (o.points) out.points = o.points
  return out
}

/** 等比缩放几何字段（§5.5 对象大于画布时） */
function scaleGeometry(geo: Partial<SceneObject>, s: number): Partial<SceneObject> {
  const out: Partial<SceneObject> = { ...geo }
  for (const k of ['radius', 'innerRadius', 'radiusX', 'radiusY', 'width', 'height', 'fontSize'] as const) {
    if (out[k] !== undefined) out[k] = out[k]! * s
  }
  if (out.points) out.points = out.points.map((p) => p * s)
  return out
}

// ---------- 位置解析（§5.2 自动布局 / §5.3 相对定位） ----------

type PositionResult = { ok: true; point: Point } | { ok: false; error: EngineError }

/** 解析 Position 为目标中心点（w/h 为待放置对象的 bbox 尺寸） */
function resolvePosition(state: SceneState, at: Position | undefined, w: number, h: number, focus?: SceneObject): PositionResult {
  if (at === undefined) {
    // §5.2 自动布局
    return { ok: true, point: autoPlace(state.objects.map(bboxOf), focus && bboxOf(focus), w, h) }
  }
  if ('x' in at) return { ok: true, point: { x: at.x, y: at.y } }
  // §5.3 相对定位
  let p: Point
  if (at.ref === 'canvas') {
    p = placeInside(w, h, at.anchor, at.gap ?? CANVAS_PADDING)
  } else {
    const t = resolveTarget(state, at.ref)
    if (!t.ok) return t
    p = placeOutside(bboxOf(t.obj), w, h, at.anchor, at.gap ?? DEFAULT_GAP)
  }
  if (at.offset) p = { x: p.x + at.offset[0], y: p.y + at.offset[1] }
  return { ok: true, point: p }
}

// ---------- 单 Op 执行 ----------

type OpResult = { ok: true; state: SceneState; notice?: string } | { ok: false; error: EngineError }

const LINE_SHAPES = new Set(['line', 'polyline'])

function execCreate(state: SceneState, op: CreateOp): OpResult {
  const geo = buildGeometry(state, op)
  if (!geo.ok) return geo

  // 探针对象：在 (0,0) 计算 bbox，得到尺寸与「中心相对锚点偏移」（points 类图形非零）
  const shapeSeq = (state.seqByShape[op.shape] ?? 0) + 1
  const id = `${op.shape}#${shapeSeq}`
  const probe = { id, shape: op.shape, x: 0, y: 0, rotation: 0, z: 0, createdSeq: 0, ...geo.geo } as SceneObject
  const [bx, by, bw, bh] = getBBox(probe)
  const centerOffset = { x: bx + bw / 2, y: by + bh / 2 }

  const focus = state.focusId ? state.objects.find((o) => o.id === state.focusId) : undefined
  const pos = resolvePosition(state, op.at, bw, bh, focus)
  if (!pos.ok) return pos

  // §5.5 clamp
  const c = clampCenter(pos.point.x, pos.point.y, bw, bh)
  const finalGeo = c.scale !== undefined ? scaleGeometry(geo.geo, c.scale) : geo.geo
  const s = c.scale ?? 1

  const isLine = LINE_SHAPES.has(op.shape)
  const isText = op.shape === 'text'
  const maxZ = state.objects.reduce((m, o) => Math.max(m, o.z), 0)

  const obj: SceneObject = {
    id,
    ...(op.name ? { name: op.name } : {}),
    shape: op.shape,
    x: c.x - centerOffset.x * s,
    y: c.y - centerOffset.y * s,
    ...finalGeo,
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
    ...(c.clamped ? { notice: `${id} 超出画布，已自动调整（§5.5 clamp）` } : {}),
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
      const members = membersOf(state, t.obj) // 组提升（§5.6）：整组一起移
      const b = members.length === 1 ? bboxOf(t.obj) : unionBBox(members)
      const cur = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
      let desired: Point
      if (op.delta) {
        desired = { x: cur.x + op.delta[0], y: cur.y + op.delta[1] }
      } else {
        const to = op.to!
        // move.to 解析与 create.at 一致（目标（组）bbox 尺寸参与外贴/内贴计算）
        const pos = resolvePosition(state, to, b.w, b.h)
        if (!pos.ok) return pos
        desired = pos.point
      }
      const c = clampCenter(desired.x, desired.y, b.w, b.h)
      const dx = c.x - cur.x
      const dy = c.y - cur.y
      const patches = new Map(members.map((m) => [m.id, { x: m.x + dx, y: m.y + dy }]))
      return {
        ok: true,
        state: patchMany(state, patches, t.obj.id),
        ...(c.clamped ? { notice: `${t.obj.groupId ?? t.obj.id} 已拉回画布内（§5.5 clamp）` } : {}),
      }
    }

    case 'delete': {
      const t = resolveTarget(state, op.target)
      if (!t.ok) return t
      const ids = new Set(membersOf(state, t.obj).map((m) => m.id)) // 组提升：整组删除
      return {
        ok: true,
        state: {
          ...state,
          objects: state.objects.filter((o) => !ids.has(o.id)),
          focusId: undefined, // 焦点规则 §5.1：delete → 焦点清空
        },
      }
    }

    case 'clear':
      // 普通事务语义、可被撤销（规格 §5.4）；id 计数不重置，保证 id 全程不复用
      return { ok: true, state: { ...state, objects: [], focusId: undefined } }

    case 'resize': {
      const t = resolveTarget(state, op.target)
      if (!t.ok) return t
      const o = t.obj
      const members = membersOf(state, o)
      if (members.length > 1) {
        // 组提升（§5.6）：等比缩放——成员几何缩放 + 成员中心绕组中心收放
        const gb = unionBBox(members)
        const gc = { x: gb.x + gb.w / 2, y: gb.y + gb.h / 2 }
        let s: number
        if (op.scale !== undefined) {
          s = op.scale
        } else {
          const to = op.to!
          const w = resolveSize(state, to.width, NaN, 'width')
          if (!w.ok) return w
          const h = resolveSize(state, to.height, NaN, 'height')
          if (!h.ok) return h
          s = !Number.isNaN(w.v) ? w.v / gb.w : h.v / gb.h
        }
        if (!Number.isFinite(s) || s <= 0) return { ok: false, error: err('INVALID_OP', 'resize 目标尺寸无效') }
        const nb = { x: gc.x - (gb.w * s) / 2, y: gc.y - (gb.h * s) / 2, w: gb.w * s, h: gb.h * s }
        const c = clampCenter(gc.x, gc.y, nb.w, nb.h)
        const patches = new Map(
          members.map((m) => [
            m.id,
            {
              ...scaleGeometry(pickGeometry(m), s),
              x: gc.x + (m.x - gc.x) * s + (c.x - gc.x),
              y: gc.y + (m.y - gc.y) * s + (c.y - gc.y),
            },
          ]),
        )
        return {
          ok: true,
          state: patchMany(state, patches, o.id),
          ...(c.clamped ? { notice: `${o.groupId} 已拉回画布内（§5.5 clamp）` } : {}),
        }
      }
      const b = bboxOf(o)
      let patch: Partial<SceneObject>
      if (op.scale !== undefined) {
        patch = scaleGeometry(pickGeometry(o), op.scale)
      } else {
        const to = op.to!
        const w = resolveSize(state, to.width, NaN, 'width')
        if (!w.ok) return w
        const h = resolveSize(state, to.height, NaN, 'height')
        if (!h.ok) return h
        if (o.shape === 'rect') {
          patch = {}
          if (!Number.isNaN(w.v)) patch.width = w.v
          if (!Number.isNaN(h.v)) patch.height = h.v
        } else if (o.shape === 'ellipse') {
          patch = {}
          if (!Number.isNaN(w.v)) patch.radiusX = w.v / 2
          if (!Number.isNaN(h.v)) patch.radiusY = h.v / 2
        } else {
          // 等比形状：以给出的维度对当前 bbox 的比例统一缩放（两者都给时取宽）
          const s = !Number.isNaN(w.v) ? w.v / b.w : h.v / b.h
          if (!Number.isFinite(s) || s <= 0) {
            return { ok: false, error: err('INVALID_OP', 'resize 目标尺寸无效') }
          }
          patch = scaleGeometry(pickGeometry(o), s)
        }
      }
      // 中心不动；缩放后 bbox 超出画布则拉回（§5.5）
      const nb = bboxOf({ ...o, ...patch })
      const cur = getCenter(o)
      const c = clampCenter(cur.x, cur.y, nb.w, nb.h)
      if (c.clamped) {
        patch.x = o.x + (c.x - cur.x)
        patch.y = o.y + (c.y - cur.y)
      }
      return {
        ok: true,
        state: patchObject(state, o.id, patch),
        ...(c.clamped ? { notice: `${o.id} 已拉回画布内（§5.5 clamp）` } : {}),
      }
    }

    case 'rotate': {
      const t = resolveTarget(state, op.target)
      if (!t.ok) return t
      const members = membersOf(state, t.obj)
      const norm = (r: number) => ((r % 360) + 360) % 360
      if (members.length > 1) {
        // 组提升：成员中心绕组中心旋转 + 各自自转
        const gb = unionBBox(members)
        const gc = { x: gb.x + gb.w / 2, y: gb.y + gb.h / 2 }
        const rad = (op.degrees * Math.PI) / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        const patches = new Map(
          members.map((m) => [
            m.id,
            {
              x: gc.x + (m.x - gc.x) * cos - (m.y - gc.y) * sin,
              y: gc.y + (m.x - gc.x) * sin + (m.y - gc.y) * cos,
              rotation: norm(m.rotation + op.degrees),
            },
          ]),
        )
        return { ok: true, state: patchMany(state, patches, t.obj.id) }
      }
      return { ok: true, state: patchObject(state, t.obj.id, { rotation: norm(t.obj.rotation + op.degrees) }) }
    }

    case 'rename': {
      const t = resolveTarget(state, op.target)
      if (!t.ok) return t
      return { ok: true, state: patchObject(state, t.obj.id, { name: op.name }) }
    }

    case 'setText': {
      const t = resolveTarget(state, op.target)
      if (!t.ok) return t
      if (t.obj.shape !== 'text') {
        return { ok: false, error: err('INVALID_OP', `${t.obj.id} 不是文字对象，无法改文本`) }
      }
      return { ok: true, state: patchObject(state, t.obj.id, { text: op.text }) }
    }

    case 'zorder': {
      const t = resolveTarget(state, op.target)
      if (!t.ok) return t
      const o = t.obj
      const members = membersOf(state, o)
      if (members.length > 1) {
        // 组提升：整组作为图层块整体移动，保持组内相对顺序
        const sortedMembers = [...members].sort((a, b) => a.z - b.z)
        const outside = state.objects.filter((x) => x.groupId !== o.groupId).map((x) => x.z)
        const blockMin = sortedMembers[0].z
        const blockMax = sortedMembers[sortedMembers.length - 1].z
        // anchor：块将落在 (anchor, anchor+1) 开区间内，组内顺序用分数偏移保持
        let anchor: number | null = null
        if (op.to === 'front') {
          anchor = outside.length > 0 ? Math.max(...outside) : null
        } else if (op.to === 'back') {
          anchor = outside.length > 0 ? Math.min(...outside) - 1 : null
        } else if (op.to === 'forward') {
          const above = outside.filter((z) => z > blockMax)
          anchor = above.length > 0 ? Math.min(...above) : null
        } else {
          const below = outside.filter((z) => z < blockMin)
          anchor = below.length > 0 ? Math.max(...below) - 1 : null
        }
        if (anchor === null) return { ok: true, state: patchObject(state, o.id, {}) } // 已在最前/最后
        const a = anchor
        const patches = new Map(sortedMembers.map((m, i) => [m.id, { z: a + (i + 1) / (sortedMembers.length + 1) }]))
        return { ok: true, state: patchMany(state, patches, o.id) }
      }
      const zs = state.objects.map((x) => x.z)
      let z = o.z
      if (op.to === 'front') z = Math.max(...zs) + 1
      else if (op.to === 'back') z = Math.min(...zs) - 1
      else {
        // forward/backward：与相邻层级交换 z（已在最前/最后则不变）
        const sorted = [...state.objects].sort((a, b) => a.z - b.z)
        const i = sorted.findIndex((x) => x.id === o.id)
        const j = op.to === 'forward' ? i + 1 : i - 1
        if (j < 0 || j >= sorted.length) {
          return { ok: true, state: patchObject(state, o.id, {}) }
        }
        const neighbor = sorted[j]
        return {
          ok: true,
          state: {
            ...state,
            objects: state.objects.map((x) =>
              x.id === o.id ? { ...x, z: neighbor.z } : x.id === neighbor.id ? { ...x, z: o.z } : x,
            ),
            focusId: o.id, // 焦点规则 §5.1：修改类操作 → 焦点 = 被操作对象
          },
        }
      }
      return { ok: true, state: patchObject(state, o.id, { z }) }
    }

    case 'focus': {
      const t = resolveTarget(state, op.target)
      if (!t.ok) return t
      return { ok: true, state: { ...state, focusId: t.obj.id } }
    }

    case 'group': {
      const objs: SceneObject[] = []
      for (const sel of op.targets) {
        const t = resolveTarget(state, sel)
        if (!t.ok) return t
        for (const m of membersOf(state, t.obj)) {
          if (!objs.some((x) => x.id === m.id)) objs.push(m) // 已在组内的成员并入新组
        }
      }
      if (objs.length < 2) return { ok: false, error: err('INVALID_OP', '编组至少需要两个对象') }
      // 组名：显式 name，否则"组N"；与现有组名/对象名冲突时加序号
      const taken = new Set<string>(
        state.objects.flatMap((o) => [o.groupId, o.name]).filter((x): x is string => x !== undefined),
      )
      const base = op.name ?? '组'
      let name = op.name ?? '组1'
      for (let i = 2; taken.has(name); i++) name = `${base}${i}`
      const patches = new Map(objs.map((m) => [m.id, { groupId: name }]))
      return { ok: true, state: patchMany(state, patches, objs[objs.length - 1].id), notice: `已编组：${name}（${objs.length} 个对象）` }
    }

    case 'ungroup': {
      const t = resolveTarget(state, op.target)
      if (!t.ok) return t
      if (t.obj.groupId === undefined) {
        return { ok: false, error: err('INVALID_OP', `${t.obj.id} 不在任何组里`) }
      }
      const groupId = t.obj.groupId
      // §5.6：成员保留各自 id 与 name，组名作废
      return {
        ok: true,
        state: {
          ...state,
          objects: state.objects.map((o) => {
            if (o.groupId !== groupId) return o
            const { groupId: _dropped, ...rest } = o
            return rest as SceneObject
          }),
          focusId: t.obj.id,
        },
      }
    }

    case 'export':
      // 引擎无状态变更（history 不入栈）；PNG 下载由前端在事务成功后触发
      return { ok: true, state, notice: '导出 PNG' }

    default:
      return { ok: false, error: err('UNSUPPORTED_OP', `操作 ${op.op} 将在后续 PR 支持`) }
  }
}

// ---------- 事务执行（协议 §1.5） ----------

export function executeTransaction(state: SceneState, ops: Op[]): ExecOutcome {
  let current = state
  const notices: string[] = []
  for (let i = 0; i < ops.length; i++) {
    const r = execOp(current, ops[i])
    if (!r.ok) return { state: current, executed: i, error: r.error, ...(notices.length ? { notices } : {}) }
    if (r.notice) notices.push(r.notice)
    current = r.state
  }
  return { state: current, executed: ops.length, ...(notices.length ? { notices } : {}) }
}

/**
 * 绘图 DSL Schema（dsl/1）
 *
 * 协议依据：docs/题目二-交互协议规范.md §1.2-1.4
 * 所有理解层（规则/LLM/调试面板）输出的 Op 必须先通过本 Schema 校验再进入执行引擎。
 * 对象采用 strict 模式：未知字段一律拒绝（LLM 输出字段拼错时立刻失败触发重试，
 * 而不是被静默丢弃后画出错误结果）。
 */
import { z } from 'zod'

/** 逻辑画布尺寸（协议 §1.2），物理尺寸由前端自适应缩放 */
export const CANVAS_WIDTH = 1024
export const CANVAS_HEIGHT = 768

// ---------- 基础类型（协议 §1.3） ----------

export const shapeKindSchema = z.enum([
  'circle',
  'ellipse',
  'rect',
  'triangle',
  'line',
  'polyline',
  'star',
  'text',
  'path',
])
export type ShapeKind = z.infer<typeof shapeKindSchema>

export const anchorSchema = z.enum([
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
])
export type Anchor = z.infer<typeof anchorSchema>

/** CSS 颜色串；中文颜色词在理解层完成映射（规格 §2.1），到达 DSL 时已是 CSS 值 */
export const colorSchema = z.string().min(1)
export type Color = z.infer<typeof colorSchema>

export const ordinalSchema = z.union([
  z.literal('first'),
  z.literal('last'),
  z.number().int().positive(),
])

const vec2Schema = z.tuple([z.number(), z.number()])

export const targetSelectorSchema = z.union([
  z.object({ byId: z.string().min(1) }).strict(),
  z.object({ byName: z.string().min(1) }).strict(),
  z.object({ byFocus: z.literal(true) }).strict(),
  z
    .object({
      byQuery: z
        .object({
          shape: shapeKindSchema.optional(),
          fill: colorSchema.optional(),
          ordinal: ordinalSchema.optional(),
        })
        .strict()
        .refine(
          (q) => q.shape !== undefined || q.fill !== undefined || q.ordinal !== undefined,
          { message: 'byQuery 至少需要一个查询条件' },
        ),
    })
    .strict(),
])
export type TargetSelector = z.infer<typeof targetSelectorSchema>

export const positionSchema = z.union([
  z.object({ x: z.number(), y: z.number() }).strict(),
  z
    .object({
      ref: z.union([z.literal('canvas'), targetSelectorSchema]),
      anchor: anchorSchema,
      offset: vec2Schema.optional(),
      gap: z.number().optional(),
      // ref 为对象时内贴（"门在房子底边"，协议 §1.3 v1.1）；ref=canvas 恒内贴，此字段无效
      inside: z.literal(true).optional(),
      // 边缘贴附（协议 §1.3 v1.3）：中心钉在参照真实形状边缘的 anchor 方向交点
      // （圆按圆周、椭圆按参数化、矩形按周界，bbox 锚定对曲线形状的斜向方位天然失效）
      onEdge: z.literal(true).optional(),
    })
    .strict(),
])
export type Position = z.infer<typeof positionSchema>

export const sizeSpecSchema = z.union([
  z.number().positive(),
  z
    .object({
      relativeTo: targetSelectorSchema,
      factor: z.number().positive(),
    })
    .strict(),
  z.enum(['small', 'medium', 'large']),
])
export type SizeSpec = z.infer<typeof sizeSpecSchema>

// ---------- 操作指令集（协议 §1.4） ----------
// 注意：discriminatedUnion 要求成员为纯 ZodObject，跨字段约束统一放在 opSchema.superRefine。

const createOpSchema = z
  .object({
    op: z.literal('create'),
    shape: shapeKindSchema,
    name: z.string().min(1).optional(),
    at: positionSchema.optional(), // 缺省 → 引擎自动布局（规格 §5.2）
    size: sizeSpecSchema.optional(), // 含义随 shape：圆=半径，矩形=宽（规格 §2.4）
    width: sizeSpecSchema.optional(), // 显式宽高优先于 size
    height: sizeSpecSchema.optional(),
    points: z.array(vec2Schema).min(2).optional(), // line/polyline/path 用
    text: z.string().optional(),
    fontSize: z.number().positive().optional(),
    fill: colorSchema.optional(),
    stroke: colorSchema.optional(),
    strokeWidth: z.number().positive().optional(),
    rotation: z.number().optional(), // 角度，顺时针为正
    desc: z.string().optional(), // plan 模式进度播报文案
  })
  .strict()

const styleOpSchema = z
  .object({
    op: z.literal('style'),
    target: targetSelectorSchema,
    fill: colorSchema.optional(),
    stroke: colorSchema.optional(),
    strokeWidth: z.number().positive().optional(),
    opacity: z.number().min(0).max(1).optional(),
  })
  .strict()

const moveOpSchema = z
  .object({
    op: z.literal('move'),
    target: targetSelectorSchema,
    to: positionSchema.optional(),
    delta: vec2Schema.optional(),
  })
  .strict()

const resizeOpSchema = z
  .object({
    op: z.literal('resize'),
    target: targetSelectorSchema,
    scale: z.number().positive().optional(),
    to: z
      .object({
        width: sizeSpecSchema.optional(),
        height: sizeSpecSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const rotateOpSchema = z
  .object({
    op: z.literal('rotate'),
    target: targetSelectorSchema,
    degrees: z.number(), // 正=顺时针，负=逆时针
  })
  .strict()

const setTextOpSchema = z
  .object({
    op: z.literal('setText'),
    target: targetSelectorSchema,
    text: z.string().min(1),
  })
  .strict()

const deleteOpSchema = z
  .object({
    op: z.literal('delete'),
    target: targetSelectorSchema,
  })
  .strict()

const renameOpSchema = z
  .object({
    op: z.literal('rename'),
    target: targetSelectorSchema,
    name: z.string().min(1),
  })
  .strict()

const groupOpSchema = z
  .object({
    op: z.literal('group'),
    targets: z.array(targetSelectorSchema).min(2),
    name: z.string().min(1).optional(),
  })
  .strict()

const ungroupOpSchema = z
  .object({
    op: z.literal('ungroup'),
    target: targetSelectorSchema,
  })
  .strict()

const zorderOpSchema = z
  .object({
    op: z.literal('zorder'),
    target: targetSelectorSchema,
    to: z.enum(['front', 'back', 'forward', 'backward']),
  })
  .strict()

const undoOpSchema = z
  .object({
    op: z.literal('undo'),
    steps: z.number().int().positive().optional(), // 缺省 1
  })
  .strict()

const redoOpSchema = z
  .object({
    op: z.literal('redo'),
    steps: z.number().int().positive().optional(),
  })
  .strict()

const clearOpSchema = z
  .object({
    op: z.literal('clear'), // 破坏性：仅规则层可产生，须经语音确认（协议 §4.3）
  })
  .strict()

const focusOpSchema = z
  .object({
    op: z.literal('focus'),
    target: targetSelectorSchema,
  })
  .strict()

const exportOpSchema = z
  .object({
    op: z.literal('export'),
    format: z.literal('png'),
  })
  .strict()

export const opSchema = z
  .discriminatedUnion('op', [
    createOpSchema,
    styleOpSchema,
    moveOpSchema,
    resizeOpSchema,
    rotateOpSchema,
    setTextOpSchema,
    deleteOpSchema,
    renameOpSchema,
    groupOpSchema,
    ungroupOpSchema,
    zorderOpSchema,
    undoOpSchema,
    redoOpSchema,
    clearOpSchema,
    focusOpSchema,
    exportOpSchema,
  ])
  .superRefine((op, ctx) => {
    switch (op.op) {
      case 'create':
        if (op.shape === 'text' && !op.text) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'text 图形必须提供 text 内容', path: ['text'] })
        }
        if ((op.shape === 'polyline' || op.shape === 'path') && !op.points) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${op.shape} 必须提供 points`, path: ['points'] })
        }
        break
      case 'move':
        if ((op.to === undefined) === (op.delta === undefined)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'move 需要 to 或 delta 之一（且仅一个）' })
        }
        break
      case 'resize': {
        if ((op.scale === undefined) === (op.to === undefined)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'resize 需要 scale 或 to 之一（且仅一个）' })
        }
        if (op.to !== undefined && op.to.width === undefined && op.to.height === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'resize.to 至少需要 width 或 height', path: ['to'] })
        }
        break
      }
      case 'style':
        if (
          op.fill === undefined &&
          op.stroke === undefined &&
          op.strokeWidth === undefined &&
          op.opacity === undefined
        ) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'style 至少需要一个样式字段' })
        }
        break
    }
  })

export type Op = z.infer<typeof opSchema>
export type CreateOp = Extract<Op, { op: 'create' }>
export type StyleOp = Extract<Op, { op: 'style' }>
export type MoveOp = Extract<Op, { op: 'move' }>
export type ResizeOp = Extract<Op, { op: 'resize' }>

/** 一次解析结果（Op 数组）作为一个事务进 undo 栈（协议 §1.5） */
export const transactionSchema = z.array(opSchema).min(1)

// ---------- 校验入口 ----------

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('；')
}

export type ParseOpResult = { ok: true; op: Op } | { ok: false; error: string }

export function parseOp(input: unknown): ParseOpResult {
  const r = opSchema.safeParse(input)
  return r.success ? { ok: true, op: r.data } : { ok: false, error: formatZodError(r.error) }
}

export type ParseOpsResult = { ok: true; ops: Op[] } | { ok: false; error: string }

export function parseOps(input: unknown): ParseOpsResult {
  const r = transactionSchema.safeParse(input)
  return r.success ? { ok: true, ops: r.data } : { ok: false, error: formatZodError(r.error) }
}

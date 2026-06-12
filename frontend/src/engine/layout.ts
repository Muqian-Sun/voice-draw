/**
 * 自动布局（规格 §5.2）、相对定位（§5.3）与越界 clamp（§5.5）
 *
 * 本模块只做纯几何计算，不依赖场景图与目标解析（参照物 bbox 由调用方传入），
 * 全部算法确定性（无随机），保证可单测。
 */
import { CANVAS_WIDTH, CANVAS_HEIGHT, type Anchor } from '../dsl'
import { AUTO_LAYOUT_GAP, CANVAS_PADDING } from '../shared/lexicon'

export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

const centerX = (b: BBox) => b.x + b.w / 2
const centerY = (b: BBox) => b.y + b.h / 2

/** 严格相交（边缘相切不算重叠） */
export function overlaps(a: BBox, b: BBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

const insideCanvas = (b: BBox): boolean =>
  b.x >= 0 && b.y >= 0 && b.x + b.w <= CANVAS_WIDTH && b.y + b.h <= CANVAS_HEIGHT

/** §5.3 ref=对象 → 外贴。返回新对象（尺寸 w×h）的中心点 */
export function placeOutside(ref: BBox, w: number, h: number, anchor: Anchor, gap: number): Point {
  switch (anchor) {
    case 'left':
      return { x: ref.x - gap - w / 2, y: centerY(ref) }
    case 'right':
      return { x: ref.x + ref.w + gap + w / 2, y: centerY(ref) }
    case 'top':
      return { x: centerX(ref), y: ref.y - gap - h / 2 }
    case 'bottom':
      return { x: centerX(ref), y: ref.y + ref.h + gap + h / 2 }
    // 四角：新对象同名对角点贴参照角，向外偏 gap（§5.3）
    case 'top-left':
      return { x: ref.x - gap - w / 2, y: ref.y - gap - h / 2 }
    case 'top-right':
      return { x: ref.x + ref.w + gap + w / 2, y: ref.y - gap - h / 2 }
    case 'bottom-left':
      return { x: ref.x - gap - w / 2, y: ref.y + ref.h + gap + h / 2 }
    case 'bottom-right':
      return { x: ref.x + ref.w + gap + w / 2, y: ref.y + ref.h + gap + h / 2 }
    case 'center':
      return { x: centerX(ref), y: centerY(ref) } // 叠放（画雪人眼睛等场景）
  }
}

/** §5.3 内贴（ref=canvas 或对象 inside:true）：贴参照 bbox 对应边/角内侧。返回新对象中心点 */
export function placeInsideBBox(ref: BBox, w: number, h: number, anchor: Anchor, pad: number): Point {
  const L = ref.x + pad + w / 2
  const R = ref.x + ref.w - pad - w / 2
  const T = ref.y + pad + h / 2
  const B = ref.y + ref.h - pad - h / 2
  const CX = centerX(ref)
  const CY = centerY(ref)
  switch (anchor) {
    case 'center':
      return { x: CX, y: CY }
    case 'left':
      return { x: L, y: CY }
    case 'right':
      return { x: R, y: CY }
    case 'top':
      return { x: CX, y: T }
    case 'bottom':
      return { x: CX, y: B }
    case 'top-left':
      return { x: L, y: T }
    case 'top-right':
      return { x: R, y: T }
    case 'bottom-left':
      return { x: L, y: B }
    case 'bottom-right':
      return { x: R, y: B }
  }
}

/** §5.3 ref=canvas → 内贴（placeInsideBBox 的画布特例） */
export function placeInside(w: number, h: number, anchor: Anchor, pad: number): Point {
  return placeInsideBBox({ x: 0, y: 0, w: CANVAS_WIDTH, h: CANVAS_HEIGHT }, w, h, anchor, pad)
}

export interface ClampResult extends Point {
  clamped: boolean
  /** 对象大于画布平移无解时的等比缩小系数（§5.5：缩至画布 90% 后居中） */
  scale?: number
}

/** §5.5 越界 clamp：先平移最小距离入界；对象大于画布则等比缩小 90% 居中 */
export function clampCenter(x: number, y: number, w: number, h: number): ClampResult {
  if (w > CANVAS_WIDTH || h > CANVAS_HEIGHT) {
    const scale = 0.9 * Math.min(CANVAS_WIDTH / w, CANVAS_HEIGHT / h)
    return { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2, clamped: true, scale }
  }
  const nx = Math.min(Math.max(x, w / 2), CANVAS_WIDTH - w / 2)
  const ny = Math.min(Math.max(y, h / 2), CANVAS_HEIGHT - h / 2)
  return { x: nx, y: ny, clamped: nx !== x || ny !== y }
}

/** §5.2 自动布局（create 缺省 at）：确定性算法 */
export function autoPlace(existing: BBox[], focus: BBox | undefined, w: number, h: number): Point {
  const CENTER: Point = { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 }
  if (existing.length === 0) return CENTER

  const fits = (p: Point): boolean => {
    const b: BBox = { x: p.x - w / 2, y: p.y - h / 2, w, h }
    return insideCanvas(b) && existing.every((e) => !overlaps(b, e))
  }

  // 2. 有焦点对象：依次尝试 右/下/左/上（gap=40）
  if (focus) {
    for (const anchor of ['right', 'bottom', 'left', 'top'] as const) {
      const p = placeOutside(focus, w, h, anchor, AUTO_LAYOUT_GAP)
      if (fits(p)) return p
    }
  }
  // 3. 画布九宫格锚点（内边距 40）
  const GRID: Anchor[] = ['center', 'top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right']
  for (const anchor of GRID) {
    const p = placeInside(w, h, anchor, CANVAS_PADDING)
    if (fits(p)) return p
  }
  // 4. 画布很满：center 叠放，不报错
  return CENTER
}

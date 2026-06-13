/**
 * 自由画笔引擎（research：feat/freehand-pen）
 * ============================================
 * 新范式：画作 = 有序「运笔笔触 Stroke」，墨水笔刷质感，逐笔动画绘制（看得见笔在画）。
 * 与现有"组件/图元引擎"正交——这里只研究"把一条运笔轨迹画成漂亮的、会动的墨迹"的算法。
 *
 * 纯几何，无 DOM/框架依赖（渲染在 FreehandStage 里）。坐标系：画布绝对坐标。
 *
 * 算法链：
 *  1) 锚点 → Catmull-Rom 采样出稠密中心线（运笔轨迹）
 *  2) 中心线 → 累计弧长（匀速运笔、按长度渐进显墨的基准）
 *  3) 中心线 + 宽度剖面 → 变宽墨带 ribbon 轮廓（沿法向 ±w/2 偏移，两端收笔 taper）
 *  4) 给定已绘长度 L → 截取前缀中心线 + 笔尖位置/切向（供动画逐帧显墨 + 画笔尖）
 */

export type Pt = [number, number]

export interface Stroke {
  pts: Pt[] // 锚点（≥2），画布坐标
  closed?: boolean // 闭合轮廓（首尾相接）
  color?: string // 墨色（缺省深墨）
  width?: number // 基础笔宽 px（缺省 8）
  taper?: boolean // 开放笔画两端收笔（落笔/收笔由细到粗到细，缺省 true）
  fill?: string // 闭合时可选填充
  smooth?: boolean // 缺省/true=向心 CR 平滑（有机曲线）；false=保持直线段（多边形/矩形不被圆角化）
}

/** 均匀 Catmull-Rom（张力隐含 0.5）在 p1→p2 段参数 t 处取点 */
function crPoint(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const t2 = t * t
  const t3 = t2 * t
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]
}

/** 锚点 → 稠密中心线。perSeg=每段采样数；closed 环绕取邻居。点数<2 原样返回 */
export function sampleCenterline(pts: Pt[], closed = false, perSeg = 18): Pt[] {
  const n = pts.length
  if (n < 2) return pts.slice()
  const at = (i: number): Pt => {
    let j: number
    if (closed) j = ((i % n) + n) % n
    else j = i < 0 ? 0 : i >= n ? n - 1 : i
    return pts[j]
  }
  const out: Pt[] = []
  const segCount = closed ? n : n - 1
  for (let s = 0; s < segCount; s++) {
    const p0 = at(s - 1)
    const p1 = at(s)
    const p2 = at(s + 1)
    const p3 = at(s + 2)
    for (let k = 0; k < perSeg; k++) out.push(crPoint(p0, p1, p2, p3, k / perSeg))
  }
  out.push(closed ? at(0) : at(n - 1)) // 收尾点
  return out
}

/** 直线段稠密化（不平滑）：每段线性插值出 perSeg 个点，供匀速显墨/墨带用，
 *  保持多边形棱角（矩形/三角不被 CR 圆角化）。closed=true 末段回到首点。 */
export function densifyLinear(pts: Pt[], closed = false, perSeg = 7): Pt[] {
  const n = pts.length
  if (n < 2) return pts.slice()
  const out: Pt[] = []
  const segCount = closed ? n : n - 1
  for (let s = 0; s < segCount; s++) {
    const a = pts[s]
    const b = pts[(s + 1) % n]
    for (let k = 0; k < perSeg; k++) out.push([a[0] + ((b[0] - a[0]) * k) / perSeg, a[1] + ((b[1] - a[1]) * k) / perSeg])
  }
  out.push(closed ? pts[0] : pts[n - 1])
  return out
}

/** 稠密折线 → 累计弧长（长度 = points.length，首元素 0） */
export function cumulativeLengths(points: Pt[]): number[] {
  const cum = [0]
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0]
    const dy = points[i][1] - points[i - 1][1]
    cum.push(cum[i - 1] + Math.hypot(dx, dy))
  }
  return cum
}

/** 截取中心线"已绘长度 L"的前缀（末端按 L 在段内插值，平滑生长） */
export function sliceUpTo(points: Pt[], cum: number[], L: number): Pt[] {
  if (points.length === 0) return []
  if (L <= 0) return [points[0]]
  const total = cum[cum.length - 1]
  if (L >= total) return points.slice()
  const out: Pt[] = []
  for (let i = 0; i < points.length; i++) {
    if (cum[i] <= L) {
      out.push(points[i])
    } else {
      const i0 = i - 1
      const segLen = cum[i] - cum[i0]
      const f = segLen > 0 ? (L - cum[i0]) / segLen : 0
      out.push([
        points[i0][0] + (points[i][0] - points[i0][0]) * f,
        points[i0][1] + (points[i][1] - points[i0][1]) * f,
      ])
      break
    }
  }
  return out
}

/** 笔尖：已绘长度 L 处的位置 + 切向角（弧度，用于画"笔在动"） */
export function tipAt(points: Pt[], cum: number[], L: number): { pt: Pt; angle: number } {
  const slice = sliceUpTo(points, cum, L)
  const pt = slice[slice.length - 1] ?? points[0] ?? [0, 0]
  const prev = slice[slice.length - 2] ?? points[0] ?? pt
  return { pt, angle: Math.atan2(pt[1] - prev[1], pt[0] - prev[0]) }
}

// 变宽墨带轮廓改由 perfect-freehand 的 getStroke 生成（尖角不夹断、含笔帽/收笔/速度模拟压感），
// 原朴素 ribbonOutline/widthProfile 已移除（见 FreehandStage.paintStroke）。

/** 确定性伪随机 mulberry32：同 seed → 同序列。用它而非 Math.random，使手绘抖动逐帧稳定（不闪）、可单测 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 手绘抖动（借 Rough.js 技法，无三方依赖）：每段插入一个**垂向偏移的弓形中点** + 轻扰角点，
 * 让直线/多边形边也"弯一点"像手画；幅度随边长温和增长并设上限（短边不过弯、长边不失控）。
 * 确定性（seed 驱动 mulberry32）→ 同一笔每帧一致、不闪。roughness<=0 原样返回。
 * 输出再交给 sampleCenterline（平滑）或 densifyLinear（保棱角）。
 */
export function roughen(pts: Pt[], closed: boolean, roughness: number, seed = 1): Pt[] {
  if (roughness <= 0 || pts.length < 2) return pts.slice()
  const rng = mulberry32(seed)
  const r = () => rng() * 2 - 1 // [-1,1]
  const n = pts.length
  const segs = closed ? n : n - 1
  const out: Pt[] = []
  for (let s = 0; s < segs; s++) {
    const a = pts[s]
    const b = pts[(s + 1) % n]
    out.push([a[0] + r() * roughness * 0.5, a[1] + r() * roughness * 0.5]) // 轻扰角点
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy) || 1
    const px = -dy / len // 垂向单位向量
    const py = dx / len
    const bow = r() * Math.min(roughness * 1.6, len * 0.06) // 弓形量，按边长限幅
    out.push([
      (a[0] + b[0]) / 2 + px * bow + r() * roughness * 0.4,
      (a[1] + b[1]) / 2 + py * bow + r() * roughness * 0.4,
    ])
  }
  if (!closed) {
    const last = pts[n - 1]
    out.push([last[0] + r() * roughness * 0.5, last[1] + r() * roughness * 0.5])
  }
  return out
}

/**
 * 组件引擎场景 → 自由画笔笔触（research：feat/freehand-pen）
 * ====================================================
 * 回答研究核心问题"谁生成 stroke"：**复用可靠的组件/图元引擎产出的 SceneObject[]，
 * 把每个图元拆解成"人会怎么运笔画它"的笔触**，再交给自由画笔逐笔动画重绘。
 *
 * 这样：构图/创意仍由组件引擎（LLM 拼装图元）负责——稳；呈现改为手绘动画——美。
 * 既不踩"组件覆盖封顶/同质化"（题材仍由 LLM 自由拼），也不丢"可编辑"（源仍是场景图）。
 *
 * 与现有 Konva 渲染正交：本模块只做 SceneObject → Stroke 的几何拆解（纯函数，可测）。
 */
import type { SceneObject, SceneState } from '../engine/scene'
import type { Pt, Stroke } from './engine'

const INK = '#2b2b2b'

/** 绕中心 (cx,cy) 旋转 deg 度（Konva 约定：屏幕系顺时针为正） */
function rot(px: number, py: number, cx: number, cy: number, deg: number): Pt {
  if (!deg) return [px, py]
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const dx = px - cx
  const dy = py - cy
  return [cx + dx * c - dy * s, cy + dx * s + dy * c]
}

/** 椭圆/圆弧采样为绝对坐标点（a0→a1 弧度，n+1 点） */
function ellPts(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n: number): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Pt
  })
}

/** 单个图元 → 0~1 条笔触（text 暂不拆笔，返回空） */
export function objectToStrokes(o: SceneObject): Stroke[] {
  const deg = o.rotation || 0
  const R = (pts: Pt[]): Pt[] => (deg ? pts.map((p) => rot(p[0], p[1], o.x, o.y, deg)) : pts)
  const ink = o.stroke ?? o.fill ?? INK
  const fill = o.fill ?? o.gradient?.from // Stroke 仅支持纯色填充，渐变近似取起始色
  const base = (closed: boolean, pts: Pt[], smooth: boolean): Stroke => ({
    pts: R(pts),
    closed,
    smooth,
    color: ink,
    width: o.strokeWidth ?? (o.stroke ? 3 : 5),
    taper: !closed,
    ...(closed && fill ? { fill } : {}),
  })

  switch (o.shape) {
    case 'circle': {
      const r = o.radius ?? 0
      return [base(true, ellPts(o.x, o.y, r, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2, 40), true)]
    }
    case 'ellipse': {
      const rx = o.radiusX ?? 0
      const ry = o.radiusY ?? 0
      return [base(true, ellPts(o.x, o.y, rx, ry, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2, 40), true)]
    }
    case 'rect': {
      const w = o.width ?? 0
      const h = o.height ?? 0
      const x = o.x
      const y = o.y
      const corners: Pt[] = [
        [x - w / 2, y - h / 2],
        [x + w / 2, y - h / 2],
        [x + w / 2, y + h / 2],
        [x - w / 2, y + h / 2],
      ]
      return [base(true, corners, (o.cornerRadius ?? 0) > 0)] // 圆角矩形→平滑，直角→棱角
    }
    case 'triangle': {
      const r = o.radius ?? 0
      const verts: Pt[] = [-90, 30, 150].map((d) => {
        const a = (d * Math.PI) / 180
        return [o.x + r * Math.cos(a), o.y + r * Math.sin(a)]
      })
      return [base(true, verts, false)]
    }
    case 'star': {
      const ro = o.radius ?? 0
      const ri = o.innerRadius ?? ro * 0.5
      const pts: Pt[] = []
      for (let i = 0; i < 10; i++) {
        const a = (-90 + i * 36) * (Math.PI / 180)
        const rr = i % 2 === 0 ? ro : ri
        pts.push([o.x + rr * Math.cos(a), o.y + rr * Math.sin(a)])
      }
      return [base(true, pts, false)]
    }
    case 'arc': {
      const ro = o.radius ?? 0
      const ri = o.innerRadius ?? 0
      const sweep = o.angle ?? 270
      const a0 = (deg * Math.PI) / 180 // arc 的 rotation 即起始角，已并入 deg；故此处不再二次旋转
      const a1 = a0 + (sweep * Math.PI) / 180
      const n = Math.max(8, Math.round(sweep / 8))
      const outer = ellPts(o.x, o.y, ro, ro, a0, a1, n)
      // innerRadius>0：圆环弧（外弧+内弧反向）闭合成带——月牙/彩虹带/扇环
      if (ri > 0) {
        return [
          {
            pts: outer.concat(ellPts(o.x, o.y, ri, ri, a1, a0, n)),
            closed: true,
            smooth: false,
            color: ink,
            width: o.strokeWidth ?? (o.stroke ? 3 : 5),
            taper: false,
            ...(fill ? { fill } : {}),
          },
        ]
      }
      // innerRadius=0：作为**开放弧线**画（嘴/彩虹/笑弧）——只描弧本身，不连回圆心、不填成实心饼。
      // （此前 [圆心,...弧] 闭合 + 默认填充 → 嘴被画成实心扇形饼，是"嘴对不正"的根因。）
      return [
        {
          pts: outer,
          closed: false,
          smooth: true,
          color: o.stroke ?? INK, // 弧线用描边色；无描边回退墨色（不取默认填充蓝）
          width: o.strokeWidth ?? 6,
          taper: false,
        },
      ]
    }
    case 'line':
    case 'polyline':
    case 'path': {
      const flat = o.points ?? []
      if (flat.length < 4) return []
      const pts: Pt[] = []
      for (let i = 0; i < flat.length; i += 2) pts.push([o.x + flat[i], o.y + flat[i + 1]])
      const closed = o.shape === 'path'
      const smooth = (o.tension ?? 0) > 0
      return [base(closed, pts, smooth)]
    }
    case 'text':
      return [] // 文字暂不拆笔（手写字形是另一专题），由调用方决定是否另行贴字
    case 'vpath':
      return [] // v2.0 贝塞尔矢量路径：由渲染器走清晰 Path2D，不拆成手绘笔触
  }
}

/** SVG path d（M/L/C/Q/Z 绝对坐标）→ 子路径折线 + 是否闭合(Z)。贝塞尔按定步采样；
 *  支持隐式重复命令（M 之后续坐标按 L）；非法 token 跳过、NaN 点滤除，避免死循环/坏点。 */
export function flattenPathD(d: string): Array<{ pts: Pt[]; closed: boolean }> {
  const out: Array<{ pts: Pt[]; closed: boolean }> = []
  const toks = d.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  let i = 0
  let cur: Pt[] = []
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  let cmd = ''
  const num = () => parseFloat(toks[i++])
  const cubic = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    for (let k = 1; k <= 16; k++) {
      const t = k / 16
      const m = 1 - t
      cur.push([
        m * m * m * x + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x3,
        m * m * m * y + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y3,
      ])
    }
    x = x3
    y = y3
  }
  const quad = (x1: number, y1: number, x2: number, y2: number) => {
    for (let k = 1; k <= 12; k++) {
      const t = k / 12
      const m = 1 - t
      cur.push([m * m * x + 2 * m * t * x1 + t * t * x2, m * m * y + 2 * m * t * y1 + t * t * y2])
    }
    x = x2
    y = y2
  }
  const flush = (closed: boolean) => {
    const pts = cur.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    if (pts.length >= 2) out.push({ pts, closed })
    cur = []
  }
  while (i < toks.length) {
    if (/[MLCQZmlcqz]/.test(toks[i])) {
      cmd = toks[i]
      i++
    }
    const c = cmd.toUpperCase()
    if (c === 'M') {
      flush(false)
      x = num()
      y = num()
      sx = x
      sy = y
      cur = [[x, y]]
      cmd = 'L' // SVG：M 之后的续坐标组按 L 处理
    } else if (c === 'L') {
      x = num()
      y = num()
      cur.push([x, y])
    } else if (c === 'C') {
      cubic(num(), num(), num(), num(), num(), num())
    } else if (c === 'Q') {
      quad(num(), num(), num(), num())
    } else if (c === 'Z') {
      cur.push([sx, sy])
      flush(true)
      x = sx
      y = sy
    } else {
      i++ // 无法识别（如开头杂散数字）→ 跳过，防死循环
    }
  }
  flush(false)
  return out
}

/**
 * v2.0 vpath 逐笔手绘：把 path d 采样成轮廓折线笔触，供动画"描轮廓 + 填色"看绘制过程。
 * 落定后渲染器改走清晰 Path2D（drawVPath）出最终质感（渐变/投影），故此处仅为过程动画近似：
 * 闭合(Z)子路径作闭合笔（描周界 + 行扫填色），开放子路径作变宽墨带（嘴/胡须）。
 * 应用 (x,y) 平移与 rotation（绕 d 包围盒中心，与 drawVPath 对齐），编辑后的 vpath 轨迹也对位。
 */
export function vpathToStrokes(o: SceneObject): Stroke[] {
  if (!o.d) return []
  const subs = flattenPathD(o.d)
  if (subs.length === 0) return []
  const deg = o.rotation || 0
  let cx = 0
  let cy = 0
  if (deg) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const s of subs)
      for (const [px, py] of s.pts) {
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py
      }
    cx = (minX + maxX) / 2
    cy = (minY + maxY) / 2
  }
  const tx = o.x || 0
  const ty = o.y || 0
  const xform = ([px, py]: Pt): Pt => {
    let qx = px
    let qy = py
    if (deg) {
      const r = (deg * Math.PI) / 180
      const co = Math.cos(r)
      const si = Math.sin(r)
      const dx = px - cx
      const dy = py - cy
      qx = cx + dx * co - dy * si
      qy = cy + dx * si + dy * co
    }
    return [qx + tx, qy + ty]
  }
  const fillColor = o.gradient?.from ?? (o.fill && o.fill !== 'none' ? o.fill : undefined)
  const color = o.stroke ?? fillColor ?? INK
  const width = o.strokeWidth ?? (o.stroke ? 3 : 6)
  return subs.map(({ pts, closed }) => {
    const fillable = closed && pts.length >= 3 && fillColor !== undefined
    return {
      pts: pts.map(xform),
      closed,
      smooth: false, // d 已是采样曲线，勿再 CR 平滑
      color,
      width,
      taper: !closed,
      ...(fillable ? { fill: fillColor } : {}),
    }
  })
}

/** 整个场景 → 笔触序列（按 z 升序：背景先画、前景后画，符合人作画顺序） */
export function sceneToStrokes(scene: SceneState): Stroke[] {
  return [...scene.objects]
    .sort((a, b) => a.z - b.z)
    .flatMap(objectToStrokes)
    .filter((s) => s.pts.length >= 2)
}

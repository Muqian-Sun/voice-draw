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
  }
}

/** 整个场景 → 笔触序列（按 z 升序：背景先画、前景后画，符合人作画顺序） */
export function sceneToStrokes(scene: SceneState): Stroke[] {
  return [...scene.objects]
    .sort((a, b) => a.z - b.z)
    .flatMap(objectToStrokes)
    .filter((s) => s.pts.length >= 2)
}

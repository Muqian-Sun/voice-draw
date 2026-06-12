/**
 * 场景图（协议 §1.6 的内部状态形态）
 *
 * 坐标约定：所有图形统一以 (x, y) 为**中心点**定位（统一相对定位/居中对齐的数学），
 * 例外是 points 类图形（line/polyline/path）：points 为相对 (x, y) 的偏移，
 * 其"中心"由 getBBox 计算得出。bbox 不考虑 rotation（规格 §5.5 的简化约定）。
 */
import type { ShapeKind } from '../dsl'

export interface SceneObject {
  id: string // "circle#1"，按形状独立递增
  name?: string
  shape: ShapeKind
  x: number
  y: number
  radius?: number // circle / triangle(外接圆半径) / star(外半径)
  innerRadius?: number // star
  radiusX?: number // ellipse
  radiusY?: number
  width?: number // rect
  height?: number
  points?: number[] // line/polyline/path：相对 (x,y) 的扁平数组 [x1,y1,x2,y2,...]
  text?: string
  fontSize?: number
  fill?: string
  stroke?: string
  strokeWidth?: number
  opacity?: number
  rotation: number
  z: number
  groupId?: string
  createdSeq: number // 全局创建序号，byQuery 的 ordinal 依据
}

export interface SceneState {
  objects: SceneObject[]
  focusId?: string
  /**
   * 焦点粒度（§5.1 v1.1）：决定 byFocus（"它"）作用范围。
   * 'group'=最近动作针对整组（刚画完组合图/整组操作）→ "它"指整组；
   * 'object'=最近动作针对单个对象（画了/编辑了某部件）→ "它"指该对象。
   * 缺省按 object 处理。
   */
  focusScope?: 'group' | 'object'
  /** 全局创建计数（createdSeq 来源） */
  seq: number
  /** 按形状的 id 计数（id 命名来源，删除不回收） */
  seqByShape: Partial<Record<ShapeKind, number>>
}

export function createEmptyScene(): SceneState {
  return { objects: [], seq: 0, seqByShape: {} }
}

/** 包围盒 [x, y, w, h]（左上角 + 宽高），不考虑 rotation */
export function getBBox(o: SceneObject): [number, number, number, number] {
  switch (o.shape) {
    case 'circle': {
      const r = o.radius ?? 0
      return [o.x - r, o.y - r, 2 * r, 2 * r]
    }
    case 'star': {
      const r = o.radius ?? 0
      return [o.x - r, o.y - r, 2 * r, 2 * r]
    }
    case 'ellipse': {
      const rx = o.radiusX ?? 0
      const ry = o.radiusY ?? 0
      return [o.x - rx, o.y - ry, 2 * rx, 2 * ry]
    }
    case 'rect': {
      const w = o.width ?? 0
      const h = o.height ?? 0
      return [o.x - w / 2, o.y - h / 2, w, h]
    }
    case 'triangle': {
      // Konva RegularPolygon(3)：顶点朝上，外接圆半径 R → 宽 √3R、上沿 y-R、高 1.5R
      const r = o.radius ?? 0
      const w = Math.sqrt(3) * r
      return [o.x - w / 2, o.y - r, w, 1.5 * r]
    }
    case 'text': {
      // 估算：CJK 每字符约 1em；够 bbox/相对定位用，不追求像素级精确
      const fs = o.fontSize ?? 16
      const w = (o.text?.length ?? 0) * fs
      return [o.x - w / 2, o.y - fs / 2, w, fs * 1.2]
    }
    case 'line':
    case 'polyline':
    case 'path': {
      const pts = o.points ?? []
      if (pts.length < 2) return [o.x, o.y, 0, 0]
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let i = 0; i < pts.length; i += 2) {
        minX = Math.min(minX, pts[i])
        maxX = Math.max(maxX, pts[i])
        minY = Math.min(minY, pts[i + 1])
        maxY = Math.max(maxY, pts[i + 1])
      }
      return [o.x + minX, o.y + minY, maxX - minX, maxY - minY]
    }
  }
}

/** 包围盒中心（对中心定位图形即 (x,y) 本身） */
export function getCenter(o: SceneObject): { x: number; y: number } {
  const [bx, by, bw, bh] = getBBox(o)
  return { x: bx + bw / 2, y: by + bh / 2 }
}

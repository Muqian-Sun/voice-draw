import { useMemo, type RefObject } from 'react'
import { Arc, Circle, Ellipse, Group, Layer, Line, Rect, RegularPolygon, Stage, Star, Text } from 'react-konva'
import Konva from 'konva'

// v1.7 渲染清晰度：固定 ≥2× 背板分辨率（超采样），低 DPI 屏上曲线/描边也锐利不发虚。
// 导出/自检的 toDataURL 各自显式传 pixelRatio，覆盖此全局值，互不影响。
if (typeof window !== 'undefined') {
  Konva.pixelRatio = Math.max(2, window.devicePixelRatio || 1)
}
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../dsl'
import { getBBox } from '../engine/scene'
import type { SceneObject, SceneState } from '../engine/scene'

/** v1.6 线性渐变 → Konva fillLinearGradient*（坐标为图形局部系，以中心为原点）。angle 度 0=左→右 90=上→下 */
function gradientProps(o: SceneObject): Record<string, unknown> {
  if (!o.gradient) return {}
  const [, , w, h] = getBBox(o)
  const r = Math.max(w, h) / 2 || 1
  const rad = ((o.gradient.angle ?? 90) * Math.PI) / 180
  const dx = Math.cos(rad) * r
  const dy = Math.sin(rad) * r
  return {
    fillLinearGradientStartPoint: { x: -dx, y: -dy },
    fillLinearGradientEndPoint: { x: dx, y: dy },
    fillLinearGradientColorStops: [0, o.gradient.from, 1, o.gradient.to],
  }
}

/** v1.7 投影 → Konva shadow* 属性 */
function shadowProps(o: SceneObject): Record<string, unknown> {
  if (!o.shadow) return {}
  return {
    shadowColor: o.shadow.color,
    shadowBlur: o.shadow.blur,
    shadowOffsetX: o.shadow.offsetX,
    shadowOffsetY: o.shadow.offsetY,
    shadowOpacity: o.shadow.opacity,
  }
}

/** v1.7 纹理 tile：fill 底色 + 暗纹（衣纹/砖墙/鳞片/毛感）。按 (类型|底色) 缓存 */
const patternCache = new Map<string, HTMLImageElement>()
function patternTile(type: NonNullable<SceneObject['pattern']>, baseFill: string): HTMLImageElement | undefined {
  if (typeof document === 'undefined') return undefined
  const key = `${type}|${baseFill}`
  const cached = patternCache.get(key)
  if (cached) return cached
  const S = 16
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const ctx = c.getContext('2d')
  if (ctx === null) return undefined
  ctx.fillStyle = baseFill
  ctx.fillRect(0, 0, S, S)
  const mark = 'rgba(0,0,0,0.2)'
  ctx.fillStyle = mark
  ctx.strokeStyle = mark
  ctx.lineWidth = 2
  switch (type) {
    case 'stripes':
      ctx.fillRect(0, 0, 5, S) // 竖条
      break
    case 'dots':
      ctx.beginPath()
      ctx.arc(S / 2, S / 2, 2.4, 0, Math.PI * 2)
      ctx.fill()
      break
    case 'grid':
      ctx.fillRect(S - 1.5, 0, 1.5, S)
      ctx.fillRect(0, S - 1.5, S, 1.5)
      break
    case 'hatch':
      ctx.beginPath()
      ctx.moveTo(-4, S + 4)
      ctx.lineTo(S + 4, -4) // 单向斜纹（平铺连续）
      ctx.stroke()
      break
    case 'cross':
      ctx.beginPath()
      ctx.moveTo(-4, S + 4)
      ctx.lineTo(S + 4, -4)
      ctx.moveTo(-4, -4)
      ctx.lineTo(S + 4, S + 4) // 交叉斜纹
      ctx.stroke()
      break
  }
  patternCache.set(key, c as unknown as HTMLImageElement)
  return c as unknown as HTMLImageElement
}

/** v1.7 纹理 → Konva fillPattern*（优先于纯色/渐变） */
function patternProps(o: SceneObject): Record<string, unknown> {
  if (!o.pattern) return {}
  const tile = patternTile(o.pattern, o.fill ?? '#cccccc')
  if (tile === undefined) return {}
  return { fillPriority: 'pattern', fillPatternImage: tile, fillPatternRepeat: 'repeat' }
}

/** SceneObject → Konva 节点。坐标约定见 engine/scene.ts：(x,y) 为中心点 */
function ShapeNode({ o }: { o: SceneObject }) {
  const common = {
    x: o.x,
    y: o.y,
    fill: o.fill,
    stroke: o.stroke,
    strokeWidth: o.strokeWidth,
    opacity: o.opacity,
    rotation: o.rotation,
    ...gradientProps(o),
    ...shadowProps(o),
    ...patternProps(o),
  }
  switch (o.shape) {
    case 'circle':
      return <Circle {...common} radius={o.radius ?? 0} />
    case 'ellipse':
      return <Ellipse {...common} radiusX={o.radiusX ?? 0} radiusY={o.radiusY ?? 0} />
    case 'rect':
      return (
        <Rect
          {...common}
          width={o.width ?? 0}
          height={o.height ?? 0}
          offsetX={(o.width ?? 0) / 2}
          offsetY={(o.height ?? 0) / 2}
          cornerRadius={o.cornerRadius ?? 0}
        />
      )
    case 'triangle':
      return <RegularPolygon {...common} sides={3} radius={o.radius ?? 0} />
    case 'star':
      return <Star {...common} numPoints={5} outerRadius={o.radius ?? 0} innerRadius={o.innerRadius ?? 0} />
    case 'arc':
      // Konva Arc：从 rotation 角顺时针扫 angle 度；innerRadius>0 为圆环弧，=0 为扇形
      return (
        <Arc
          {...common}
          innerRadius={o.innerRadius ?? 0}
          outerRadius={o.radius ?? 0}
          angle={o.angle ?? 270}
        />
      )
    case 'line':
    case 'polyline':
      return <Line {...common} points={o.points ?? []} tension={o.tension ?? 0} lineCap="round" lineJoin="round" />
    case 'path':
      return <Line {...common} points={o.points ?? []} tension={o.tension ?? 0} closed lineJoin="round" />
    case 'text': {
      const fs = o.fontSize ?? 16
      const estWidth = (o.text?.length ?? 0) * fs
      return <Text {...common} text={o.text ?? ''} fontSize={fs} offsetX={estWidth / 2} offsetY={fs / 2} />
    }
  }
}

/** 制图网格 tile：在 tile 右/下边各描一条线，平铺即成坐标网格。导出时由 App 隐藏 .paper-grid */
function makeGridTile(size: number, color: string): HTMLImageElement | undefined {
  if (typeof document === 'undefined') return undefined
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')
  if (ctx === null) return undefined
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(size - 0.5, 0)
  ctx.lineTo(size - 0.5, size)
  ctx.moveTo(0, size - 0.5)
  ctx.lineTo(size, size - 0.5)
  ctx.stroke()
  return c as unknown as HTMLImageElement
}

/** 暖象牙画纸 + 双层制图网格（细格 40px / 主线 160px） */
function useGridTiles() {
  return useMemo(
    () => ({
      minor: makeGridTile(40, 'rgba(46, 40, 32, 0.05)'),
      major: makeGridTile(160, 'rgba(46, 40, 32, 0.1)'),
    }),
    [],
  )
}

export function CanvasStage({ scene, stageRef }: { scene: SceneState; stageRef?: RefObject<Konva.Stage | null> }) {
  const sorted = [...scene.objects].sort((a, b) => a.z - b.z)
  const grid = useGridTiles()
  return (
    <Stage ref={stageRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT}>
      <Layer listening={false}>
        <Rect x={0} y={0} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="#f6f0e4" />
        {grid.minor !== undefined && (
          <Group name="paper-grid">
            <Rect
              x={0}
              y={0}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              fillPatternImage={grid.minor}
              fillPatternRepeat="repeat"
            />
            {grid.major !== undefined && (
              <Rect
                x={0}
                y={0}
                width={CANVAS_WIDTH}
                height={CANVAS_HEIGHT}
                fillPatternImage={grid.major}
                fillPatternRepeat="repeat"
              />
            )}
          </Group>
        )}
        {scene.objects.length === 0 && (
          <Text
            text="开口即画 · 随时说话"
            x={0}
            y={CANVAS_HEIGHT / 2 - 14}
            width={CANVAS_WIDTH}
            align="center"
            fontSize={22}
            fill="#c4bcab"
          />
        )}
      </Layer>
      <Layer listening={false}>
        {sorted.map((o) => (
          <ShapeNode key={o.id} o={o} />
        ))}
      </Layer>
      {/* 焦点高亮（指代"它"的可视反馈，§5.1）。焦点在组内时覆盖整组（§5.6 几何类组提升）。
          独立 overlay 层，PNG 导出时临时隐藏 */}
      <Layer name="overlay" listening={false}>
        {(() => {
          const focus = scene.objects.find((o) => o.id === scene.focusId)
          if (!focus) return null
          const targets =
            focus.groupId !== undefined ? scene.objects.filter((o) => o.groupId === focus.groupId) : [focus]
          let minX = Infinity
          let minY = Infinity
          let maxX = -Infinity
          let maxY = -Infinity
          for (const o of targets) {
            const [bx, by, bw, bh] = getBBox(o)
            minX = Math.min(minX, bx)
            minY = Math.min(minY, by)
            maxX = Math.max(maxX, bx + bw)
            maxY = Math.max(maxY, by + bh)
          }
          const pad = 6
          return (
            <Rect
              x={minX - pad}
              y={minY - pad}
              width={maxX - minX + pad * 2}
              height={maxY - minY + pad * 2}
              stroke="#2563EB"
              strokeWidth={1.5}
              dash={[6, 4]}
              cornerRadius={4}
            />
          )
        })()}
      </Layer>
    </Stage>
  )
}

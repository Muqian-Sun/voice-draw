import type { RefObject } from 'react'
import { Arc, Circle, Ellipse, Layer, Line, Rect, RegularPolygon, Stage, Star, Text } from 'react-konva'
import type Konva from 'konva'
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
      return <Line {...common} points={o.points ?? []} lineCap="round" lineJoin="round" />
    case 'path':
      return <Line {...common} points={o.points ?? []} closed lineJoin="round" />
    case 'text': {
      const fs = o.fontSize ?? 16
      const estWidth = (o.text?.length ?? 0) * fs
      return <Text {...common} text={o.text ?? ''} fontSize={fs} offsetX={estWidth / 2} offsetY={fs / 2} />
    }
  }
}

export function CanvasStage({ scene, stageRef }: { scene: SceneState; stageRef?: RefObject<Konva.Stage | null> }) {
  const sorted = [...scene.objects].sort((a, b) => a.z - b.z)
  return (
    <Stage ref={stageRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT}>
      <Layer listening={false}>
        <Rect x={0} y={0} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="#ffffff" />
        {scene.objects.length === 0 && (
          <Text
            text="空画布 1024 × 768 — 用右侧调试面板或控制台 voiceDraw.exec(...) 灌入 DSL"
            x={0}
            y={CANVAS_HEIGHT / 2 - 10}
            width={CANVAS_WIDTH}
            align="center"
            fontSize={16}
            fill="#9ca3af"
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

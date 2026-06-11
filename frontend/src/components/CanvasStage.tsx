import { Circle, Ellipse, Layer, Line, Rect, RegularPolygon, Stage, Star, Text } from 'react-konva'
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../dsl'
import type { SceneObject, SceneState } from '../engine/scene'

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
        />
      )
    case 'triangle':
      return <RegularPolygon {...common} sides={3} radius={o.radius ?? 0} />
    case 'star':
      return <Star {...common} numPoints={5} outerRadius={o.radius ?? 0} innerRadius={o.innerRadius ?? 0} />
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

export function CanvasStage({ scene }: { scene: SceneState }) {
  const sorted = [...scene.objects].sort((a, b) => a.z - b.z)
  return (
    <Stage width={CANVAS_WIDTH} height={CANVAS_HEIGHT}>
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
    </Stage>
  )
}

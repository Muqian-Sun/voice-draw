import { Stage, Layer, Rect, Text } from 'react-konva'
import { CANVAS_WIDTH, CANVAS_HEIGHT } from './dsl'

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <h1>VoiceDraw 语音绘图</h1>
        <span className="status-pill">🎤 语音链路待接入</span>
      </header>
      <main className="canvas-wrap">
        <div className="stage-frame">
          <Stage width={CANVAS_WIDTH} height={CANVAS_HEIGHT}>
            <Layer>
              <Rect x={0} y={0} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="#ffffff" />
              <Text
                text="空画布 1024 × 768 — 绘图引擎将在后续 PR 接入"
                x={0}
                y={CANVAS_HEIGHT / 2 - 10}
                width={CANVAS_WIDTH}
                align="center"
                fontSize={16}
                fill="#9ca3af"
              />
            </Layer>
          </Stage>
        </div>
      </main>
    </div>
  )
}

import { Stage, Layer, Rect, Text } from 'react-konva'

/** 逻辑画布尺寸，见 docs/题目二-交互协议规范.md §1.2 */
export const CANVAS_WIDTH = 1024
export const CANVAS_HEIGHT = 768

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

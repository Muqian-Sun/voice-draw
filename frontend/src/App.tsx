import { useEffect, useRef, useState } from 'react'
import { parseOps } from './dsl'
import { createHistory, executeWithHistory, type HistoryOutcome, type HistoryState } from './engine/history'
import { CanvasStage } from './components/CanvasStage'

export default function App() {
  const [history, setHistory] = useState<HistoryState>(createHistory)
  const historyRef = useRef(history)
  historyRef.current = history

  // 控制台验收入口（调试面板在后续 PR 提供 UI）：
  //   voiceDraw.exec({op:'create',shape:'circle',fill:'#FF4136'})
  //   voiceDraw.exec({op:'undo'})  /  voiceDraw.exec({op:'redo'})
  useEffect(() => {
    const exec = (input: unknown): HistoryOutcome | { error: string } => {
      let data = input
      if (typeof input === 'string') {
        try {
          data = JSON.parse(input)
        } catch (e) {
          const error = `JSON 解析失败：${(e as Error).message}`
          console.warn('[voiceDraw]', error)
          return { error }
        }
      }
      const parsed = parseOps(Array.isArray(data) ? data : [data])
      if (!parsed.ok) {
        console.warn('[voiceDraw] DSL 校验失败：', parsed.error)
        return { error: parsed.error }
      }
      const outcome = executeWithHistory(historyRef.current, parsed.ops)
      historyRef.current = outcome.history
      setHistory(outcome.history)
      if (outcome.error) {
        console.warn(
          `[voiceDraw] 执行 ${outcome.executed}/${parsed.ops.length}，错误 ${outcome.error.code}：${outcome.error.message}`,
        )
      } else {
        console.info(`[voiceDraw] 执行成功，焦点=${outcome.history.scene.focusId ?? '无'}`)
      }
      return outcome
    }
    ;(window as unknown as Record<string, unknown>).voiceDraw = {
      exec,
      scene: () => historyRef.current.scene,
      history: () => ({
        undoDepth: historyRef.current.undoStack.length,
        redoDepth: historyRef.current.redoStack.length,
      }),
    }
  }, [])

  const scene = history.scene
  return (
    <div className="app">
      <header className="topbar">
        <h1>VoiceDraw 语音绘图</h1>
        <span className="status-pill">🎤 语音链路待接入</span>
        <span className="status-pill">
          对象 {scene.objects.length} ｜ 焦点 {scene.focusId ?? '无'} ｜ 撤销 {history.undoStack.length} / 重做{' '}
          {history.redoStack.length}
        </span>
      </header>
      <main className="canvas-wrap">
        <div className="stage-frame">
          <CanvasStage scene={scene} />
        </div>
      </main>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { parseOps } from './dsl'
import { executeTransaction, type ExecOutcome } from './engine/interpreter'
import { createEmptyScene, type SceneState } from './engine/scene'
import { CanvasStage } from './components/CanvasStage'

export default function App() {
  const [scene, setScene] = useState<SceneState>(createEmptyScene)
  const sceneRef = useRef(scene)
  sceneRef.current = scene

  // 控制台验收入口（调试面板在后续 PR 提供 UI）：
  //   voiceDraw.exec({op:'create',shape:'circle',fill:'#FF4136'})
  //   voiceDraw.exec('[{"op":"move","target":{"byFocus":true},"delta":[60,0]}]')
  useEffect(() => {
    const exec = (input: unknown): ExecOutcome | { error: string } => {
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
      const outcome = executeTransaction(sceneRef.current, parsed.ops)
      sceneRef.current = outcome.state
      setScene(outcome.state)
      if (outcome.error) {
        console.warn(`[voiceDraw] 执行 ${outcome.executed}/${parsed.ops.length}，错误 ${outcome.error.code}：${outcome.error.message}`)
      } else {
        console.info(`[voiceDraw] 执行成功 ${outcome.executed} 个 Op，焦点=${outcome.state.focusId ?? '无'}`)
      }
      return outcome
    }
    ;(window as unknown as Record<string, unknown>).voiceDraw = {
      exec,
      scene: () => sceneRef.current,
    }
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <h1>VoiceDraw 语音绘图</h1>
        <span className="status-pill">🎤 语音链路待接入</span>
        <span className="status-pill">
          对象 {scene.objects.length} ｜ 焦点 {scene.focusId ?? '无'}
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { parseOps, type Op } from './dsl'
import { createHistory, executeWithHistory, type HistoryOutcome, type HistoryState } from './engine/history'
import { CanvasStage } from './components/CanvasStage'
import { DebugPanel, type LogEntry } from './components/DebugPanel'

let logSeq = 0

export default function App() {
  const [history, setHistory] = useState<HistoryState>(createHistory)
  const historyRef = useRef(history)
  historyRef.current = history

  const [log, setLog] = useState<LogEntry[]>([])
  const pushLog = useCallback((level: LogEntry['level'], text: string) => {
    const entry: LogEntry = { id: ++logSeq, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, text }
    setLog((prev) => [...prev.slice(-199), entry]) // 最多保留 200 条
    const fn = level === 'info' ? console.info : console.warn
    fn(`[voiceDraw] ${text}`)
  }, [])

  /** 执行一个已校验前的 Op 数组（面板按钮 / 控制台 / 后续理解层共用入口） */
  const execOps = useCallback(
    (ops: unknown): HistoryOutcome | { error: string } => {
      const parsed = parseOps(Array.isArray(ops) ? ops : [ops])
      if (!parsed.ok) {
        pushLog('error', `DSL 校验失败：${parsed.error}`)
        return { error: parsed.error }
      }
      const outcome = executeWithHistory(historyRef.current, parsed.ops)
      historyRef.current = outcome.history
      setHistory(outcome.history)
      if (outcome.error) {
        pushLog(
          outcome.executed > 0 ? 'warn' : 'error',
          `执行 ${outcome.executed}/${parsed.ops.length}，${outcome.error.code}：${outcome.error.message}`,
        )
      } else {
        const s = outcome.history.scene
        const stepInfo = outcome.steps !== undefined ? `（${outcome.steps} 步）` : ''
        pushLog('info', `执行成功${stepInfo}：${parsed.ops.map((o) => o.op).join(', ')} ｜ 对象 ${s.objects.length}，焦点 ${s.focusId ?? '无'}`)
      }
      return outcome
    },
    [pushLog],
  )

  /** 文本入口：DSL JSON 直接执行；自然语言待理解层接入（计划 PR #10~#13） */
  const execText = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          execOps(JSON.parse(trimmed))
        } catch (e) {
          pushLog('error', `JSON 解析失败：${(e as Error).message}`)
        }
        return
      }
      pushLog('warn', `「${trimmed}」：自然语言理解将在规则层/LLM PR 接入（计划 #10~#13），当前请输入 DSL JSON（点「示例」查看格式）`)
    },
    [execOps, pushLog],
  )

  // 控制台入口与面板共用同一执行通道
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).voiceDraw = {
      exec: (input: unknown) => (typeof input === 'string' ? execText(input) : execOps(input)),
      scene: () => historyRef.current.scene,
      history: () => ({
        undoDepth: historyRef.current.undoStack.length,
        redoDepth: historyRef.current.redoStack.length,
      }),
    }
  }, [execOps, execText])

  const scene = history.scene
  const op = (o: Op) => () => execOps(o)
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
      <main className="workspace">
        <div className="canvas-wrap">
          <div className="stage-frame">
            <CanvasStage scene={scene} />
          </div>
        </div>
        <DebugPanel
          entries={log}
          onSubmit={execText}
          onUndo={op({ op: 'undo' })}
          onRedo={op({ op: 'redo' })}
          onClear={op({ op: 'clear' })}
        />
      </main>
    </div>
  )
}

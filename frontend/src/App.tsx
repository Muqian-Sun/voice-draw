import { useCallback, useEffect, useRef, useState } from 'react'
import { parseOps, type Op } from './dsl'
import { createHistory, executeWithHistory, type HistoryOutcome, type HistoryState } from './engine/history'
import { CanvasStage } from './components/CanvasStage'
import { DebugPanel, type LogEntry } from './components/DebugPanel'
import { correctTranscript } from './nlu/correction'
import { decideMode, parseRule } from './nlu/rules'
import { CONFIRM_YES_WORDS } from './shared/lexicon'
import { STATE_LABELS } from './voice/fsm'
import { useVoice } from './voice/useVoice'

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
      outcome.notices?.forEach((n) => pushLog('warn', `⚙ ${n}`))
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

  // 破坏性操作确认窗口（协议 §4.3）：语音 FSM 子态接入前由文本入口承担同语义
  const pendingConfirmRef = useRef<Op[] | null>(null)

  /** 文本入口：DSL JSON 直接执行；自然语言走 纠错 → 规则快路径（升级 LLM 计划 PR#13） */
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

      // 确认窗口期：命中肯定词执行，其余任何输入视为否定（规格 §2.6 保守策略）
      if (pendingConfirmRef.current !== null) {
        const pending = pendingConfirmRef.current
        pendingConfirmRef.current = null
        if (CONFIRM_YES_WORDS.includes(trimmed)) {
          pushLog('info', '🔊 已确认')
          execOps(pending)
        } else {
          pushLog('info', '🔊 已取消')
        }
        return
      }

      const corr = correctTranscript(trimmed)
      if (corr.applied.length > 0) {
        pushLog('info', `纠错：「${corr.original}」→「${corr.corrected}」`)
      }
      const scene = historyRef.current.scene
      const r = parseRule(corr.corrected, {
        names: scene.objects.map((o) => o.name).filter((n): n is string => n !== undefined && n.length > 0),
        hasFocus: scene.focusId !== undefined,
      })
      if (r === null) {
        pushLog('warn', `规则未命中 → 升级 LLM（mode=${decideMode(corr.corrected)}，计划 PR#13 接入）`)
        return
      }
      pushLog('info', `规则命中 ${r.template}（${r.latencyMs.toFixed(1)}ms）`)
      if (r.intent === 'confirm-pending') {
        pendingConfirmRef.current = r.ops
        pushLog('warn', `🔊 ${r.say}（输入「确认」执行，其他任意输入取消）`)
        return
      }
      if (r.intent === 'clarify') {
        pushLog('warn', `🔊 ${r.say}`)
        return
      }
      if (r.say !== undefined) pushLog('info', `🔊 ${r.say}`)
      execOps(r.ops)
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

  const voice = useVoice({ onLog: pushLog })

  const scene = history.scene
  const op = (o: Op) => () => execOps(o)
  const listening = voice.state !== 'idle'
  return (
    <div className="app">
      <header className="topbar">
        <h1>VoiceDraw 语音绘图</h1>
        <button
          className={`voice-btn ${listening ? 'voice-on' : ''}`}
          onClick={listening ? voice.stop : voice.start}
          disabled={voice.vadStatus === 'loading'}
        >
          {voice.vadStatus === 'loading' ? '⏳ 加载 VAD…' : listening ? '🔴 停止聆听' : '🎤 开始聆听'}
        </button>
        <span className="status-pill">状态 {STATE_LABELS[voice.state]}</span>
        <span className="status-pill">ASR {voice.providerName}</span>
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
          {voice.subtitle && (
            <div className={`subtitle subtitle-${voice.subtitle.kind}`}>{voice.subtitle.text}</div>
          )}
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

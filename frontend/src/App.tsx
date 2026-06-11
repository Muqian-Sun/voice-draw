import { useCallback, useEffect, useRef, useState } from 'react'
import type Konva from 'konva'
import { parseOps, type Op } from './dsl'
import { createHistory, executeWithHistory, type HistoryOutcome, type HistoryState } from './engine/history'
import { CanvasStage } from './components/CanvasStage'
import { DebugPanel, type LogEntry } from './components/DebugPanel'
import { correctTranscript } from './nlu/correction'
import { parseWithLlm } from './nlu/llm'
import { decideMode, parseRule } from './nlu/rules'
import { CONFIRM_YES_WORDS } from './shared/lexicon'
import { STATE_LABELS } from './voice/fsm'
import { useVoice } from './voice/useVoice'

let logSeq = 0

export default function App() {
  const [history, setHistory] = useState<HistoryState>(createHistory)
  const historyRef = useRef(history)
  historyRef.current = history
  const stageRef = useRef<Konva.Stage | null>(null)

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
      // export 在引擎侧是无状态变更 Op，事务成功后由这里触发 PNG 下载
      if (!outcome.error && parsed.ops.some((o) => o.op === 'export')) {
        const stage = stageRef.current
        if (stage) {
          const a = document.createElement('a')
          a.href = stage.toDataURL({ pixelRatio: 2 })
          a.download = `voicedraw-${Date.now()}.png`
          a.click()
        }
      }
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
  // 最近 3 轮成功指令（协议 §2.2 recent，供 LLM 多轮指代）
  const recentRef = useRef<Array<{ utterance: string; summary: string }>>([])
  const lastTxRef = useRef<{ utterance: string; opCount: number } | undefined>(undefined)

  const recordSuccess = useCallback((utterance: string, ops: Op[]) => {
    const summary = ops.map((o) => (o.op === 'create' ? `create ${o.shape}${o.name ? ` ${o.name}` : ''}` : o.op)).join('; ')
    recentRef.current = [...recentRef.current.slice(-2), { utterance, summary }]
    lastTxRef.current = { utterance, opCount: ops.length }
  }, [])

  /** 文本入口：DSL JSON 直接执行；自然语言走 纠错 → 规则快路径 → 升级 LLM */
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
        const mode = decideMode(corr.corrected)
        pushLog('info', `规则未命中 → 升级 LLM（mode=${mode}）…`)
        void (async () => {
          const llm = await parseWithLlm(corr.corrected, mode, {
            scene: historyRef.current.scene,
            asrAlternatives: corr.applied.length > 0 ? [corr.original] : [],
            recent: recentRef.current,
            lastTransaction: lastTxRef.current,
          })
          if (!llm.ok) {
            pushLog('error', `LLM 解析失败：${llm.error}`)
            pushLog('warn', '🔊 没听懂，请换个说法')
            return
          }
          const res = llm.result
          pushLog('info', `LLM 命中 ${res.source}（${res.latencyMs.toFixed(0)}ms，confidence ${res.confidence.toFixed(2)}）`)
          if (res.intent === 'clarify') {
            pushLog('warn', `🔊 ${res.clarify?.question ?? res.say ?? '能再说明确一点吗？'}`)
            return
          }
          if (res.intent === 'reject') {
            pushLog('warn', `🔊 ${res.say ?? '这个我帮不了，试试绘图指令'}`)
            return
          }
          if (res.say !== undefined) pushLog('info', `🔊 ${res.say}`)
          const outcome = execOps(res.ops)
          if (!('error' in outcome && outcome.error)) recordSuccess(corr.corrected, res.ops)
        })()
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
      const outcome = execOps(r.ops)
      if (!('error' in outcome && outcome.error)) recordSuccess(corr.corrected, r.ops)
    },
    [execOps, pushLog, recordSuccess],
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

  // 语音 final → 同一理解通道（纠错 → 规则 → LLM），与调试面板共用
  const voice = useVoice({ onLog: pushLog, onUtterance: (text) => execText(text) })

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
            <CanvasStage scene={scene} stageRef={stageRef} />
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

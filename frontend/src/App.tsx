import { useCallback, useEffect, useRef, useState } from 'react'
import type Konva from 'konva'
import { parseOps, type Op } from './dsl'
import { createHistory, executeWithHistory, type HistoryOutcome, type HistoryState } from './engine/history'
import { CanvasStage } from './components/CanvasStage'
import { DebugPanel, type LogEntry } from './components/DebugPanel'
import { buildAmbiguityClarify, matchExpecting, type ExpectingItem } from './nlu/clarify'
import { correctTranscript } from './nlu/correction'
import { parseWithLlm } from './nlu/llm'
import { decideMode, parseRule } from './nlu/rules'
import { CONFIRM_YES_WORDS } from './shared/lexicon'
import { CONFIRM_WINDOW_MS, STATE_LABELS, type VoiceEvent, type VoiceState } from './voice/fsm'
import { GatewayTts, TtsOrchestrator, WebSpeechTts } from './voice/tts'
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
          // 焦点高亮属交互反馈，不进导出图
          const overlay = stage.findOne<Konva.Layer>('.overlay')
          overlay?.visible(false)
          const url = stage.toDataURL({ pixelRatio: 2 })
          overlay?.visible(true)
          const a = document.createElement('a')
          a.href = url
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

  // 语音 FSM 接口（useVoice 在下方创建，经 ref 解循环依赖；面板输入时 state=idle，dispatch 自然空转）
  const voiceApiRef = useRef<{
    dispatch: (e: VoiceEvent) => void
    setTtsActive: (a: boolean) => void
    getState: () => VoiceState
  } | null>(null)

  // 破坏性操作确认窗口（协议 §4.3）：语音走 awaitConfirm 子态 + 5s 超时；面板文本同语义（无超时）
  const pendingConfirmRef = useRef<Op[] | null>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearConfirmTimer = useCallback(() => {
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
  }, [])

  // TTS 编排：网关（豆包语音合成 1.0）→ speechSynthesis 兜底；播报期间半双工互斥
  const ttsRef = useRef<TtsOrchestrator | null>(null)
  const getTts = useCallback(() => {
    if (ttsRef.current === null) {
      ttsRef.current = new TtsOrchestrator(new GatewayTts(`http://${location.hostname}:8787`), new WebSpeechTts(), {
        onLog: pushLog,
        onSpeakingChange: (speaking) => {
          const api = voiceApiRef.current
          api?.setTtsActive(speaking)
          if (speaking || !api) return
          // 播报结束：有待确认操作 → 进入确认窗口（协议 §4.3），否则回聆听
          if (pendingConfirmRef.current !== null) {
            api.dispatch('AWAIT_CONFIRM')
            if (api.getState() === 'awaitConfirm') {
              clearConfirmTimer()
              confirmTimerRef.current = setTimeout(() => {
                confirmTimerRef.current = null
                if (pendingConfirmRef.current === null) return
                pendingConfirmRef.current = null
                pushLog('info', '确认窗口超时（5s），视为取消')
                api.dispatch('CONFIRM_TIMEOUT')
                pushLog('info', '🔊 已取消')
                void ttsRef.current?.speak('已取消')
              }, CONFIRM_WINDOW_MS)
            }
            return
          }
          api.dispatch('TTS_END')
        },
      })
    }
    return ttsRef.current
  }, [clearConfirmTimer, pushLog])

  /** 播报 + 日志；text 为空时仅推进状态机（speaking → listening） */
  const say = useCallback(
    (text: string | undefined) => {
      if (text === undefined || text.length === 0) {
        voiceApiRef.current?.dispatch('TTS_END')
        return
      }
      pushLog('info', `🔊 ${text}`)
      void getTts().speak(text)
    },
    [getTts, pushLog],
  )

  // 最近 3 轮成功指令（协议 §2.2 recent，供 LLM 多轮指代）
  const recentRef = useRef<Array<{ utterance: string; summary: string }>>([])
  const lastTxRef = useRef<{ utterance: string; opCount: number } | undefined>(undefined)

  // 歧义澄清窗口（规格 §5.7）：engine=快匹配后 byId 补全原 Op；llm=联合原话重新解析
  type PendingClarify =
    | { kind: 'engine'; remainingOps: Op[]; expecting: ExpectingItem[]; sayText?: string }
    | { kind: 'llm'; original: string; expecting: ExpectingItem[] }
  const pendingClarifyRef = useRef<PendingClarify | null>(null)

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

      // FSM 推进（语音轮次有效；面板输入时 state=idle，transition 为 null 自然空转）
      const advance = (ok: boolean) => {
        const d = voiceApiRef.current?.dispatch
        if (!d) return
        if (ok) {
          d('PARSE_DONE')
          d('EXEC_DONE')
        } else {
          d('PARSE_FAIL')
        }
      }
      // 执行结果 → 播报文案：失败播错误码表文案（引擎 message 即口语化中文），成功播 sayText。
      // AMBIGUOUS_TARGET 拦截为澄清流程（§5.7）：列举候选特征 + 开 expecting 快匹配窗口
      const speakOutcome = (outcome: HistoryOutcome | { error: string }, sayText: string | undefined, ops?: Op[]): boolean => {
        const err = 'error' in outcome ? outcome.error : undefined
        if (err !== undefined) {
          if (typeof err !== 'string' && err.code === 'AMBIGUOUS_TARGET' && err.candidateIds !== undefined && ops !== undefined) {
            const objs = err.candidateIds
              .map((id) => historyRef.current.scene.objects.find((o) => o.id === id))
              .filter((o): o is NonNullable<typeof o> => o !== undefined)
            const plan = buildAmbiguityClarify(objs)
            if (plan.kind === 'choices') {
              const executed = 'executed' in outcome ? outcome.executed : 0
              pendingClarifyRef.current = { kind: 'engine', remainingOps: ops.slice(executed), expecting: plan.expecting, sayText }
              pushLog('warn', `歧义候选 ${err.candidateIds.join(' / ')} → 快匹配窗口：${plan.expecting.map((e) => e.label).join('｜')}`)
            }
            say(plan.question)
            return false
          }
          say(typeof err === 'string' ? '这个操作我没理解，请换个说法' : err.message)
          return false
        }
        say(sayText)
        return true
      }

      // 确认窗口期：命中肯定词执行，其余任何输入视为否定（规格 §2.6 保守策略）
      if (pendingConfirmRef.current !== null) {
        clearConfirmTimer()
        const pending = pendingConfirmRef.current
        pendingConfirmRef.current = null
        if (CONFIRM_YES_WORDS.includes(trimmed)) {
          advance(true)
          speakOutcome(execOps(pending), '已清空')
        } else {
          advance(false)
          say('已取消')
        }
        return
      }

      const corr = correctTranscript(trimmed)
      if (corr.applied.length > 0) {
        pushLog('info', `纠错：「${corr.original}」→「${corr.corrected}」`)
      }
      let utterance = corr.corrected

      // 澄清窗口期：先与 expecting 包含匹配（§5.7 快匹配）。
      // 仅短回答参与（≤8 字），防止新长指令里偶含候选词被误吞；未命中即关窗按新指令解析
      if (pendingClarifyRef.current !== null) {
        const pending = pendingClarifyRef.current
        const hit = utterance.length <= 8 ? matchExpecting(utterance, pending.expecting) : null
        pendingClarifyRef.current = null
        if (hit !== null && pending.kind === 'engine') {
          pushLog('info', `澄清命中「${hit.label}」→ ${hit.id}，补全原指令直接执行（不走完整解析）`)
          advance(true)
          const first = pending.remainingOps[0]
          const fixed = 'target' in first ? ({ ...first, target: { byId: hit.id } } as Op) : first
          const ops = [fixed, ...pending.remainingOps.slice(1)]
          if (speakOutcome(execOps(ops), pending.sayText ?? '好的', ops)) recordSuccess(utterance, ops)
          return
        }
        if (hit !== null && pending.kind === 'llm') {
          utterance = `${pending.original}，${hit.label}`
          pushLog('info', `澄清命中「${hit.label}」→ 联合原话重新解析：「${utterance}」`)
        }
      }

      const scene = historyRef.current.scene
      const r = parseRule(utterance, {
        names: scene.objects.map((o) => o.name).filter((n): n is string => n !== undefined && n.length > 0),
        hasFocus: scene.focusId !== undefined,
      })
      if (r === null) {
        const mode = decideMode(utterance)
        pushLog('info', `规则未命中 → 升级 LLM（mode=${mode}）…`)
        void (async () => {
          const llm = await parseWithLlm(utterance, mode, {
            scene: historyRef.current.scene,
            asrAlternatives: corr.applied.length > 0 ? [corr.original] : [],
            recent: recentRef.current,
            lastTransaction: lastTxRef.current,
          })
          if (!llm.ok) {
            pushLog('error', `LLM 解析失败：${llm.error}`)
            advance(false)
            say('没听懂，请换个说法')
            return
          }
          const res = llm.result
          pushLog('info', `LLM 命中 ${res.source}（${res.latencyMs.toFixed(0)}ms，confidence ${res.confidence.toFixed(2)}）`)
          if (res.intent === 'clarify') {
            advance(false)
            // LLM 给出 expecting → 开快匹配窗口，命中后联合原话重新解析（协议 §2.3）
            if (res.clarify !== undefined && res.clarify.expecting.length > 0) {
              pendingClarifyRef.current = {
                kind: 'llm',
                original: utterance,
                expecting: res.clarify.expecting.map((label) => ({ label, id: '' })),
              }
            }
            say(res.clarify?.question ?? res.say ?? '能再说明确一点吗？')
            return
          }
          if (res.intent === 'reject') {
            advance(false)
            say(res.say ?? '这个我帮不了，试试绘图指令')
            return
          }
          advance(true)
          if (speakOutcome(execOps(res.ops), res.say, res.ops)) recordSuccess(utterance, res.ops)
        })()
        return
      }
      pushLog('info', `规则命中 ${r.template}（${r.latencyMs.toFixed(1)}ms）`)
      if (r.intent === 'confirm-pending') {
        pendingConfirmRef.current = r.ops
        pushLog('warn', '确认窗口：输入/说「确认」执行，其他任意输入取消')
        advance(false)
        say(r.say)
        return
      }
      if (r.intent === 'clarify') {
        advance(false)
        say(r.say)
        return
      }
      advance(true)
      if (speakOutcome(execOps(r.ops), r.say, r.ops)) recordSuccess(utterance, r.ops)
    },
    [execOps, pushLog, recordSuccess, say],
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
  voiceApiRef.current = { dispatch: voice.dispatch, setTtsActive: voice.setTtsActive, getState: voice.getState }

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

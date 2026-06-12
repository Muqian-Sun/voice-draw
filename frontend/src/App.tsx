import { useCallback, useEffect, useRef, useState } from 'react'
import type Konva from 'konva'
import { parseOps, type Op } from './dsl'
import { createHistory, executeWithHistory, type HistoryOutcome, type HistoryState } from './engine/history'
import { CanvasStage } from './components/CanvasStage'
import { DebugPanel, type LogEntry } from './components/DebugPanel'
import { buildAmbiguityClarify, matchExpecting, type ExpectingItem } from './nlu/clarify'
import { correctTranscript } from './nlu/correction'
import { parseWithLlm } from './nlu/llm'
import { decideMode, extractPlanSubject, parseRule, type RuleContext } from './nlu/rules'
import { SpeculativeParser } from './nlu/speculate'
import { CONFIRM_YES_WORDS } from './shared/lexicon'
import { CONFIRM_WINDOW_MS, STATE_LABELS, type VoiceEvent, type VoiceState } from './voice/fsm'
import { GatewayTts, TtsOrchestrator, WebSpeechTts } from './voice/tts'
import { useVoice } from './voice/useVoice'

let logSeq = 0

/** 视觉质检指令（能力 #27）：修正必须声明式，VLM 像素估读不可靠 */
const CRITIQUE_INSTRUCTION =
  '这是当前画布的渲染截图与场景 JSON。请对照检查视觉缺陷：部件错位/悬空/朝向错误/比例失调/不当遮挡。' +
  '发现缺陷则输出修正 ops（byName/byId 引用现有对象）。修正位置**必须**用相对定位' +
  '（move.to 的 ref+anchor+offset/inside，参照 scene JSON 里的真实对象），' +
  '禁止自己估算绝对 x,y——你的像素估读不可靠；' +
  "画面没有明显缺陷则 intent:'reject' 且 say:'画面看起来没问题'。"

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

  /** 执行一个已校验前的 Op 数组（面板按钮 / 控制台 / 理解层共用入口）；autoGroupName 见 §5.1 llm-plan 行 */
  const execOps = useCallback(
    (ops: unknown, autoGroupName?: string): HistoryOutcome | { error: string } => {
      const parsed = parseOps(Array.isArray(ops) ? ops : [ops])
      if (!parsed.ok) {
        pushLog('error', `DSL 校验失败：${parsed.error}`)
        return { error: parsed.error }
      }
      const outcome = executeWithHistory(historyRef.current, parsed.ops, { autoGroupName })
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

  /** 视觉自检修复环：截图 → 多模态质检 → 修正执行，画面通过即停（最多 maxRounds 轮） */
  const runVisualCheck = useCallback(
    async (maxRounds: number): Promise<{ rounds: number; fixed: number; clean: boolean }> => {
      let fixed = 0
      for (let round = 1; round <= maxRounds; round++) {
        const stage = stageRef.current
        if (stage === null) return { rounds: round - 1, fixed, clean: false }
        const overlay = stage.findOne<Konva.Layer>('.overlay')
        overlay?.visible(false)
        const image = stage.toDataURL({ pixelRatio: 0.75 })
        overlay?.visible(true)
        const llm = await parseWithLlm(CRITIQUE_INSTRUCTION, 'parse', { scene: historyRef.current.scene, image })
        if (!llm.ok) {
          pushLog('error', `自检第 ${round} 轮失败：${llm.error}`)
          return { rounds: round, fixed, clean: false }
        }
        const res = llm.result
        if (res.intent !== 'ops' || res.ops.length === 0) {
          pushLog('info', `自检第 ${round} 轮：画面通过 ✓（${res.latencyMs.toFixed(0)}ms）`)
          return { rounds: round, fixed, clean: true }
        }
        const outcome = execOps(res.ops)
        const failed = 'error' in outcome && Boolean(outcome.error)
        pushLog(
          failed ? 'warn' : 'info',
          `自检第 ${round} 轮：修正 ${res.ops.length} 处——${res.say ?? ''}（${res.latencyMs.toFixed(0)}ms）`,
        )
        if (failed) return { rounds: round, fixed, clean: false }
        fixed += res.ops.length
      }
      return { rounds: maxRounds, fixed, clean: false } // 轮次用尽仍有发现（保守停手防震荡）
    },
    [execOps, pushLog],
  )

  // 最近 3 轮成功指令（协议 §2.2 recent，供 LLM 多轮指代）
  const recentRef = useRef<Array<{ utterance: string; summary: string }>>([])
  const lastTxRef = useRef<{ utterance: string; opCount: number } | undefined>(undefined)

  // 投机解析（协议 §4.1）：partial 预解析缓存，final 一致直接复用
  const specRef = useRef(new SpeculativeParser())
  // 延迟/成本埋点看板
  const [metrics, setMetrics] = useState({ rule: 0, llmParse: 0, llmPlan: 0, fails: 0, last: '—' })

  const ruleCtx = useCallback((): RuleContext => {
    const scene = historyRef.current.scene
    return {
      // 对象名 + 组名都参与 byName 热匹配（"把雪人移到右边"）
      names: [
        ...new Set(
          scene.objects.flatMap((o) => [o.name, o.groupId]).filter((n): n is string => n !== undefined && n.length > 0),
        ),
      ],
      hasFocus: scene.focusId !== undefined,
    }
  }, [])

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

      // 投机解析（§4.1）：final 与最后一次 partial 一致 → 复用预解析（纠错+规则匹配零耗时）
      const spec = specRef.current.takeForFinal(trimmed)
      let corrected: string
      if (spec !== null) {
        corrected = spec.corrected
        if (spec.original !== spec.corrected) pushLog('info', `纠错（投机预算）：「${spec.original}」→「${spec.corrected}」`)
      } else {
        const corr = correctTranscript(trimmed)
        if (corr.applied.length > 0) pushLog('info', `纠错：「${corr.original}」→「${corr.corrected}」`)
        corrected = corr.corrected
      }
      let utterance = corrected

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

      // 视觉自检（"检查一下画面"）：截图喂多模态 LLM，产出修正 Op（按需多模态，仅此处附图）
      if (/(检查|看看|自检).*(画面|画布)|^自检$/.test(utterance)) {
        if (historyRef.current.scene.objects.length === 0) {
          advance(false)
          say('画布是空的，没什么可检查')
          return
        }
        pushLog('info', '视觉自检：截图 → 多模态 LLM 质检（≤3 轮）…')
        void (async () => {
          const r = await runVisualCheck(3)
          if (r.fixed > 0) {
            advance(true)
            say(r.clean ? `修正了 ${r.fixed} 处，画面没问题了` : `修正了 ${r.fixed} 处`)
          } else {
            advance(false)
            say(r.clean ? '画面看起来没问题' : '自检没成功，请再试一次')
          }
        })()
        return
      }

      // 投机缓存的规则结果仅在话语未被澄清联合改写时可复用
      const specReused = spec !== null && utterance === spec.corrected
      const r = specReused ? spec.rule : parseRule(utterance, ruleCtx())
      if (r === null) {
        const mode = decideMode(utterance)
        pushLog('info', `规则未命中 → 升级 LLM（mode=${mode}）…`)
        void (async () => {
          const llm = await parseWithLlm(utterance, mode, {
            scene: historyRef.current.scene,
            asrAlternatives: utterance !== trimmed ? [trimmed] : [],
            recent: recentRef.current,
            lastTransaction: lastTxRef.current,
          })
          if (!llm.ok) {
            pushLog('error', `LLM 解析失败：${llm.error}`)
            setMetrics((m) => ({ ...m, fails: m.fails + 1, last: 'LLM 失败' }))
            advance(false)
            say('没听懂，请换个说法')
            return
          }
          const res = llm.result
          pushLog('info', `LLM 命中 ${res.source}（${res.latencyMs.toFixed(0)}ms，confidence ${res.confidence.toFixed(2)}）`)
          setMetrics((m) => ({
            ...m,
            llmParse: m.llmParse + (res.source === 'llm-parse' ? 1 : 0),
            llmPlan: m.llmPlan + (res.source === 'llm-plan' ? 1 : 0),
            last: `${res.source}·${(res.latencyMs / 1000).toFixed(1)}s`,
          }))
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
          // llm-plan：本事务新建对象自动编组（组名=话术主名词，§5.1），随后 desc 逐条进度播报
          const groupName = res.source === 'llm-plan' ? (extractPlanSubject(utterance) ?? undefined) : undefined
          const outcome = execOps(res.ops, groupName)
          const ok = !('error' in outcome && outcome.error)
          if (res.source === 'llm-plan' && ok) {
            if (groupName !== undefined) pushLog('info', `已自动编组「${groupName}」（整组移动/缩放/删除生效）`)
            // desc 只进日志不播报：图像瞬时画完，逐条语音报步骤是冗余（用户反馈）；完成语照播
            for (const o of res.ops) {
              if (o.op === 'create' && o.desc !== undefined) pushLog('info', `▸ ${o.desc}`)
            }
          }
          if (speakOutcome(outcome, res.say, res.ops)) recordSuccess(utterance, res.ops)
        })()
        return
      }
      pushLog('info', `规则命中 ${r.template}（${r.latencyMs.toFixed(1)}ms${specReused ? '，投机预解析复用' : ''}）`)
      setMetrics((m) => ({ ...m, rule: m.rule + 1, last: `${r.template}·${r.latencyMs.toFixed(1)}ms${specReused ? '·投机' : ''}` }))
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
    [execOps, pushLog, recordSuccess, ruleCtx, runVisualCheck, say],
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

  // 语音 final → 同一理解通道（纠错 → 规则 → LLM），与调试面板共用；partial → 投机预解析
  const voice = useVoice({
    onLog: pushLog,
    onUtterance: (text) => execText(text),
    onPartial: (text) => specRef.current.onPartial(text, ruleCtx()),
  })
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
        <span className="status-pill" title="规则命中 / LLM 调用（parse+plan）/ 投机命中率 / 最近一次解析来源与延迟">
          规则 {metrics.rule} ｜ LLM {metrics.llmParse + metrics.llmPlan}
          {specRef.current.stats.speculated > 0 &&
            ` ｜ 投机 ${specRef.current.stats.hits}/${specRef.current.stats.hits + specRef.current.stats.misses}`}
          ｜ 最近 {metrics.last}
        </span>
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

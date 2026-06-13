import { useCallback, useEffect, useRef, useState } from 'react'
import { CANVAS_HEIGHT, CANVAS_WIDTH, parseOps, type Op } from './dsl'
import { commitIncremental, createHistory, executeWithHistory, type HistoryOutcome, type HistoryState } from './engine/history'
import { FreehandSceneStage, type FreehandCaptureHandle } from './components/FreehandSceneStage'
import { DebugPanel, type LogEntry } from './components/DebugPanel'
import { buildAmbiguityClarify, matchExpecting, type ExpectingItem } from './nlu/clarify'
import { executeTransaction } from './engine/interpreter'
import { getBBox, type SceneState } from './engine/scene'
import { correctTranscript } from './nlu/correction'
import { parseWithLlm, parseWithLlmStream } from './nlu/llm'
import { decideMode, extractPlanSubject, parseRule, type RuleContext } from './nlu/rules'
import { SpeculativeParser } from './nlu/speculate'
import { isConfirmYes } from './nlu/confirm'
import { CONFIRM_WINDOW_MS, STATE_LABELS, type VoiceEvent, type VoiceState } from './voice/fsm'
import { GatewayTts, TtsOrchestrator, WebSpeechTts } from './voice/tts'
import { useVoice } from './voice/useVoice'

let logSeq = 0

/** plan 创作后后台自检精修的最多轮数（不追求一次成图，逐轮迭代，VLM 判通过即提前停） */
const AUTO_CRITIQUE_ROUNDS = 3

/** 视觉质检指令（能力 #27）：修正必须声明式，VLM 像素估读不可靠 */
const CRITIQUE_INSTRUCTION =
  '这是当前画布的渲染截图与场景 JSON。请对照检查视觉缺陷：部件错位/悬空/朝向错误/比例失调/不当遮挡。' +
  '发现缺陷则输出修正 ops（byName/byId 引用现有对象）。修正位置**必须**用相对定位' +
  '（move.to 的 ref+anchor+offset/inside，参照 scene JSON 里的真实对象；' +
  '修"部件悬空/没贴上"优先用 "onEdge":true——中心钉到参照真实形状边缘），' +
  '禁止自己估算绝对 x,y——你的像素估读不可靠；' +
  "画面没有明显缺陷则 intent:'reject' 且 say:'画面看起来没问题'。"

/** 主动共创建议（v1.7 新颖设计）：画完主动提议一处补充，待用户同意再画 */
const SUGGEST_INSTRUCTION =
  '这是当前画布的场景 JSON。你是主动的绘画共创伙伴：提议一个能让画面更完整、更生动的小添加' +
  '（1~3 个部件，用相对定位 ref 贴合现有对象、颜色协调，可用 shadow/tension/gradient 提质）。' +
  "intent='ops'，ops=要添加的部件（先别当成已画），say=口语化的征询邀请（≤20 字，" +
  '例"画面右边有点空，加棵小松树好吗？"）。只提一个最自然的建议；' +
  "若画面已相当完整或不宜再加，则 intent='reject'、ops 为空。"

/** 本地几何预检（免费、确定性）：检出明显超出画布的部件，作为线索喂给视觉自检，纠错更准。
 *  只报"出界"这种高置信缺陷——部件间的重叠多为有意（眼睛在脸上），不在此误报。 */
function geometricFindings(scene: SceneState): string {
  const out: string[] = []
  for (const o of scene.objects) {
    const [x, y, w, h] = getBBox(o)
    if (w <= 0 || h <= 0) continue
    const hOver = Math.max(0, -x) + Math.max(0, x + w - CANVAS_WIDTH)
    const vOver = Math.max(0, -y) + Math.max(0, y + h - CANVAS_HEIGHT)
    if (hOver > w * 0.25 || vOver > h * 0.25) out.push(o.name ?? o.id)
  }
  if (out.length === 0) return ''
  return `部件明显超出画布、需用相对定位移回画布内：${[...new Set(out)].slice(0, 8).join('、')}`
}

export default function App() {
  const [history, setHistory] = useState<HistoryState>(createHistory)
  const historyRef = useRef(history)
  historyRef.current = history
  const stageRef = useRef<FreehandCaptureHandle | null>(null)

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
        // 焦点高亮/网格属界面装饰，不进导出图：toDataURL 单独渲染干净整幅
        const url = stageRef.current?.toDataURL(2)
        if (url) {
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

  // 共创建议窗口（v1.7）：plan 画完主动提议补充，待用户回应；说"好"采纳、其余丢弃继续
  const pendingSuggestRef = useRef<Op[] | null>(null)
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [suggestText, setSuggestText] = useState<string | null>(null)
  const clearSuggest = useCallback(() => {
    if (suggestTimerRef.current !== null) {
      clearTimeout(suggestTimerRef.current)
      suggestTimerRef.current = null
    }
    pendingSuggestRef.current = null
    setSuggestText(null)
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
        const cap = stageRef.current
        if (cap === null) return { rounds: round - 1, fixed, clean: false }
        const image = cap.toDataURL(1.0) // 干净整幅（无笔/选中框），VLM 看清 ±10px 错位
        // 本地几何预检线索并入质检指令（出界等高置信缺陷，指引 VLM 更准）
        const findings = geometricFindings(historyRef.current.scene)
        const instruction = findings === '' ? CRITIQUE_INSTRUCTION : `${CRITIQUE_INSTRUCTION}\n本地几何预检：${findings}`
        const llm = await parseWithLlm(instruction, 'parse', { scene: historyRef.current.scene, image })
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

  /** 共创建议（v1.7）：读当前场景，让 LLM 主动提议一处补充；存起来 + 播报征询 + 弹气泡，待用户回应 */
  const proactiveSuggest = useCallback(async () => {
    const scene = historyRef.current.scene
    if (scene.objects.length === 0) return
    const llm = await parseWithLlm(SUGGEST_INSTRUCTION, 'parse', { scene })
    if (!llm.ok) return
    const res = llm.result
    if (res.intent !== 'ops' || res.ops.length === 0 || res.say === undefined || res.say.length === 0) return
    pendingSuggestRef.current = res.ops
    setSuggestText(res.say)
    pushLog('info', `💡 主动建议：${res.say}`)
    say(res.say)
    if (suggestTimerRef.current !== null) clearTimeout(suggestTimerRef.current)
    suggestTimerRef.current = setTimeout(() => clearSuggest(), 25_000) // 久无回应自动撤销建议
  }, [clearSuggest, pushLog, say])

  /** plan 创作完成后：① 后台多轮异步自检精修（不追求一次成图，逐轮"自检→修正"，画面越改越好，
      VLM 判通过即提前停；本地几何预检并入指引）② 精修后再给一条共创建议。
      等两帧确保新场景已上屏再截图，否则会截到旧画面。 */
  const autoCritiqueAfterPlan = useCallback(() => {
    void (async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
      if (historyRef.current.scene.objects.length === 0) return
      pushLog('info', `🔍 创作完成，后台多轮自检精修（最多 ${AUTO_CRITIQUE_ROUNDS} 轮，通过即停）…`)
      const r = await runVisualCheck(AUTO_CRITIQUE_ROUNDS)
      pushLog('info', `自检精修完成：${r.rounds} 轮、修正 ${r.fixed} 处${r.clean ? '、画面通过 ✓' : ''}`)
      await proactiveSuggest() // 精修后基于最终画面提建议
    })()
  }, [proactiveSuggest, pushLog, runVisualCheck])

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

      // 确认窗口期：含肯定词且无否定词→执行，其余视为否定（规格 §2.6 保守策略）。
      // 包含匹配兼容"我确认/确认清空/确定吧"等带前后缀口语；再对纠错后文本判一次，兜住语音同音偏差。
      if (pendingConfirmRef.current !== null) {
        clearConfirmTimer()
        const pending = pendingConfirmRef.current
        pendingConfirmRef.current = null
        if (isConfirmYes(trimmed) || isConfirmYes(correctTranscript(trimmed).corrected)) {
          advance(true)
          speakOutcome(execOps(pending), '已清空')
        } else {
          advance(false)
          say('已取消')
        }
        return
      }

      // 共创建议窗口（v1.7）：说"好/可以"→采纳绘制；否则丢弃建议并把本句当新指令继续处理（软窗口，不 return）
      if (pendingSuggestRef.current !== null) {
        const suggested = pendingSuggestRef.current
        const accept = isConfirmYes(trimmed) || isConfirmYes(correctTranscript(trimmed).corrected)
        clearSuggest()
        if (accept) {
          advance(true)
          const outcome = execOps(suggested)
          if (!('error' in outcome && outcome.error)) {
            say('好嘞，加上了')
            recordSuccess(trimmed, suggested)
          } else {
            say('这个加得不太顺，先跳过')
          }
          return
        }
        // 非肯定：建议已丢弃，继续按新指令解析本句
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
          const llmCtx = {
            scene: historyRef.current.scene,
            asrAlternatives: utterance !== trimmed ? [trimmed] : [],
            recent: recentRef.current,
            lastTransaction: lastTxRef.current,
          }

          // v1.4 流式渐进绘制优先：LLM 边写边画（首个部件 ~2s 可见）；
          // 终验失败 → 回滚画布 → 落回下方缓冲模式（自带一次重试）
          const base = historyRef.current
          let work = base.scene
          let painted = 0
          let execFailed = false
          const stream = await parseWithLlmStream(utterance, mode, llmCtx, (op) => {
            if (execFailed) return
            const r2 = executeTransaction(work, [op])
            if (r2.error !== undefined) {
              execFailed = true
              pushLog('warn', `渐进绘制中断：${r2.error.code} ${r2.error.message}`)
              return
            }
            work = r2.state
            painted += 1
            // 首个部件上屏即把状态从"解析中"切到"执行中(绘制)"，避免长流期间一直显示"解析中"
            if (painted === 1) voiceApiRef.current?.dispatch('PARSE_DONE')
            historyRef.current = { ...historyRef.current, scene: work }
            setHistory(historyRef.current)
            // 边画边解说：每画一件即语音播报其 desc（say 内部已写 🔊 日志；TTS 串行排队，与渐进绘制同步推进）
            if (op.op === 'create' && op.desc !== undefined) say(op.desc)
          })

          if (stream.ok && !execFailed) {
            const res = stream.result
            pushLog('info', `LLM 命中 ${res.source}（${res.latencyMs.toFixed(0)}ms，流式渐进 ${painted} 件）`)
            setMetrics((m) => ({
              ...m,
              llmParse: m.llmParse + (res.source === 'llm-parse' ? 1 : 0),
              llmPlan: m.llmPlan + (res.source === 'llm-plan' ? 1 : 0),
              last: `${res.source}·${(res.latencyMs / 1000).toFixed(1)}s·流式`,
            }))
            if (res.intent === 'clarify') {
              advance(false)
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
            const groupName = res.source === 'llm-plan' ? (extractPlanSubject(utterance) ?? undefined) : undefined
            const committed = commitIncremental(base, work, { autoGroupName: groupName })
            historyRef.current = committed
            setHistory(committed)
            if (groupName !== undefined && committed.scene !== work) {
              pushLog('info', `已自动编组「${groupName}」（整组移动/缩放/删除生效）`)
            }
            say(res.say)
            recordSuccess(utterance, res.ops)
            if (res.source === 'llm-plan') autoCritiqueAfterPlan() // v1.7：创作完成自动自检一轮
            return
          }

          // 回滚渐进内容，退回缓冲模式
          if (painted > 0) {
            historyRef.current = base
            setHistory(base)
          }
          pushLog('warn', `流式路径未完成（${stream.ok ? '执行中断' : stream.error}）→ 回退缓冲模式…`)
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
          if (res.source === 'llm-plan' && ok) autoCritiqueAfterPlan() // v1.7：创作完成自动自检一轮
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
    [autoCritiqueAfterPlan, clearSuggest, execOps, pushLog, recordSuccess, ruleCtx, runVisualCheck, say],
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

  // 工程台抽屉（默认收起；保留赛制要求的非语音降级入口 + 演示用埋点看板）
  const [devOpen, setDevOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDevOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 画板自适应缩放：固定 1024×768 画布按可视区等比缩放居中（仅显示，不影响坐标/导出）
  const viewportRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(0.6)
  useEffect(() => {
    const el = viewportRef.current
    if (el === null) return
    const compute = () => {
      // 横向少留边、纵向留出图注空间；画板尽量铺满图版，减少四周空隙
      const s = Math.min((el.clientWidth - 56) / CANVAS_WIDTH, (el.clientHeight - 72) / CANVAS_HEIGHT)
      setFit(s > 0 ? Math.min(s, 1) : 0.1)
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 进入即自动常听（无"开始"按钮）。浏览器首次弹麦克风授权；被拒/无手势失败 → 显示重试
  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (autoStartedRef.current) return
    autoStartedRef.current = true
    void voice.start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const scene = history.scene
  const op = (o: Op) => () => execOps(o)
  const loading = voice.vadStatus === 'loading'
  const errored = voice.vadStatus === 'error'
  const running = voice.state !== 'idle' // 常听运行中
  const hearing = voice.hearing // 正听到人声
  const stats = specRef.current.stats
  // 主控球是「状态灯」而非「开始」按钮：点击=静音/恢复；出错或休眠时点击=重开
  const orbClass = [
    'voice-orb',
    errored ? 'is-error' : '',
    !running && !loading && !errored ? 'is-muted' : '',
    running ? 'is-live' : '',
    hearing ? 'voice-on' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const statusLabel = loading
    ? '开启麦克风中'
    : errored
      ? '麦克风未开启'
      : !running
        ? voice.asleep
          ? '已休眠'
          : '已静音'
        : hearing
          ? '在听…'
          : STATE_LABELS[voice.state]
  const statusHint = loading
    ? '首次需授权麦克风'
    : errored
      ? '点麦克风重试'
      : !running
        ? '点麦克风恢复常听'
        : hearing
          ? '正在识别'
          : voice.state === 'listening'
            ? '随时开口 · 自动识别'
            : ''
  return (
    <div className="app">
      {/* 竖排书脊标（艺术印刷跑头，左右对称，贴视口边） */}
      <div className="spine spine-left" aria-hidden>VOICE-DRIVEN DRAWING · 开口成画</div>
      <div className="spine spine-right" aria-hidden>ATELIER EDITION · 实时语音共创</div>

      {/* 版面：细外框内的一张"印刷页" */}
      <div className="page">
        {/* 眉头 masthead */}
        <header className="masthead">
          <div className="mast-brand">
            <div className="brand-mark" aria-hidden>
              <span />
              <span />
              <span />
            </div>
            <h1 className="mast-title">
              Voice<b>Draw</b>
            </h1>
            <span className="mast-divider" aria-hidden />
            <span className="mast-tag">语音绘图 · 开口成画</span>
          </div>
          <div className="mast-meta">
            <span className="folio">№ 01 · MMXXVI</span>
            <span className="mast-status" data-state={voice.state}>
              <span className="state-dot" data-state={voice.state} />
              {statusLabel}
            </span>
            <button
              className={`dev-toggle ${devOpen ? 'is-open' : ''}`}
              onClick={() => setDevOpen((v) => !v)}
              title="工程台 / 调试面板（Esc 关闭）"
              aria-label="工程台"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M8 6 3 12l5 6M16 6l5 6-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </header>

        {/* 主图版 plate：Riso 海报装饰 + 等比自适应居中的暖纸画板 + 图版说明 */}
        <main className="plate" ref={viewportRef}>
          {/* Riso 三色叠印装饰：绘图原语放大成海报色块（位于画板后、填满四周空白） */}
          <svg className="decor" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" aria-hidden>
            <circle className="d-red" cx="70" cy="120" r="190" />
            <circle className="d-ring" cx="1130" cy="690" r="200" fill="none" />
            <path className="d-yellow" d="M1060 70 L1190 70 L1125 188 Z" />
            <path className="d-tri" d="M150 690 L250 690 L200 600 Z" fill="none" />
            <path className="d-wave" d="M30 540 q42 -46 84 0 t84 0 t84 0" fill="none" />
            <circle className="d-dot" cx="980" cy="150" r="13" />
            <circle className="d-dot" cx="1020" cy="150" r="13" />
            <circle className="d-dot" cx="1060" cy="150" r="13" />
          </svg>
          <div className="stage-scaler" style={{ transform: `translate(-50%, -50%) scale(${fit})` }}>
            <div className="stage-frame">
              <FreehandSceneStage scene={scene} ref={stageRef} />
            </div>
          </div>
          {/* 浮层：共创建议气泡 + 实时字幕（压在图版下沿之上） */}
          <div className="plate-overlay">
            {suggestText && (
              <div className="suggest-chip" role="status">
                <span className="suggest-icon" aria-hidden>
                  ✦
                </span>
                <span className="suggest-text">{suggestText}</span>
                <span className="suggest-hint">说「好」采纳 · 「不用」跳过</span>
              </div>
            )}
            {voice.subtitle && <div className={`subtitle subtitle-${voice.subtitle.kind}`}>{voice.subtitle.text}</div>}
          </div>
          <div className="plate-cap">图版 — 实时语音绘制 · 对象 {scene.objects.length} · 1024 × 768</div>
        </main>

        {/* 页脚信息线：麦克风作"封印"居中压线 */}
        <footer className="footer">
          <span className="foot-side foot-left">共创 · 实时 · 语音绘图</span>
          <div className="foot-seal">
            <button
              className={orbClass}
              onClick={running ? voice.stop : voice.start}
              disabled={loading}
              aria-label={running ? '静音' : '开启麦克风'}
              title={running ? '点击静音' : '点击开启麦克风'}
            >
              <span className="orb-ring" aria-hidden />
              <span className="orb-ring orb-ring-2" aria-hidden />
              <span className="orb-mic" aria-hidden>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                  <rect x="9" y="2.5" width="6" height="11" rx="3" fill="currentColor" />
                  <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="orb-eq" aria-hidden>
                <i />
                <i />
                <i />
                <i />
              </span>
            </button>
            <div className="dock-status">
              <b>{statusLabel}</b>
              {statusHint && <em>{statusHint}</em>}
            </div>
          </div>
          <span className="foot-side foot-right">v1.7 · ATELIER EDITION</span>
        </footer>
      </div>

      {/* 工程台抽屉 */}
      <div className={`dev-scrim ${devOpen ? 'is-open' : ''}`} onClick={() => setDevOpen(false)} />
      <aside className={`dev-drawer ${devOpen ? 'is-open' : ''}`} aria-hidden={!devOpen}>
        <div className="dev-head">
          <span className="dev-head-title">工程台 · Telemetry</span>
          <button className="dev-close" onClick={() => setDevOpen(false)} aria-label="关闭工程台">
            ✕
          </button>
        </div>
        <div className="telemetry-grid">
          <span className="readout">
            <i className="readout-k">
              <span className="state-dot" data-state={voice.state} />
              状态
            </i>
            <b className="readout-v">{STATE_LABELS[voice.state]}</b>
          </span>
          <span className="readout">
            <i className="readout-k">ASR</i>
            <b className="readout-v">{voice.providerName}</b>
          </span>
          <span className="readout" title="规则命中 / LLM 调用（parse+plan）/ 投机命中率">
            <i className="readout-k">解析</i>
            <b className="readout-v">
              规则 <b>{metrics.rule}</b>
              <em>·</em>LLM <b>{metrics.llmParse + metrics.llmPlan}</b>
              {stats.speculated > 0 && (
                <>
                  <em>·</em>投机 <b>{stats.hits}/{stats.hits + stats.misses}</b>
                </>
              )}
            </b>
          </span>
          <span className="readout" title="最近一次解析来源与延迟">
            <i className="readout-k">最近</i>
            <b className="readout-v">{metrics.last}</b>
          </span>
          <span className="readout">
            <i className="readout-k">场景</i>
            <b className="readout-v">
              对象 <b>{scene.objects.length}</b>
              <em>·</em>焦点 {scene.focusId ?? '无'}
            </b>
          </span>
          <span className="readout">
            <i className="readout-k">历史</i>
            <b className="readout-v">
              撤销 {history.undoStack.length}<em>/</em>重做 {history.redoStack.length}
            </b>
          </span>
        </div>
        <DebugPanel
          entries={log}
          onSubmit={execText}
          onUndo={op({ op: 'undo' })}
          onRedo={op({ op: 'redo' })}
          onClear={op({ op: 'clear' })}
        />
      </aside>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { CANVAS_HEIGHT, CANVAS_WIDTH, parseOps, type Op } from './dsl'
import { commitIncremental, createHistory, executeWithHistory, type HistoryOutcome, type HistoryState } from './engine/history'
import { FreehandSceneStage, type FreehandCaptureHandle } from './components/FreehandSceneStage'
import { DebugPanel, type LogEntry } from './components/DebugPanel'
import { buildAmbiguityClarify, matchExpecting, type ExpectingItem } from './nlu/clarify'
import { createForwardTolerantRunner } from './engine/forwardRetry'
import { type SceneState } from './engine/scene'
import { correctTranscript } from './nlu/correction'
import { parseWithLlm, parseWithLlmStream } from './nlu/llm'
import { orchestrateSubplans, looksMultiSubject } from './nlu/orchestrate'
import { decideMode, extractPlanSubject, parseRule, type RuleContext } from './nlu/rules'
import { SpeculativeParser } from './nlu/speculate'
import { isConfirmYes } from './nlu/confirm'
import { CONFIRM_WINDOW_MS, STATE_LABELS, type VoiceEvent, type VoiceState } from './voice/fsm'
import { GatewayTts, TtsOrchestrator, WebSpeechTts } from './voice/tts'
import { useVoice } from './voice/useVoice'

let logSeq = 0

/** 主动共创建议（v1.7 新颖设计）：画完主动提议一处补充，待用户同意再画 */
const SUGGEST_INSTRUCTION =
  '这是当前画布的场景 JSON。你是主动的绘画共创伙伴：提议一个能让画面更完整、更生动的小添加' +
  '（1~3 个部件，用相对定位 ref 贴合现有对象、颜色协调，可用 shadow/tension/gradient 提质）。' +
  "intent='ops'，ops=要添加的部件（先别当成已画），say=口语化的征询邀请（≤20 字，" +
  '例"画面右边有点空，加棵小松树好吗？"）。只提一个最自然的建议；' +
  "若画面已相当完整或不宜再加，则 intent='reject'、ops 为空。"

/** 场景持久化键：仅存当前场景快照，刷新后画面保留（undo/redo 历史不持久化，可接受） */
const SCENE_STORAGE_KEY = 'voicedraw:scene'

/** 初始 history：尝试从 localStorage 恢复上次场景，失败/无存档则回退空场景。
 *  恢复后撤销/重做栈留空——刷新保住画面即可，丢历史可接受。所有 IO 入 try/catch（SSR/配额/解析安全）。 */
function loadHistory(): HistoryState {
  try {
    const raw = localStorage.getItem(SCENE_STORAGE_KEY)
    if (raw === null) return createHistory()
    const scene = JSON.parse(raw) as SceneState
    // 最低限度校验：是带 objects 数组的对象（脏数据/旧格式直接回退空场景）
    if (typeof scene !== 'object' || scene === null || !Array.isArray(scene.objects)) return createHistory()
    return createHistory(scene)
  } catch {
    return createHistory()
  }
}

export default function App() {
  const [history, setHistory] = useState<HistoryState>(loadHistory)
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

  /** plan 创作完成后：等两帧确保新场景已上屏，再给一条共创建议（基于最终画面）。 */
  const suggestAfterPlan = useCallback(() => {
    void (async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
      await proactiveSuggest()
    })()
  }, [proactiveSuggest])

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
  const llmBusyRef = useRef(false)

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
          // 失败/澄清/拒识：从 parsing 走 PARSE_FAIL、从 executing（已首帧出图）走 EXEC_DONE，
          // 两者都落到 speaking。缺 EXEC_DONE 时 executing 态的 PARSE_FAIL 是非法转移→FSM 卡死
          // （配合"绘画中禁识别"门控会致麦克风变哑）。
          d('PARSE_FAIL')
          d('EXEC_DONE')
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
        // 只在"画完(本次新增了对象)"时播报完成语；纯编辑/调整/清空过程静默（用户要求：绘画过程不播报）
        if (ops?.some((o) => o.op === 'create')) say(sayText)
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

      // 投机缓存的规则结果仅在话语未被澄清联合改写时可复用
      const specReused = spec !== null && utterance === spec.corrected
      const r = specReused ? spec.rule : parseRule(utterance, ruleCtx())
      if (r === null) {
        const mode = decideMode(utterance)
        pushLog('info', `规则未命中 → 升级 LLM（mode=${mode}）…`)
        if (llmBusyRef.current) {
          // 在途有绘制：直接忽略本句，不调 advance——绘制中的请求正占着 FSM（executing），
          // 这里复位会打断它。语音输入已被"绘画中禁识别"门控挡在前面，此分支基本只剩调试文本可达。
          pushLog('warn', `正在绘制上一句，已忽略本句：「${utterance}」（请等画完再说）`)
          return
        }
        llmBusyRef.current = true
        void (async () => {
          try {
            // 子计划编排（多主体 plan）：planner 布局 → 逐角色子计划 → 一次提交
            if (mode === 'plan' && looksMultiSubject(utterance)) {
              const base0 = historyRef.current
              const orch = await orchestrateSubplans(
                utterance, base0.scene,
                { scene: base0.scene, asrAlternatives: utterance !== trimmed ? [trimmed] : [], recent: recentRef.current, lastTransaction: lastTxRef.current },
                {
                  onScene: (s) => { historyRef.current = { ...historyRef.current, scene: s }; setHistory(historyRef.current) },
                  onFirstPaint: () => voiceApiRef.current?.dispatch('PARSE_DONE'),
                  onLog: (msg) => pushLog('info', msg),
                },
              )
              if (orch.ok) {
                advance(true)
                const committed = commitIncremental(base0, orch.scene) // 一次快照；组已逐主体编好，不再 autoGroup
                historyRef.current = committed
                setHistory(committed)
                say('画好啦')
                recordSuccess(utterance, [])
                suggestAfterPlan()
                return
              }
              // orch fallback（planner 失败/单主体/全失败）→ 不 return，继续走下面普通流式 plan
            }

            const llmCtx = {
              scene: historyRef.current.scene,
              asrAlternatives: utterance !== trimmed ? [trimmed] : [],
              recent: recentRef.current,
              lastTransaction: lastTxRef.current,
            }

            // v1.4 流式渐进绘制优先：LLM 边写边画（首个部件 ~2s 可见）
            const base = historyRef.current
            let painted = 0
            // 流式容错（修复"画一半→画布清空→过一会完整重贴"）：单 op 执行失败绝不清空整幅。
            // ① 前向引用（TARGET_NOT_FOUND，LLM 乱序）→ runner 暂存待依赖创建后重试；
            // ② 同名歧义（AMBIGUOUS_TARGET，持久化场景里新主体部件名与旧的撞车，如末尾 group）
            //    → 软跳过该 op（plan 的 group 跳过无妨，commit 时 autoGroup 仍编组），保留已画部分。
            const runner = createForwardTolerantRunner(base.scene, (op, state) => {
              painted += 1
              // 首个部件上屏即把状态从"解析中"切到"执行中(绘制)"，避免长流期间一直显示"解析中"
              if (painted === 1) voiceApiRef.current?.dispatch('PARSE_DONE')
              historyRef.current = { ...historyRef.current, scene: state }
              setHistory(historyRef.current)
              // 绘画过程不语音播报（用户要求）：逐件 desc 仅进日志可见，不朗读；完成语在画完时统一播
              if (op.op === 'create' && op.desc !== undefined) pushLog('info', `▸ ${op.desc}`)
            })
            const stream = await parseWithLlmStream(utterance, mode, llmCtx, (op) => runner.push(op))
            const fin = runner.finish()
            const work = fin.state
            if (fin.skipped.length > 0 || fin.pending.length > 0) {
              const s = fin.skipped.map((x) => x.error.code)
              pushLog('warn', `流式渐进：跳过 ${fin.skipped.length} 个失败 op${s.length ? `（${[...new Set(s)].join('/')}）` : ''}、${fin.pending.length} 个悬空引用——保留已绘制部分，不清空`)
            }
            // 只有"一件都没画成"或流本身失败(stream.ok=false) 才回退缓冲；画成任意部件即提交（不再因单 op 失败清空重贴）
            const execFailed = painted === 0

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
              // 只在"画完(本次新增了对象)"时播报完成语；纯编辑/调整过程静默（用户要求）
              if (res.ops.some((o) => o.op === 'create')) say(res.say)
              recordSuccess(utterance, res.ops)
              if (res.source === 'llm-plan') suggestAfterPlan() // v1.7：创作完成给一条共创建议
              return
            }

            // 流式终验未过（plan op 总数超限/交付与清单不齐/尾部 JSON 不合法）但已画出有效部件：
            // 保留提交、绝不回滚清空——每个流式部件都已逐 op 校验(opSchema)+执行(forwardRetry)过，
            // 终验那点是聚合层面的瑕疵，不该牵连已画好的（修"画着画着前面的没了"，如老虎 32 op>28）。
            if (!stream.ok && painted > 0) {
              advance(true)
              const groupName = mode === 'plan' ? (extractPlanSubject(utterance) ?? undefined) : undefined
              const committed = commitIncremental(base, work, { autoGroupName: groupName })
              historyRef.current = committed
              setHistory(committed)
              pushLog('warn', `流式终验未过（${stream.error}），但 ${painted} 件已逐 op 校验通过 → 保留提交不清空`)
              setMetrics((m) => ({
                ...m,
                llmPlan: m.llmPlan + (mode === 'plan' ? 1 : 0),
                llmParse: m.llmParse + (mode === 'parse' ? 1 : 0),
                last: `${mode}·${painted}件·部分提交`,
              }))
              if (groupName !== undefined && committed.scene !== work) {
                pushLog('info', `已自动编组「${groupName}」（整组移动/缩放/删除生效）`)
              }
              say(mode === 'plan' ? '画好啦' : '好了') // painted>0 → 含 create → 播完成语
              recordSuccess(utterance, [])
              if (mode === 'plan') suggestAfterPlan()
              return
            }

            // 一件都没画成（painted===0）→ 回退缓冲重解（此处 painted 必为 0，无已画内容可回滚）
            pushLog('warn', `流式路径未完成（${stream.ok ? '空结果' : stream.error}）→ 回退缓冲模式…`)
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
            if (res.source === 'llm-plan' && ok) suggestAfterPlan() // v1.7：创作完成给一条共创建议
          } finally {
            llmBusyRef.current = false
          }
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
    [clearSuggest, execOps, pushLog, recordSuccess, ruleCtx, say, suggestAfterPlan],
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

  // 场景持久化：每次场景变化写入 localStorage（只存场景，不存日志/语音/埋点等瞬态 UI），刷新后画面保留。
  // 写入入 try/catch（配额超限/SSR 等失败时静默放弃，等同无存档）。
  useEffect(() => {
    try {
      localStorage.setItem(SCENE_STORAGE_KEY, JSON.stringify(scene))
    } catch {
      // 忽略：配额满 / 隐私模式禁写 localStorage 时降级为不持久化
    }
  }, [scene])

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

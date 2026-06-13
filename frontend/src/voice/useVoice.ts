/**
 * 麦克风采集 + Silero VAD 断句 + 流式 ASR（协议 §4.1 LISTENING/PARSING 段）
 *
 * 音频通路：VAD 持有麦克风 → 说话期间逐帧推给 AsrProvider（句首回填 4 帧 ring buffer）
 * → 断句时 endSession → partial 驱动实时字幕，final 经 onUtterance 进理解通道（纠错 → 规则 → LLM）。
 * Provider 策略：默认走 backend 网关（火山引擎豆包/mock 由后端定）；网关 3 连败或不可恢复错误
 * 自动切 WebSpeech 兜底（协议 §3.1/§3.2）。
 */
import { useCallback, useRef, useState } from 'react'
import { GatewayAsr, WebSpeechAsr, type AsrEvents, type AsrProvider } from './asr'
import { transition, type VoiceEvent, type VoiceState } from './fsm'

export type VadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface Subtitle {
  text: string
  kind: 'partial' | 'final'
}

interface MicVadLike {
  start: () => void
  pause: () => void
}

export interface UseVoiceOptions {
  onLog: (level: 'info' | 'warn' | 'error', text: string) => void
  /** ASR final 文本回调（理解层入口，PR #12 起消费） */
  onUtterance?: (text: string, confidence: number, alternatives: string[]) => void
  /** ASR partial 回调（投机解析，协议 §4.1） */
  onPartial?: (text: string) => void
}

// 句首回填帧数（Silero v5 帧 32ms × 10 ≈ 320ms）。VAD 在语音真正起始之后才触发，
// 回填不足会吃掉首字／首音节导致识别不准——加宽到 ~320ms 把句首补回，与 preSpeechPadMs 对齐。
const RING_SIZE = 10
const FINAL_TIMEOUT_MS = 4000
const IDLE_SLEEP_MS = 120_000 // 常听无声 2 分钟自动休眠（降误触/省心；ASR 本就按段计费，休眠主要防长挂误触）

export function useVoice({ onLog, onUtterance, onPartial }: UseVoiceOptions) {
  const [state, setState] = useState<VoiceState>('idle')
  const [vadStatus, setVadStatus] = useState<VadStatus>('idle')
  const [providerName, setProviderName] = useState('gateway')
  const [subtitle, setSubtitle] = useState<Subtitle | null>(null)
  const [hearing, setHearing] = useState(false) // 当前是否正听到人声（onSpeechStart~End），供主控球实时反馈
  const [asleep, setAsleep] = useState(false) // 无声自动休眠（区别于用户主动静音），供 UI 文案

  const vadRef = useRef<MicVadLike | null>(null)
  const loadingRef = useRef(false) // VAD 初始化中，防自动启动 + 点击/StrictMode 重复建麦
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const providerRef = useRef<AsrProvider | null>(null)
  const speakingRef = useRef(false)
  const ttsActiveRef = useRef(false) // 半双工互斥：TTS 播报期间丢弃麦克风帧（防自激）
  const ringRef = useRef<Float32Array[]>([])
  const finalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const subtitleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const dispatch = useCallback(
    (e: VoiceEvent) => {
      const next = transition(stateRef.current, e)
      if (next === null) return
      stateRef.current = next
      setState(next)
    },
    [],
  )

  const showSubtitle = useCallback((s: Subtitle) => {
    if (subtitleTimerRef.current) clearTimeout(subtitleTimerRef.current)
    setSubtitle(s)
    if (s.kind === 'final') {
      subtitleTimerRef.current = setTimeout(() => setSubtitle(null), 2500)
    }
  }, [])

  /** 兜底收尾（final 超时/空转写/ASR 错误）：无播报内容，直接走完状态环 */
  const finishTurn = useCallback(() => {
    if (stateRef.current === 'parsing') {
      dispatch('PARSE_FAIL')
      dispatch('TTS_END')
    }
  }, [dispatch])

  /** 无声休眠计时：常听期间 IDLE_SLEEP_MS 无人声 → 暂停 VAD（仅在真正空闲态触发；处理中跳过本次） */
  const armIdle = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null
      if (stateRef.current !== 'listening') return // 解析/播报中：本次不休眠，下次开口会重置计时
      vadRef.current?.pause()
      speakingRef.current = false
      setHearing(false)
      setAsleep(true)
      setSubtitle(null)
      dispatch('STOP_LISTEN')
      onLog('info', '长时间无声，已自动休眠麦克风（点麦克风唤醒）')
    }, IDLE_SLEEP_MS)
  }, [dispatch, onLog])

  /** TTS 编排回调：播报开始/结束切换拾音门控（协议 §3 半双工约束） */
  const setTtsActive = useCallback((active: boolean) => {
    ttsActiveRef.current = active
    if (active) {
      // 播报开始时若正处说话段，丢弃该段（混入了扬声器声音）
      speakingRef.current = false
      setHearing(false)
      ringRef.current = []
    }
  }, [])

  const buildEvents = useCallback((): AsrEvents => {
    return {
      onPartial: (text) => {
        if (text.trim()) {
          showSubtitle({ text, kind: 'partial' })
          onPartial?.(text)
        }
      },
      onFinal: (r) => {
        if (finalTimerRef.current) clearTimeout(finalTimerRef.current)
        if (r.text.trim()) {
          showSubtitle({ text: r.text, kind: 'final' })
          onLog('info', `📝 转写：「${r.text}」（置信度 ${r.confidence.toFixed(2)}）`)
          // 后续状态环（PARSE_DONE/EXEC_DONE/TTS_END）由理解层经 dispatch 驱动
          onUtterance?.(r.text, r.confidence, r.alternatives)
        } else {
          finishTurn()
        }
      },
      onError: (code, recoverable) => {
        onLog(recoverable ? 'warn' : 'error', `ASR 错误：${code}${recoverable ? '' : '（不可恢复）'}`)
        if (!recoverable && providerRef.current?.name === 'gateway') {
          providerRef.current.dispose()
          const fallback = new WebSpeechAsr(buildEvents())
          providerRef.current = fallback
          setProviderName(fallback.name)
          onLog('warn', '已切换 WebSpeech 兜底识别')
          fallback.startSession()
        }
        if (stateRef.current === 'parsing') finishTurn()
      },
      onLog,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onLog, onUtterance, onPartial, showSubtitle, finishTurn])

  const ensureProvider = useCallback((): AsrProvider => {
    if (!providerRef.current) {
      const url = `ws://${location.hostname}:8787/asr`
      providerRef.current = new GatewayAsr(url, buildEvents())
      setProviderName(providerRef.current.name)
    }
    return providerRef.current
  }, [buildEvents])

  const start = useCallback(async () => {
    ensureProvider()
    if (vadRef.current) {
      vadRef.current.start()
      setAsleep(false)
      dispatch('START_LISTEN')
      armIdle()
      return
    }
    if (loadingRef.current) return // 初始化进行中，忽略重复启动（自动启动 + StrictMode/点击）
    loadingRef.current = true
    setVadStatus('loading')
    onLog('info', '加载 Silero VAD（本地 WASM）…')
    try {
      const { MicVAD } = await import('@ricky0123/vad-web')
      const vad = await MicVAD.new({
        baseAssetPath: '/vad/',
        onnxWASMBasePath: '/vad/',
        model: 'v5',
        // 协议 §3.2：静音 ~1s 切段。原 512ms 太激进——编辑长句（"把左边那只眼睛…变大一点"）
        // 中间自然停顿就被切断、转写残缺 → 看着像"听不懂"。放宽到 ~1s 容忍句中停顿、等用户说完。
        redemptionMs: 1000,
        minSpeechMs: 96,
        preSpeechPadMs: 320, // 句首留白，配合 RING_SIZE 回填，避免首字被吃
        onSpeechStart: () => {
          if (ttsActiveRef.current) return // 半双工：播报期间不开识别会话
          speakingRef.current = true
          setHearing(true)
          armIdle() // 有人声 → 重置无声休眠计时
          const p = ensureProvider()
          p.startSession()
          for (const f of ringRef.current) p.pushAudio(f) // 句首回填
          ringRef.current = []
          onLog('info', '🎤 检测到语音…')
        },
        onFrameProcessed: (_probs: unknown, frame: Float32Array) => {
          if (ttsActiveRef.current) return // 半双工：丢弃播报期间的帧
          if (speakingRef.current) {
            providerRef.current?.pushAudio(frame)
          } else {
            ringRef.current.push(frame)
            if (ringRef.current.length > RING_SIZE) ringRef.current.shift()
          }
        },
        onSpeechEnd: (audio: Float32Array) => {
          if (!speakingRef.current) return // 播报门控丢弃的段，不进解析
          speakingRef.current = false
          setHearing(false)
          const ms = Math.round(audio.length / 16)
          onLog('info', `🎤 断句：${ms}ms，等待转写…`)
          providerRef.current?.endSession()
          dispatch('SEGMENT_END')
          if (finalTimerRef.current) clearTimeout(finalTimerRef.current)
          finalTimerRef.current = setTimeout(() => {
            onLog('warn', 'ASR final 超时（4s）')
            finishTurn()
          }, FINAL_TIMEOUT_MS)
        },
        onVADMisfire: () => {
          speakingRef.current = false
          setHearing(false)
          providerRef.current?.endSession()
          onLog('warn', 'VAD 误触发（语音过短，已丢弃）')
        },
      })
      vadRef.current = vad
      vad.start()
      setVadStatus('ready')
      setAsleep(false)
      dispatch('START_LISTEN')
      armIdle()
      onLog('info', '已开启常听：随时开口自动识别，停顿约 500ms 自动断句')
    } catch (e) {
      setVadStatus('error')
      const msg = (e as Error)?.message ?? String(e)
      onLog(
        'error',
        msg.includes('Permission') || msg.includes('NotAllowed')
          ? '麦克风权限被拒绝：请在浏览器地址栏允许麦克风后，点麦克风重试'
          : `VAD 初始化失败：${msg}`,
      )
    } finally {
      loadingRef.current = false
    }
  }, [armIdle, dispatch, ensureProvider, finishTurn, onLog])

  const stop = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    vadRef.current?.pause()
    speakingRef.current = false
    setHearing(false)
    setAsleep(false) // 主动静音，非休眠
    setSubtitle(null)
    dispatch('STOP_LISTEN')
    onLog('info', '已静音（点麦克风恢复常听）')
  }, [dispatch, onLog])

  /** 回调中取当前状态（React state 闭包滞后，FSM 决策须用 ref） */
  const getState = useCallback(() => stateRef.current, [])

  return { state, vadStatus, providerName, subtitle, hearing, asleep, start, stop, dispatch, setTtsActive, getState }
}

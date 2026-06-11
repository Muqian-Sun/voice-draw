/**
 * 麦克风采集 + Silero VAD 断句 + 流式 ASR（协议 §4.1 LISTENING/PARSING 段）
 *
 * 音频通路：VAD 持有麦克风 → 说话期间逐帧推给 AsrProvider（句首回填 4 帧 ring buffer）
 * → 断句时 endSession → partial 驱动实时字幕，final 经 onUtterance 进理解通道（纠错 → 规则 → LLM）。
 * Provider 策略：默认走 backend 网关（七牛/mock 由后端定）；网关 3 连败或不可恢复错误
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
}

const RING_SIZE = 4 // 句首回填帧数（约 128ms，与 VAD preSpeechPadMs 对齐）
const FINAL_TIMEOUT_MS = 4000

export function useVoice({ onLog, onUtterance }: UseVoiceOptions) {
  const [state, setState] = useState<VoiceState>('idle')
  const [vadStatus, setVadStatus] = useState<VadStatus>('idle')
  const [providerName, setProviderName] = useState('gateway')
  const [subtitle, setSubtitle] = useState<Subtitle | null>(null)

  const vadRef = useRef<MicVadLike | null>(null)
  const providerRef = useRef<AsrProvider | null>(null)
  const speakingRef = useRef(false)
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

  /** PR #12/#13 前的 stub：final 后走播报占位回到聆听，保持状态机循环 */
  const finishTurn = useCallback(() => {
    if (stateRef.current === 'parsing') {
      dispatch('PARSE_FAIL')
      dispatch('TTS_END')
    }
  }, [dispatch])

  const buildEvents = useCallback((): AsrEvents => {
    return {
      onPartial: (text) => {
        if (text.trim()) showSubtitle({ text, kind: 'partial' })
      },
      onFinal: (r) => {
        if (finalTimerRef.current) clearTimeout(finalTimerRef.current)
        if (r.text.trim()) {
          showSubtitle({ text: r.text, kind: 'final' })
          onLog('info', `📝 转写：「${r.text}」（置信度 ${r.confidence.toFixed(2)}）`)
          onUtterance?.(r.text, r.confidence, r.alternatives)
        }
        finishTurn()
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
  }, [onLog, onUtterance, showSubtitle, finishTurn])

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
      dispatch('START_LISTEN')
      return
    }
    setVadStatus('loading')
    onLog('info', '加载 Silero VAD（本地 WASM）…')
    try {
      const { MicVAD } = await import('@ricky0123/vad-web')
      const vad = await MicVAD.new({
        baseAssetPath: '/vad/',
        onnxWASMBasePath: '/vad/',
        model: 'v5',
        // 协议 §3.2：静音 ~500ms 切段
        redemptionMs: 512,
        minSpeechMs: 96,
        preSpeechPadMs: 128,
        onSpeechStart: () => {
          speakingRef.current = true
          const p = ensureProvider()
          p.startSession()
          for (const f of ringRef.current) p.pushAudio(f) // 句首回填
          ringRef.current = []
          onLog('info', '🎤 检测到语音…')
        },
        onFrameProcessed: (_probs: unknown, frame: Float32Array) => {
          if (speakingRef.current) {
            providerRef.current?.pushAudio(frame)
          } else {
            ringRef.current.push(frame)
            if (ringRef.current.length > RING_SIZE) ringRef.current.shift()
          }
        },
        onSpeechEnd: (audio: Float32Array) => {
          speakingRef.current = false
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
          providerRef.current?.endSession()
          onLog('warn', 'VAD 误触发（语音过短，已丢弃）')
        },
      })
      vadRef.current = vad
      vad.start()
      setVadStatus('ready')
      dispatch('START_LISTEN')
      onLog('info', 'VAD 就绪，开始聆听（约 500ms 静音自动断句）')
    } catch (e) {
      setVadStatus('error')
      const msg = (e as Error)?.message ?? String(e)
      onLog(
        'error',
        msg.includes('Permission') || msg.includes('NotAllowed')
          ? '麦克风权限被拒绝：请在浏览器地址栏允许麦克风后重试'
          : `VAD 初始化失败：${msg}`,
      )
    }
  }, [dispatch, ensureProvider, finishTurn, onLog])

  const stop = useCallback(() => {
    vadRef.current?.pause()
    speakingRef.current = false
    setSubtitle(null)
    dispatch('STOP_LISTEN')
    onLog('info', '已停止聆听')
  }, [dispatch, onLog])

  return { state, vadStatus, providerName, subtitle, start, stop }
}

/**
 * 麦克风采集 + Silero VAD 断句（协议 §4.1 LISTENING 段）
 *
 * - MicVAD 懒加载（动态 import + WASM），不进首屏 bundle
 * - VAD 参数对齐协议：~500ms 静音切段（16 帧 × 32ms redemption）
 * - 断句后驱动主状态机走 stub 反馈回路（parsing → speaking → listening）；
 *   ASR 转写随计划 PR #9 接入，届时 onSegment/onFrame 直接对接 ws 网关
 */
import { useCallback, useRef, useState } from 'react'
import { transition, type VoiceEvent, type VoiceState } from './fsm'

export type VadStatus = 'idle' | 'loading' | 'ready' | 'error'

interface MicVadLike {
  start: () => void
  pause: () => void
  destroy: () => void
}

export interface UseVoiceOptions {
  onLog: (level: 'info' | 'warn' | 'error', text: string) => void
  /** VAD 完整语音段（16kHz Float32），PR #9 起送 ASR */
  onSegment?: (audio: Float32Array) => void
}

export function useVoice({ onLog, onSegment }: UseVoiceOptions) {
  const [state, setState] = useState<VoiceState>('idle')
  const [vadStatus, setVadStatus] = useState<VadStatus>('idle')
  const vadRef = useRef<MicVadLike | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const dispatch = useCallback(
    (e: VoiceEvent) => {
      const next = transition(stateRef.current, e)
      if (next === null) {
        onLog('warn', `状态机：忽略非法转移 ${stateRef.current} --${e}`)
        return
      }
      stateRef.current = next
      setState(next)
    },
    [onLog],
  )

  /** PR #9 前的 stub 回路：断句 → 解析占位 → 播报占位 → 回聆听，验证状态机全程可走 */
  const runStubPipeline = useCallback(
    (durationMs: number) => {
      dispatch('SEGMENT_END') // listening → parsing
      onLog('info', `🎤 断句：${durationMs}ms 语音段（ASR 转写随 PR #9 接入）`)
      dispatch('PARSE_FAIL') // parsing → speaking（无理解层，走失败播报路径）
      onLog('info', '🔊 TTS 反馈待接入（PR #15），跳过播报')
      dispatch('TTS_END') // speaking → listening
    },
    [dispatch, onLog],
  )

  const start = useCallback(async () => {
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
        // 协议 §3.2：静音 ~500ms 切段（v5 帧 512 样本 ≈ 32ms × 16）
        redemptionMs: 512,
        minSpeechMs: 96, // 过滤 <100ms 的噪声触发
        preSpeechPadMs: 128, // 句首回填，避免吃掉第一个字
        onSpeechStart: () => onLog('info', '🎤 检测到语音…'),
        onSpeechEnd: (audio: Float32Array) => {
          const ms = Math.round(audio.length / 16) // 16 样本/ms @16kHz
          onSegment?.(audio)
          runStubPipeline(ms)
        },
        onVADMisfire: () => onLog('warn', 'VAD 误触发（语音过短，已丢弃）'),
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
  }, [dispatch, onLog, onSegment, runStubPipeline])

  const stop = useCallback(() => {
    vadRef.current?.pause()
    dispatch('STOP_LISTEN')
    onLog('info', '已停止聆听')
  }, [dispatch, onLog])

  return { state, vadStatus, start, stop }
}

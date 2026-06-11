/**
 * ASR 上游抽象：代理对上游云厂商的最小接口。
 * 实现：VolcAsrUpstream（火山引擎豆包流式 ASR，配置密钥后启用）；
 *       MockAsrUpstream（无密钥兜底，保证协议链路可跑通可演示）。
 */
import { MockAsrUpstream } from './mock.js'
import { isVolcConfigured, VolcAsrUpstream } from './volc.js'

export interface AsrUpstreamEvents {
  onPartial: (text: string) => void
  onFinal: (r: { text: string; confidence: number; alternatives: string[] }) => void
  onError: (code: 'UPSTREAM_DISCONNECT' | 'UPSTREAM_ERROR', recoverable: boolean) => void
}

export interface AsrUpstream {
  /** 推送一帧 16kHz/16bit/mono PCM 音频 */
  sendAudio(pcm: Buffer): void
  /** 句尾：要求上游产出 final */
  stop(): void
  /** 释放连接（客户端断开时） */
  close(): void
}

export type UpstreamFactory = (events: AsrUpstreamEvents) => AsrUpstream

export function createUpstreamFactory(): UpstreamFactory {
  if (isVolcConfigured()) {
    console.log('[asr] 上游：火山引擎豆包流式 ASR')
    return (events) => new VolcAsrUpstream(events)
  }
  console.log('[asr] 上游：mock（未配置 VOLC_API_KEY，final 文本取 MOCK_ASR_FINAL）')
  return (events) => new MockAsrUpstream(events)
}

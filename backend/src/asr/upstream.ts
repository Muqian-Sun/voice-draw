/**
 * ASR 上游抽象：代理对上游云厂商的最小接口。
 * 实现：MockAsrUpstream（本 PR，无密钥跑通协议链路）；QiniuAsrUpstream（计划 PR #9）。
 */
import { MockAsrUpstream } from './mock.js'

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
  if (process.env.QINIU_API_KEY) {
    // 七牛云流式 ASR 上游随计划 PR #9 接入；当前即使有密钥也先走 mock
    console.warn('[asr] QINIU_API_KEY 已配置，但七牛上游将在后续 PR 接入，当前使用 mock 上游')
  }
  return (events) => new MockAsrUpstream(events)
}

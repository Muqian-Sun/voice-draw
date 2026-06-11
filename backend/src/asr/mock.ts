/**
 * Mock ASR 上游：无七牛密钥时保证语音协议链路可跑通、可演示（协议 §3.2 mock 模式）。
 *
 * 行为：每收 15 帧（约 300ms 语音）吐出 final 文本的递增前缀作为 partial（驱动字幕 UI）；
 * stop 后约 120ms 吐出 final（模拟上游收尾延迟）。
 * final 文本经 MOCK_ASR_FINAL 配置，缺省「画一个圆」——规则层接入后无密钥也能全链路画图。
 */
import type { AsrUpstream, AsrUpstreamEvents } from './upstream.js'

const PARTIAL_EVERY_N_FRAMES = 15
const FINAL_DELAY_MS = 120

export class MockAsrUpstream implements AsrUpstream {
  private frames = 0
  private closed = false
  private readonly finalText: string

  constructor(private readonly events: AsrUpstreamEvents) {
    this.finalText = process.env.MOCK_ASR_FINAL ?? '画一个圆'
  }

  sendAudio(_pcm: Buffer): void {
    if (this.closed) return
    this.frames++
    if (this.frames % PARTIAL_EVERY_N_FRAMES === 0) {
      const len = Math.min(this.frames / PARTIAL_EVERY_N_FRAMES, this.finalText.length)
      this.events.onPartial(this.finalText.slice(0, len))
    }
  }

  stop(): void {
    if (this.closed) return
    setTimeout(() => {
      if (this.closed) return
      this.events.onFinal({ text: this.finalText, confidence: 0.95, alternatives: [] })
    }, FINAL_DELAY_MS)
  }

  close(): void {
    this.closed = true
  }
}

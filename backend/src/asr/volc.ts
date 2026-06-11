/**
 * 火山引擎豆包流式 ASR 上游（双向流式优化版 bigmodel_async）
 *
 * 会话生命周期与网关对齐：每个 start（VAD 语音开始）新建一条连接，
 * stop（VAD 断句）发最后一包，收到末包响应回 final 后连接由服务端关闭。
 * 音频帧聚合到 ~200ms 再发（官方建议单包 100~200ms，优化版 200ms 最优）。
 *
 * 鉴权：新版控制台 X-Api-Key（VOLC_API_KEY）或旧版 X-Api-App-Key + X-Api-Access-Key。
 * 注意：火山响应不含置信度与 n-best 候选，confidence 取估值 0.9、alternatives 为空
 * （纠错层有拼音回退路径，协议字段语义不变）。
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { AsrUpstream, AsrUpstreamEvents } from './upstream.js'
import { decodeServerMessage, encodeAudioPacket, encodeFullClientRequest } from './volc-codec.js'

const DEFAULT_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
/** 200ms @ 16kHz/16bit/mono */
const CHUNK_BYTES = 6400

export function isVolcConfigured(): boolean {
  return Boolean(process.env.VOLC_API_KEY || (process.env.VOLC_APP_KEY && process.env.VOLC_ACCESS_KEY))
}

function buildConfig() {
  return {
    user: { uid: 'voice-draw' },
    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel',
      enable_punc: true,
      enable_itn: true,
      result_type: 'full',
      ...(process.env.VOLC_ASR_ENABLE_NONSTREAM === 'true' ? { enable_nonstream: true } : {}),
    },
  }
}

export class VolcAsrUpstream implements AsrUpstream {
  private readonly ws: WebSocket
  private chunks: Buffer[] = []
  private chunkBytes = 0
  private opened = false
  private stopRequested = false
  private done = false // 已回 final 或已出错，后续 close 不再报错
  private closedByUs = false
  private readonly pending: Buffer[] = [] // 建连完成前积压的待发帧

  constructor(private readonly events: AsrUpstreamEvents) {
    const headers: Record<string, string> = {
      'X-Api-Resource-Id': process.env.VOLC_ASR_RESOURCE_ID ?? 'volc.bigasr.sauc.duration',
      'X-Api-Connect-Id': randomUUID(),
      'X-Api-Request-Id': randomUUID(),
      'X-Api-Sequence': '-1',
    }
    if (process.env.VOLC_API_KEY) headers['X-Api-Key'] = process.env.VOLC_API_KEY
    if (process.env.VOLC_APP_KEY) headers['X-Api-App-Key'] = process.env.VOLC_APP_KEY
    if (process.env.VOLC_ACCESS_KEY) headers['X-Api-Access-Key'] = process.env.VOLC_ACCESS_KEY

    this.ws = new WebSocket(process.env.VOLC_ASR_WS_URL ?? DEFAULT_URL, { headers })

    this.ws.on('open', () => {
      this.ws.send(encodeFullClientRequest(buildConfig()))
      this.opened = true
      for (const p of this.pending) this.ws.send(p)
      this.pending.length = 0
      if (this.stopRequested) this.sendLast()
    })

    this.ws.on('message', (raw) => {
      try {
        const msg = decodeServerMessage(raw as Buffer)
        if (msg.kind === 'error') {
          this.done = true
          console.error(`[asr/volc] 上游错误 ${msg.code}: ${msg.message}`)
          this.events.onError('UPSTREAM_ERROR', true)
          return
        }
        const text = msg.payload.result?.text ?? ''
        if (msg.isLast) {
          this.done = true
          this.events.onFinal({ text, confidence: 0.9, alternatives: [] })
        } else if (text) {
          this.events.onPartial(text)
        }
      } catch (e) {
        console.error('[asr/volc] 响应解析失败', e)
      }
    })

    this.ws.on('error', (e) => {
      if (this.done) return
      console.error('[asr/volc] 连接错误', (e as Error).message)
    })

    this.ws.on('close', (code) => {
      if (this.done || this.closedByUs) return
      this.done = true
      console.error(`[asr/volc] 连接意外关闭 code=${code}`)
      this.events.onError('UPSTREAM_DISCONNECT', true)
    })
  }

  private sendOrQueue(packet: Buffer) {
    if (this.opened && this.ws.readyState === WebSocket.OPEN) this.ws.send(packet)
    else this.pending.push(packet)
  }

  private flushChunk(isLast: boolean) {
    const pcm = this.chunks.length > 0 ? Buffer.concat(this.chunks) : Buffer.alloc(0)
    this.chunks = []
    this.chunkBytes = 0
    if (pcm.length > 0 || isLast) this.sendOrQueue(encodeAudioPacket(pcm, isLast))
  }

  sendAudio(pcm: Buffer): void {
    if (this.stopRequested) return
    this.chunks.push(pcm)
    this.chunkBytes += pcm.length
    if (this.chunkBytes >= CHUNK_BYTES) this.flushChunk(false)
  }

  private sendLast() {
    this.flushChunk(true)
  }

  stop(): void {
    if (this.stopRequested) return
    this.stopRequested = true
    if (this.opened) this.sendLast()
    // 未 open 时由 open 回调补发（pending 顺序已保证音频在前）
  }

  close(): void {
    this.closedByUs = true
    this.ws.close()
  }
}

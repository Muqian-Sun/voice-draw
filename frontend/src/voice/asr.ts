/**
 * ASR Provider 抽象（协议 §3.1）
 *
 * 会话模型：VAD 持有唯一音频管线并负责断句，Provider 只消费——
 *   onSpeechStart → startSession()；逐帧 pushAudio()；onSpeechEnd → endSession() → 等 final。
 * 实现：
 * - GatewayAsr：走 backend ws 网关（协议 §3.2），上游为火山引擎豆包/mock 由 backend 决定
 * - WebSpeechAsr：浏览器内建识别兜底（自行采音，pushAudio/endSession 为空操作）
 */
import { float32ToPcm16Base64 } from './pcm'

export interface AsrFinal {
  text: string
  confidence: number
  alternatives: string[]
}

export interface AsrEvents {
  onPartial: (text: string) => void
  onFinal: (r: AsrFinal) => void
  /** recoverable=false 表示该 Provider 不可用，上层应切换兜底 */
  onError: (code: string, recoverable: boolean) => void
  onLog: (level: 'info' | 'warn' | 'error', text: string) => void
}

export interface AsrProvider {
  readonly name: string
  startSession(): void
  pushAudio(frame: Float32Array): void
  endSession(): void
  dispose(): void
}

// ---------- 网关实现（协议 §3.2 客户端） ----------

const RECONNECT_DELAYS_MS = [500, 1000, 2000] // 协议 §3.2 指数退避
const MAX_QUEUED = 256

export class GatewayAsr implements AsrProvider {
  readonly name = 'gateway'
  private ws: WebSocket | null = null
  private seq = 0
  private failures = 0
  private queue: string[] = []
  private disposed = false

  constructor(
    private readonly url: string,
    private readonly events: AsrEvents,
  ) {}

  private connect() {
    if (this.disposed || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => {
      this.failures = 0
      for (const m of this.queue) ws.send(m)
      this.queue = []
    }
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      if (m.type === 'partial') this.events.onPartial(m.text)
      else if (m.type === 'final') this.events.onFinal({ text: m.text, confidence: m.confidence, alternatives: m.alternatives })
      else if (m.type === 'error') this.events.onError(m.code, m.recoverable)
    }
    ws.onclose = () => {
      if (this.disposed) return
      this.ws = null
      const delay = RECONNECT_DELAYS_MS[this.failures]
      this.failures++
      if (delay === undefined) {
        // 3 次失败：判定网关不可用，触发兜底切换（协议 §3.2）
        this.events.onError('GATEWAY_UNAVAILABLE', false)
        return
      }
      this.events.onLog('warn', `ASR 网关连接断开，${delay}ms 后重连（第 ${this.failures} 次）`)
      setTimeout(() => this.connect(), delay)
    }
  }

  private send(m: object) {
    const data = JSON.stringify(m)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data)
    } else {
      if (this.queue.length < MAX_QUEUED) this.queue.push(data)
      this.connect()
    }
  }

  startSession() {
    this.seq = 0
    this.send({ type: 'start', format: 'pcm16', sampleRate: 16000, lang: 'zh' })
  }

  pushAudio(frame: Float32Array) {
    this.send({ type: 'audio', seq: this.seq++, data: float32ToPcm16Base64(frame) })
  }

  endSession() {
    this.send({ type: 'stop' })
  }

  dispose() {
    this.disposed = true
    this.ws?.close()
    this.ws = null
  }
}

// ---------- WebSpeech 兜底 ----------

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string; confidence: number } }>
}

export class WebSpeechAsr implements AsrProvider {
  readonly name = 'webspeech'
  private rec: SpeechRecognitionLike | null = null
  private running = false

  constructor(private readonly events: AsrEvents) {}

  startSession() {
    if (this.running) return // 常开模式：WebSpeech 自带 VAD 与断句
    const w = window as unknown as Record<string, undefined | (new () => SpeechRecognitionLike)>
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor) {
      this.events.onError('WEBSPEECH_UNAVAILABLE', false)
      return
    }
    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) {
          this.events.onFinal({ text: r[0].transcript.trim(), confidence: r[0].confidence || 0.8, alternatives: [] })
        } else {
          this.events.onPartial(r[0].transcript)
        }
      }
    }
    rec.onerror = (e) => {
      // no-speech/aborted 属正常波动；权限/网络错误判不可恢复
      const fatal = e.error === 'not-allowed' || e.error === 'service-not-allowed'
      if (e.error !== 'no-speech' && e.error !== 'aborted') this.events.onError(`WEBSPEECH_${e.error}`, !fatal)
    }
    rec.onend = () => {
      if (this.running) rec.start() // 保持常开
    }
    rec.start()
    this.rec = rec
    this.running = true
    this.events.onLog('info', 'WebSpeech 兜底已启动（浏览器内建识别，断句由浏览器接管）')
  }

  pushAudio(_frame: Float32Array) {
    // WebSpeech 自行采音
  }

  endSession() {
    // WebSpeech 自带断句
  }

  dispose() {
    this.running = false
    this.rec?.stop()
    this.rec = null
  }
}

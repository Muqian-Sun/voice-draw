/**
 * TTS 反馈编排（协议 §3 / §4.1 speaking 段）
 *
 * Provider 抽象：GatewayTts（backend /api/tts，豆包语音合成 1.0）→ 失败自动降级
 * WebSpeechTts（浏览器本地）。编排器串行播队列（后到的等前一条播完），
 * onSpeakingChange 供半双工互斥（播报期间丢弃麦克风帧）与 FSM TTS_END 驱动。
 * 网关连续 2 次失败后本会话固定走 WebSpeech（与 ASR 兜底策略对齐）。
 */

export interface TtsProvider {
  readonly name: string
  /** 播完（或被 cancel）后 resolve；不可用/失败时 reject */
  speak(text: string): Promise<void>
  cancel(): void
}

export class GatewayTts implements TtsProvider {
  readonly name = 'gateway'
  private audio: HTMLAudioElement | null = null

  constructor(private readonly baseUrl: string) {}

  /**
   * 渐进播放：直接把 GET /api/tts?text= 交给 <audio> 元素，浏览器边下边播（分块 mp3），
   * 首块到达即开声——不再等整段合成+下载完成。出错（含 503 未配置）触发 onerror → reject，
   * 由编排器降级 speechSynthesis。文案为机器播报短句，置于 query 无隐私问题。
   */
  speak(text: string): Promise<void> {
    const url = `${this.baseUrl}/api/tts?text=${encodeURIComponent(text)}`
    return new Promise<void>((resolve, reject) => {
      const audio = new Audio()
      this.audio = audio
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        if (this.audio === audio) this.audio = null
        fn()
      }
      audio.onended = () => finish(resolve)
      audio.onpause = () => finish(resolve) // cancel() 走 pause，视为播放结束
      audio.onerror = () => finish(() => reject(new Error('TTS 网关播放失败（降级兜底）')))
      audio.src = url
      void audio.play().catch((e) => finish(() => reject(e instanceof Error ? e : new Error('音频播放失败'))))
    })
  }

  cancel(): void {
    this.audio?.pause() // 触发 onpause → resolve；短句残余流极小，不强行 load() 以免误触 onerror
    this.audio = null
  }
}

export class WebSpeechTts implements TtsProvider {
  readonly name = 'webspeech'

  speak(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window)) {
        reject(new Error('浏览器不支持 speechSynthesis'))
        return
      }
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'zh-CN'
      u.pitch = 1.4 // 调高音调 → 无密钥兜底时也偏可爱（与豆包樱桃丸子音色风格对齐）
      u.rate = 1.05
      u.onend = () => resolve()
      // cancel() 触发 error 事件（interrupted），同样视为本条结束
      u.onerror = () => resolve()
      window.speechSynthesis.speak(u)
    })
  }

  cancel(): void {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  }
}

export interface TtsOrchestratorOptions {
  onLog?: (level: 'info' | 'warn', text: string) => void
  /** 半双工互斥 + FSM 驱动：true=开始播报（暂停拾音），false=队列播空（TTS_END） */
  onSpeakingChange?: (speaking: boolean) => void
  /** 网关连续失败多少次后固定走兜底 */
  maxGatewayFailures?: number
}

interface QueueItem {
  text: string
  resolve: () => void
}

export class TtsOrchestrator {
  private queue: QueueItem[] = []
  private playing = false
  private gatewayFailures = 0
  private stuckToFallback = false

  constructor(
    private readonly gateway: TtsProvider,
    private readonly fallback: TtsProvider,
    private readonly opts: TtsOrchestratorOptions = {},
  ) {}

  get providerName(): string {
    return this.stuckToFallback ? this.fallback.name : this.gateway.name
  }

  /** 入队播报；串行播放，返回的 Promise 在该条播完（或被取消/失败）后 resolve */
  speak(text: string): Promise<void> {
    const trimmed = text.trim()
    if (trimmed.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.queue.push({ text: trimmed, resolve })
      void this.drain()
    })
  }

  /** 清空队列并打断当前播报 */
  cancelAll(): void {
    const dropped = this.queue.splice(0)
    dropped.forEach((i) => i.resolve())
    this.gateway.cancel()
    this.fallback.cancel()
  }

  private async drain(): Promise<void> {
    if (this.playing) return
    this.playing = true
    this.opts.onSpeakingChange?.(true)
    try {
      for (;;) {
        const item = this.queue.shift()
        if (item === undefined) break
        await this.speakOne(item.text)
        item.resolve()
      }
    } finally {
      this.playing = false
      this.opts.onSpeakingChange?.(false)
    }
  }

  private async speakOne(text: string): Promise<void> {
    const max = this.opts.maxGatewayFailures ?? 2
    if (!this.stuckToFallback) {
      try {
        await this.gateway.speak(text)
        this.gatewayFailures = 0
        return
      } catch (e) {
        this.gatewayFailures += 1
        this.opts.onLog?.('warn', `TTS 网关失败（${this.gatewayFailures}/${max}）：${(e as Error).message}`)
        if (this.gatewayFailures >= max) {
          this.stuckToFallback = true
          this.opts.onLog?.('warn', '已切换 speechSynthesis 兜底播报')
        }
      }
    }
    try {
      await this.fallback.speak(text)
    } catch (e) {
      this.opts.onLog?.('warn', `TTS 兜底也失败：${(e as Error).message}`)
    }
  }
}

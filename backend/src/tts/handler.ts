/**
 * TTS 转发（协议 §3）：火山引擎豆包大模型语音合成 2.0（v3 unidirectional）。
 *
 * POST /api/tts { text } → audio/mpeg（mp3 字节流）
 *
 * 选型记录：原计划语音合成 1.0，实测账号授权的是 2.0 资源
 * （volc.service_type.10029；1.0 的 volc.tts.default 返回 3001 not granted），
 * 凭证同为 语音技术控制台应用的 APPID + Access Token，鉴权走 X-Api-* 头。
 * 上游响应是 JSON-lines 流：若干 {code:0,data:<base64>} 音频块 + 句元数据行
 * + 结束行 {code:20000000}。未配置 → 503，前端降级 speechSynthesis。
 */
import type { Request, Response } from 'express'
import { z } from 'zod'

const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const RESOURCE_ID = 'volc.service_type.10029'
const DEFAULT_SPEAKER = 'zh_female_cancan_mars_bigtts' // 灿灿
/** 播报文案 ≤20 字（协议 §2.3），上限放宽到 80 防御异常输入 */
const MAX_TEXT_LEN = 80
const TIMEOUT_MS = 10_000
const END_CODE = 20000000

const requestSchema = z.object({ text: z.string().min(1).max(MAX_TEXT_LEN) }).strict()

export interface TtsConfig {
  appid: string
  token: string
  speaker: string
}

export function readTtsConfig(): TtsConfig | null {
  const appid = process.env.VOLC_TTS_APPID
  const token = process.env.VOLC_TTS_TOKEN
  if (!appid || !token) return null
  return { appid, token, speaker: process.env.VOLC_TTS_SPEAKER || DEFAULT_SPEAKER }
}

export function isTtsConfigured(): boolean {
  return readTtsConfig() !== null
}

/** v3 unidirectional 请求体 */
export function buildTtsRequest(text: string, cfg: TtsConfig) {
  return {
    user: { uid: 'voice-draw' },
    req_params: {
      text,
      speaker: cfg.speaker,
      audio_params: { format: 'mp3', sample_rate: 24000 },
    },
  }
}

type TtsStreamLine = { code?: number; message?: string; data?: string | null }

/** 解析 JSON-lines 流：拼接音频块；遇到非 0/结束码视为上游错误 */
export function parseTtsStream(body: string): { ok: true; audio: Buffer } | { ok: false; error: string } {
  const chunks: Buffer[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let json: TtsStreamLine
    try {
      json = JSON.parse(trimmed) as TtsStreamLine
    } catch {
      return { ok: false, error: `非法响应行：${trimmed.slice(0, 80)}` }
    }
    if (json.code === 0) {
      if (typeof json.data === 'string' && json.data.length > 0) {
        chunks.push(Buffer.from(json.data, 'base64'))
      }
      continue // data 为空的句元数据行跳过
    }
    if (json.code === END_CODE) break
    return { ok: false, error: `code=${json.code ?? '?'} ${json.message ?? '无返回信息'}` }
  }
  if (chunks.length === 0) return { ok: false, error: '上游未返回音频数据' }
  return { ok: true, audio: Buffer.concat(chunks) }
}

/** text 取自 GET ?text=（前端用 <audio src> 渐进播放）或 POST body.text（兼容旧契约/测试） */
function extractText(req: Request): unknown {
  if (typeof req.query.text === 'string') return req.query.text
  return (req.body as { text?: unknown } | undefined)?.text
}

/**
 * 增量转发上游 JSON-lines 流：每解析出一个音频块就立即 res.write 原始 mp3 字节（分块传输），
 * 前端 <audio> 收到首块即开播——播报延迟从「整段合成完」降到「首块到达」。
 * 首个音频块到达前仍可改用 JSON 报错（headers 未发）；之后只能中断 res.end()。
 */
async function streamTts(body: ReadableStream<Uint8Array>, res: Response): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let started = false

  // 处理一行；返回 false 表示流结束（END_CODE / 错误 / 非法行）
  const handleLine = (line: string): boolean => {
    const t = line.trim()
    if (t === '') return true
    let json: TtsStreamLine
    try {
      json = JSON.parse(t) as TtsStreamLine
    } catch {
      if (!started) res.status(502).json({ error: 'UPSTREAM_ERROR', message: `非法响应行：${t.slice(0, 80)}` })
      return false
    }
    if (json.code === 0) {
      if (typeof json.data === 'string' && json.data.length > 0) {
        if (!started) {
          res.setHeader('Content-Type', 'audio/mpeg')
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('X-Accel-Buffering', 'no') // 禁反向代理缓冲，保证分块即时下发
          started = true
        }
        res.write(Buffer.from(json.data, 'base64'))
      }
      return true // data 为空的句元数据行：继续
    }
    if (json.code === END_CODE) return false
    if (!started) res.status(502).json({ error: 'UPSTREAM_ERROR', message: `TTS 上游失败：code=${json.code ?? '?'} ${json.message ?? ''}` })
    return false
  }

  let ended = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!handleLine(line)) {
        ended = true
        break
      }
    }
    if (ended) break
  }
  if (!ended && buf.trim() !== '') handleLine(buf) // 末行可能无换行
  void reader.cancel().catch(() => {})

  if (started) res.end()
  else if (!res.headersSent) res.status(502).json({ error: 'UPSTREAM_ERROR', message: '上游未返回音频数据' })
}

export async function handleTts(req: Request, res: Response): Promise<void> {
  const parsed = requestSchema.safeParse({ text: extractText(req) })
  if (!parsed.success) {
    res.status(400).json({ error: 'BAD_REQUEST', message: 'text 必填且 ≤80 字' })
    return
  }
  const cfg = readTtsConfig()
  if (cfg === null) {
    res.status(503).json({ error: 'TTS_NOT_CONFIGURED', message: '未配置 VOLC_TTS_APPID/VOLC_TTS_TOKEN，前端请用 speechSynthesis 兜底' })
    return
  }
  try {
    const upstream = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-App-Id': cfg.appid,
        'X-Api-Access-Key': cfg.token,
        'X-Api-Resource-Id': RESOURCE_ID,
      },
      body: JSON.stringify(buildTtsRequest(parsed.data.text, cfg)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!upstream.ok || upstream.body === null) {
      const errBody = await upstream.text().catch(() => '')
      res.status(502).json({ error: 'UPSTREAM_ERROR', message: `TTS 上游 ${upstream.status}：${errBody.slice(0, 200)}` })
      return
    }
    await streamTts(upstream.body, res)
  } catch (e) {
    if (res.headersSent) {
      res.end()
      return
    }
    const timeout = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError'
    res.status(timeout ? 504 : 502).json({
      error: timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
      message: timeout ? `TTS 上游 ${TIMEOUT_MS / 1000}s 超时` : (e as Error).message,
    })
  }
}

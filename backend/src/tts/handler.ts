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

export async function handleTts(req: Request, res: Response): Promise<void> {
  const parsed = requestSchema.safeParse(req.body)
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
    const body = await upstream.text()
    if (!upstream.ok) {
      res.status(502).json({ error: 'UPSTREAM_ERROR', message: `TTS 上游 ${upstream.status}：${body.slice(0, 200)}` })
      return
    }
    const r = parseTtsStream(body)
    if (!r.ok) {
      res.status(502).json({ error: 'UPSTREAM_ERROR', message: `TTS 上游失败：${r.error}` })
      return
    }
    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Cache-Control', 'no-store')
    res.send(r.audio)
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError'
    res.status(timeout ? 504 : 502).json({
      error: timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
      message: timeout ? `TTS 上游 ${TIMEOUT_MS / 1000}s 超时` : (e as Error).message,
    })
  }
}

/**
 * TTS 转发（协议 §3）：火山引擎豆包语音合成 1.0（HTTP 非流式 query 模式）。
 *
 * POST /api/tts { text } → audio/mpeg（mp3 字节流）
 *
 * 选型：用户决策用语音合成 1.0（经典版）。鉴权为 appid + access token
 * （注意与 ASR 的 X-Api-Key 不是同一套；v1 的 Authorization 头是 "Bearer;{token}"，
 * 分号是官方协议的一部分不是笔误）。未配置 → 503，前端降级 speechSynthesis。
 */
import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import { z } from 'zod'

const TTS_URL = 'https://openspeech.bytedance.com/api/v1/tts'
const DEFAULT_VOICE = 'BV001_streaming' // 通用女声
const DEFAULT_CLUSTER = 'volcano_tts'
/** 播报文案 ≤20 字（协议 §2.3），上限放宽到 80 防御异常输入 */
const MAX_TEXT_LEN = 80
const TIMEOUT_MS = 10_000

const requestSchema = z.object({ text: z.string().min(1).max(MAX_TEXT_LEN) }).strict()

export interface TtsConfig {
  appid: string
  token: string
  voiceType: string
  cluster: string
  speedRatio: number
}

export function readTtsConfig(): TtsConfig | null {
  const appid = process.env.VOLC_TTS_APPID
  const token = process.env.VOLC_TTS_TOKEN
  if (!appid || !token) return null
  return {
    appid,
    token,
    voiceType: process.env.VOLC_TTS_VOICE_TYPE || DEFAULT_VOICE,
    cluster: process.env.VOLC_TTS_CLUSTER || DEFAULT_CLUSTER,
    speedRatio: Number(process.env.VOLC_TTS_SPEED || '1.0'),
  }
}

export function isTtsConfigured(): boolean {
  return readTtsConfig() !== null
}

/** v1 TTS 请求体（官方协议结构） */
export function buildTtsRequest(text: string, cfg: TtsConfig, reqid: string) {
  return {
    app: { appid: cfg.appid, token: cfg.token, cluster: cfg.cluster },
    user: { uid: 'voice-draw' },
    audio: { voice_type: cfg.voiceType, encoding: 'mp3', speed_ratio: cfg.speedRatio },
    request: { reqid, text, operation: 'query' },
  }
}

type TtsUpstreamResponse = { code?: number; message?: string; data?: string }

/** v1 成功码为 3000，data 为 base64 mp3 */
export function parseTtsResponse(json: TtsUpstreamResponse): { ok: true; audio: Buffer } | { ok: false; error: string } {
  if (json.code === 3000 && typeof json.data === 'string' && json.data.length > 0) {
    return { ok: true, audio: Buffer.from(json.data, 'base64') }
  }
  return { ok: false, error: `code=${json.code ?? '?'} ${json.message ?? '无返回信息'}` }
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
        Authorization: `Bearer;${cfg.token}`, // v1 协议格式：分号分隔
      },
      body: JSON.stringify(buildTtsRequest(parsed.data.text, cfg, randomUUID())),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const json = (await upstream.json().catch(() => ({}))) as TtsUpstreamResponse
    const r = parseTtsResponse(json)
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

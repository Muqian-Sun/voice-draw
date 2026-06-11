/**
 * ASR WebSocket 转发协议（docs/题目二-交互协议规范.md §3.2）
 * 客户端 → 代理：start / audio / stop；代理 → 客户端：ready / partial / final / error
 */
import { z } from 'zod'

export const clientMsgSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('start'),
      format: z.literal('pcm16'),
      sampleRate: z.literal(16000),
      lang: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('audio'),
      seq: z.number().int().nonnegative(),
      data: z.string().min(1), // base64 pcm16 20ms 帧
    })
    .strict(),
  z.object({ type: z.literal('stop') }).strict(),
])

export type ClientMsg = z.infer<typeof clientMsgSchema>

export type AsrErrorCode = 'BAD_MESSAGE' | 'NOT_STARTED' | 'UPSTREAM_DISCONNECT' | 'UPSTREAM_ERROR'

export type ServerMsg =
  | { type: 'ready' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string; confidence: number; alternatives: string[] }
  | { type: 'error'; code: AsrErrorCode; recoverable: boolean }

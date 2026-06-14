/**
 * LLM 转发（协议 §2）：密钥隔离代理，前端不接触上游与密钥。
 *
 * POST /api/llm/parse
 *   入参：{ utterance, mode, scene, asr_alternatives?, recent?, retry? }
 *   出参：{ content, latencyMs, firstTokenMs, model } ｜ { error, message }
 *
 * System Prompt 来自构建期生成的 prompt.generated.ts（运行期逐字节不变，
 * 命中上游 prompt cache）；所有变化信息进 user message（协议 §2.1）。
 * 上游走流式：parse 4s / plan 10s 无首 token 中止（协议 §2.3）。
 * 校验失败重试由前端发起：retry 携带上一轮原文与校验错误，这里组装成追加对话。
 */
import type { Request, Response } from 'express'
import { z } from 'zod'
import { PLANNER_PROMPT, SYSTEM_PROMPT } from './prompt.generated.js'

// 火山方舟 Coding Plan（用户决策，弃七牛）：/api/coding 为 Anthropic 协议，
// /api/coding/v3 为 OpenAI 兼容协议——本服务用后者，复用 chat/completions + SSE delta
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3'
// 统一单模型（用户决策）：doubao-seed-code-2.0 文本+视觉双修——实测 parse 2.7s/plan 5.8s
// 不输 deepseek-v4-flash，且原生支持图像输入（自检无需切模型）；env 仍可分别覆盖
const DEFAULT_MODEL = 'doubao-seed-code-2.0'
const DEFAULT_VISION_MODEL = 'doubao-seed-code-2.0'

// parse / plan / layout 均关思考以求出图速度（首 token 快）；plan 质量改由"画后多轮异步自检精修"兜底
// layout 输出小（纯 JSON 布局），复用 parse 档超时
export const FIRST_TOKEN_TIMEOUT_MS = { parse: 8_000, plan: 20_000, layout: 8_000 } as const
/** 首 token 之后的总时长兜底（流卡死保护）；plan 长输出在 ~20 tok/s 上游需更宽 */
export const TOTAL_TIMEOUT_MS = { parse: 30_000, plan: 90_000, layout: 30_000 } as const

const requestSchema = z
  .object({
    utterance: z.string().min(1),
    mode: z.enum(['parse', 'plan', 'layout']),
    scene: z.unknown(),
    asr_alternatives: z.array(z.string()).max(2).optional(),
    recent: z.array(z.object({ utterance: z.string(), summary: z.string() }).strict()).max(3).optional(),
    retry: z.object({ previous: z.string(), error: z.string() }).strict().optional(),
    /** 画布截图 dataURL（视觉自检按需附带，协议 §2.2 v1.2）；带图时走多模态模型 */
    image: z.string().startsWith('data:image/').max(2_000_000).optional(),
    /** v1.4 流式交付：true 时把上游 content 增量透传（chunked text），前端边收边渐进绘制 */
    stream: z.boolean().optional(),
  })
  .strict()

export type LlmParseRequest = z.infer<typeof requestSchema>

type ChatContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: ChatContent
}

/** 组装上游消息：system 按 mode 选择；user = 变化信息 JSON（带图时为多模态数组）；重试时追加上一轮输出与纠错指示 */
export function buildMessages(body: LlmParseRequest): ChatMessage[] {
  const { retry, image, ...payload } = body
  const userContent: ChatMessage['content'] =
    image === undefined
      ? JSON.stringify(payload)
      : [
          { type: 'text', text: JSON.stringify(payload) },
          { type: 'image_url', image_url: { url: image } },
        ]
  const systemPrompt = body.mode === 'layout' ? PLANNER_PROMPT : SYSTEM_PROMPT
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ]
  if (retry) {
    messages.push(
      { role: 'assistant', content: retry.previous },
      { role: 'user', content: `你的输出未通过校验：${retry.error}。请重新只输出修正后的 JSON 对象，不要输出其他文字。` },
    )
  }
  return messages
}

/** 解析 SSE data 行 → delta 对象（含 content 与思考链 reasoning_content）；非数据/结束/异常返回 null */
function parseSseDelta(line: string): { content?: string; reasoning_content?: string } | null {
  if (!line.startsWith('data:')) return null
  const data = line.slice(5).trim()
  if (data === '' || data === '[DONE]') return null
  try {
    const json = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>
    }
    return json.choices?.[0]?.delta ?? null
  } catch {
    return null
  }
}

/** 内容 delta 文本（非数据行/结束标记/空内容返回 null） */
export function extractSseDelta(line: string): string | null {
  const c = parseSseDelta(line)?.content
  return typeof c === 'string' && c.length > 0 ? c : null
}

/** 思考链 delta（thinking 开启时的 reasoning_content）：仅作连接保活信号，不计入内容/延迟，不转发前端 */
export function extractSseReasoning(line: string): string | null {
  const r = parseSseDelta(line)?.reasoning_content
  return typeof r === 'string' && r.length > 0 ? r : null
}

export function isLlmConfigured(): boolean {
  return Boolean(process.env.ARK_API_KEY)
}

export async function handleLlmParse(req: Request, res: Response): Promise<void> {
  const parsed = requestSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'BAD_REQUEST', message: parsed.error.issues.map((i) => i.message).join('；') })
    return
  }
  if (!isLlmConfigured()) {
    res.status(503).json({ error: 'LLM_NOT_CONFIGURED', message: '未配置 ARK_API_KEY（火山方舟），仅规则层可用' })
    return
  }
  const body = parsed.data
  const baseUrl = (process.env.ARK_LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
  const model =
    body.image !== undefined
      ? process.env.ARK_VISION_MODEL || DEFAULT_VISION_MODEL
      : process.env.ARK_LLM_MODEL || DEFAULT_MODEL
  const firstTokenTimeout = FIRST_TOKEN_TIMEOUT_MS[body.mode]

  const t0 = Date.now()
  const abort = new AbortController()
  let timer = setTimeout(() => abort.abort(), firstTokenTimeout)

  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.ARK_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0,
        // 思考模式全关（方舟扩展参数）：求出图速度——开思考要在服务端先想 10~25s 才出首字，
        // "几十秒还在解析中"即源于此。质量改由画后多轮异步视觉自检精修兜底（不追求一次成图）。
        thinking: { type: 'disabled' },
        // 不传 response_format：Coding 端点的 deepseek-v4-flash 不支持 json_object（实测 400）；
        // JSON-only 由 System Prompt 约束 + 前端校验重试兜底
        messages: buildMessages(body),
      }),
      signal: abort.signal,
    })
    if (!upstream.ok || upstream.body === null) {
      const text = await upstream.text().catch(() => '')
      res.status(502).json({ error: 'UPSTREAM_ERROR', message: `上游 ${upstream.status}：${text.slice(0, 200)}` })
      return
    }

    let content = ''
    let firstTokenMs: number | undefined
    let buffer = ''
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    if (body.stream) {
      // v1.4 流式交付：增量透传（前端拿到的就是 LLM 正在写的 JSON 文本）
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Accel-Buffering', 'no')
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        // 思考阶段保活：部分模型/端点会以 reasoning_content 流式吐思考链，到达即重置首 token 看门狗。
        // 注意：当前 ark Coding 端点实测不流式 reasoning（思考在服务端、首内容 token 才出现），
        // 因此主要靠放宽后的 plan 首 token 超时(45s)兜底；此分支对会流式 reasoning 的端点仍有效。
        if (firstTokenMs === undefined && extractSseReasoning(line) !== null) {
          clearTimeout(timer)
          timer = setTimeout(() => abort.abort(), firstTokenTimeout)
        }
        const delta = extractSseDelta(line)
        if (delta === null) continue
        if (firstTokenMs === undefined) {
          firstTokenMs = Date.now() - t0
          clearTimeout(timer) // 首内容 token 已到，切换总时长兜底
          timer = setTimeout(() => abort.abort(), TOTAL_TIMEOUT_MS[body.mode])
        }
        content += delta
        if (body.stream) res.write(delta)
      }
    }
    if (body.stream) {
      res.end()
      return
    }
    res.json({ content, latencyMs: Date.now() - t0, firstTokenMs, model })
  } catch (e) {
    if (res.headersSent) {
      res.end() // 流式中途异常：断流，前端终验失败自动回退缓冲重试
      return
    }
    const aborted = (e as Error).name === 'AbortError'
    res.status(aborted ? 504 : 502).json({
      error: aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
      message: aborted
        ? `上游 ${FIRST_TOKEN_TIMEOUT_MS[body.mode] / 1000}s 无首 token（或流超时），已中止`
        : (e as Error).message,
    })
  } finally {
    clearTimeout(timer)
  }
}

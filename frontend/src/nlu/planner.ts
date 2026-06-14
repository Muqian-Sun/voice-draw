/**
 * 布局规划器前端客户端（按角色拆子计划设计 Phase 1）
 *
 * planLayout：调 backend /api/llm/parse（mode='layout'，非流式），
 * 返回布局 JSON（画布分框，不画形状），供后续按角色逐一子计划用。
 */
import { z } from 'zod'
import type { LlmCallContext } from './llm'
import { buildSceneSummary } from './llm'

// ---------- Layout 输出 schema ----------

const layoutSubjectSchema = z
  .object({
    label: z.string().min(1),
    cx: z.number(),
    cy: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
  })
  .strict()

export const layoutSchema = z
  .object({
    background: z.string().optional(),
    style: z.string().optional(),
    subjects: z.array(layoutSubjectSchema).min(1),
  })
  .strict()

export type LayoutSubject = z.infer<typeof layoutSubjectSchema>
export type Layout = z.infer<typeof layoutSchema>

// ---------- planLayout ----------

export type PlanLayoutResult =
  | { ok: true; layout: Layout; latencyMs: number }
  | { ok: false; error: string }

/**
 * 调 backend 的 layout 模式：拿到画布分框 JSON。
 * 不画任何形状，纯排版；编排由 PR-2 负责。
 */
export async function planLayout(utterance: string, ctx: LlmCallContext): Promise<PlanLayoutResult> {
  const t0 = performance.now()
  const fetchFn = ctx.fetchFn ?? fetch
  const baseUrl = ctx.baseUrl ?? `http://${location.hostname}:8787`

  const payload = {
    utterance,
    mode: 'layout' as const,
    scene: buildSceneSummary(ctx.scene, utterance, ctx.lastTransaction),
  }

  let res: Response
  try {
    res = await fetchFn(`${baseUrl}/api/llm/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    return { ok: false, error: `backend 不可达：${(e as Error).message}` }
  }

  const body = (await res.json().catch(() => null)) as { content?: string; error?: string; message?: string } | null
  if (!res.ok || body === null || typeof body.content !== 'string') {
    return { ok: false, error: body?.message ?? `backend ${res.status}` }
  }

  let json: unknown
  try {
    json = JSON.parse(body.content)
  } catch {
    return { ok: false, error: `布局 JSON 解析失败：${body.content.slice(0, 100)}` }
  }

  const parsed = layoutSchema.safeParse(json)
  if (!parsed.success) {
    return {
      ok: false,
      error: `布局 schema 校验失败：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')}`,
    }
  }

  return { ok: true, layout: parsed.data, latencyMs: performance.now() - t0 }
}

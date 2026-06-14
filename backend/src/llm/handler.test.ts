/**
 * LLM 转发纯函数单测（协议 §2.1-2.3）
 * 网络路径不在此测（流式上游 mock 成本高，由前端 mock-fetch 测试覆盖端到端语义）。
 */
import { describe, expect, it } from 'vitest'
import { FIRST_TOKEN_TIMEOUT_MS, buildMessages, extractSseDelta } from './handler.js'
import { PLANNER_PROMPT, SYSTEM_PROMPT } from './prompt.generated.js'

describe('buildMessages', () => {
  const base = { utterance: '画一个雪人', mode: 'plan' as const, scene: { objects: [] } }

  it('system 固定 + user 为变化信息 JSON（协议 §2.1）', () => {
    const m = buildMessages(base)
    expect(m).toHaveLength(2)
    expect(m[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT })
    expect(m[1].role).toBe('user')
    const payload = JSON.parse(m[1].content as string)
    expect(payload.utterance).toBe('画一个雪人')
    expect(payload.mode).toBe('plan')
    expect(payload.retry).toBeUndefined() // retry 是转发控制字段，不进载荷
  })

  it('重试时追加上一轮输出与校验错误（协议 §2.3）', () => {
    const m = buildMessages({ ...base, retry: { previous: '{"intent":"ops"}', error: 'ops 必须非空' } })
    expect(m).toHaveLength(4)
    expect(m[2]).toEqual({ role: 'assistant', content: '{"intent":"ops"}' })
    expect(m[3].role).toBe('user')
    expect(m[3].content).toContain('ops 必须非空')
  })
})

describe('extractSseDelta', () => {
  it('解析 data 行的 delta 内容', () => {
    expect(extractSseDelta('data: {"choices":[{"delta":{"content":"{\\"intent\\""}}]}')).toBe('{"intent"')
  })

  it('结束标记/空行/注释行返回 null', () => {
    expect(extractSseDelta('data: [DONE]')).toBeNull()
    expect(extractSseDelta('')).toBeNull()
    expect(extractSseDelta(': keep-alive')).toBeNull()
    expect(extractSseDelta('data: {"choices":[{"delta":{}}]}')).toBeNull()
  })
})

describe('首 token 超时（协议 §2.3）', () => {
  it('parse 8s / plan 20s / layout 8s（layout 输出小，复用 parse 档）', () => {
    expect(FIRST_TOKEN_TIMEOUT_MS.parse).toBe(8000)
    expect(FIRST_TOKEN_TIMEOUT_MS.plan).toBe(20000)
    expect(FIRST_TOKEN_TIMEOUT_MS.layout).toBe(8000)
  })
})

describe('mode:layout → PLANNER_PROMPT（按角色拆子计划 Phase 1）', () => {
  const layoutBase = { utterance: '画白雪公主和七个小矮人', mode: 'layout' as const, scene: { objects: [] } }

  it('mode=layout 时 system prompt 用 PLANNER_PROMPT（布局规划器）', () => {
    const m = buildMessages(layoutBase)
    expect(m[0]).toEqual({ role: 'system', content: PLANNER_PROMPT })
    expect(m[0].content).not.toBe(SYSTEM_PROMPT)
  })

  it('mode=layout 时 user 内容含 utterance 与 mode', () => {
    const m = buildMessages(layoutBase)
    expect(m).toHaveLength(2)
    const payload = JSON.parse(m[1].content as string)
    expect(payload.utterance).toBe('画白雪公主和七个小矮人')
    expect(payload.mode).toBe('layout')
  })

  it('PLANNER_PROMPT 包含关键规划指令', () => {
    expect(PLANNER_PROMPT).toContain('布局规划器')
    expect(PLANNER_PROMPT).toContain('subjects')
    expect(PLANNER_PROMPT).toContain('1024x768')
    expect(PLANNER_PROMPT).toContain('白雪公主')
  })
})

describe('System Prompt（规格 附录 A）', () => {
  it('包含 lexicon 数值与禁止本地操作声明', () => {
    expect(SYSTEM_PROMPT).toContain('红#FF4136')
    expect(SYSTEM_PROMPT).toContain('"一点"=60px')
    expect(SYSTEM_PROMPT).toContain('"small"=40 "medium"=80 "large"=160')
    expect(SYSTEM_PROMPT).toContain('禁止输出 clear、undo、redo、export')
  })
})

describe('视觉自检（image 附带时多模态消息，§2.2 v1.2）', () => {
  it('带 image → user 内容为 text+image_url 数组，image 不进文本载荷', () => {
    const m = buildMessages({
      utterance: '检查画面',
      mode: 'parse',
      scene: { objects: [] },
      image: 'data:image/png;base64,abc',
    })
    const user = m[1]
    expect(Array.isArray(user.content)).toBe(true)
    const parts = user.content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(parts[0].type).toBe('text')
    expect(parts[0].text).not.toContain('data:image')
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } })
  })

  it('不带 image → user 内容仍为纯字符串（既有行为不变）', () => {
    const m = buildMessages({ utterance: '画个圆', mode: 'parse', scene: { objects: [] } })
    expect(typeof m[1].content).toBe('string')
  })
})

/**
 * LLM 转发纯函数单测（协议 §2.1-2.3）
 * 网络路径不在此测（流式上游 mock 成本高，由前端 mock-fetch 测试覆盖端到端语义）。
 */
import { describe, expect, it } from 'vitest'
import { FIRST_TOKEN_TIMEOUT_MS, buildMessages, extractSseDelta } from './handler.js'
import { SYSTEM_PROMPT } from './prompt.generated.js'

describe('buildMessages', () => {
  const base = { utterance: '画一个雪人', mode: 'plan' as const, scene: { objects: [] } }

  it('system 固定 + user 为变化信息 JSON（协议 §2.1）', () => {
    const m = buildMessages(base)
    expect(m).toHaveLength(2)
    expect(m[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT })
    expect(m[1].role).toBe('user')
    const payload = JSON.parse(m[1].content)
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
  it('parse 4s / plan 10s', () => {
    expect(FIRST_TOKEN_TIMEOUT_MS.parse).toBe(4000)
    expect(FIRST_TOKEN_TIMEOUT_MS.plan).toBe(10000)
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

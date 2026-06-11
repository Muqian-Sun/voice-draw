/**
 * System Prompt 构建器测试（规格 附录 A："构建脚本校验"）
 * 守护两件事：① few-shot/数值与 lexicon 同步；② 生成产物与构建器逐字节一致。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COLOR_WORDS, MOVE_DELTA_WORDS, SCALE_WORDS, SEMANTIC_SIZE } from './lexicon'
import { buildSystemPrompt } from './llmPrompt'

describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt()

  it('数值来自 lexicon（改 lexicon 不改这里会失败）', () => {
    expect(prompt).toContain(`红${COLOR_WORDS['红']}`)
    expect(prompt).toContain(`"一点"=${MOVE_DELTA_WORDS['一点']}px`)
    expect(prompt).toContain(`"大一点"=${SCALE_WORDS['大一点']}`)
    expect(prompt).toContain(`"large"=${SEMANTIC_SIZE.large}`)
  })

  it('生成产物与构建器逐字节一致（不同步时运行 pnpm gen:prompt）', () => {
    const generated = readFileSync(
      resolve(__dirname, '../../../backend/src/llm/prompt.generated.ts'),
      'utf8',
    )
    const m = generated.match(/export const SYSTEM_PROMPT = (".*")\n?$/s)
    expect(m, 'prompt.generated.ts 格式异常').not.toBeNull()
    expect(JSON.parse(m![1])).toBe(prompt)
  })
})

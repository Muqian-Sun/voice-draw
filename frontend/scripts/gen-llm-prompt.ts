/**
 * 构建期生成 LLM System Prompt（规格 附录 A）：
 *   pnpm gen:prompt   （改动 lexicon / llmPrompt.ts 后运行，产物提交入库）
 * 产物 backend/src/llm/prompt.generated.ts 运行期逐字节不变；
 * llmPrompt.test.ts 守护产物与构建器同步。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSystemPrompt } from '../src/shared/llmPrompt'
import { PLANNER_PROMPT } from '../src/shared/llmPlannerPrompt'

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../backend/src/llm/prompt.generated.ts')

const content = `// 自动生成，禁止手改：frontend/scripts/gen-llm-prompt.ts（数值来源 lexicon，规格附录 A）
// 重新生成：cd frontend && pnpm gen:prompt
export const SYSTEM_PROMPT = ${JSON.stringify(buildSystemPrompt())}
export const PLANNER_PROMPT = ${JSON.stringify(PLANNER_PROMPT)}
`

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, content)
console.log(`[gen-llm-prompt] 已写入 ${out}（${content.length} 字符）`)

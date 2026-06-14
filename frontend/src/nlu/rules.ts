/**
 * 规则快路径（瘦身版）：仅系统指令 + LLM 路由助手
 *
 * 设计变更（refactor：去绘图规则模板）：绘图/编辑类口语（创建/移动/缩放/改色/删除/旋转/
 * 命名/选中）**不再走规则模板**，一律升 LLM（边生成边画、看画的过程）。本层只保留
 * **LLM 无法产出、必须本地处理**的系统指令：撤销/重做（T6）、清空（T7，confirm-pending）、
 * 保存图片（T10）。识别仍走「纠错（correction.ts）→ 词表同义词（VERB_WORDS）→ 分词」三道防线。
 *
 * 另保留 decideMode（parse/plan 路由判定，§4.3）与 extractPlanSubject（plan 自动编组组名，§5.1），
 * 二者依赖 tokenize；故分词机器（VOCAB/tokenize/Consumption）整体保留。
 */
import type { Anchor, Op, SizeSpec } from '../dsl'
import {
  ANCHOR_WORDS,
  COLOR_WORDS,
  DIRECTION_VECTORS,
  FOCUS_DEIXIS_WORDS,
  IGNORE_WORDS,
  MOVE_DELTA_WORDS,
  ORDINAL_SPECIAL_WORDS,
  SEMANTIC_SIZE_WORDS,
  SHAPE_ALIASES,
  VERB_WORDS,
  parseChineseNumber,
  type ShapeAlias,
} from '../shared/lexicon'

// ---------- ParseResult（协议 §2.5） ----------

export interface RuleParseResult {
  source: 'rule'
  intent: 'ops' | 'clarify' | 'confirm-pending'
  ops: Op[]
  say?: string
  confidence: 1.0
  latencyMs: number
  /** 命中的模板编号（埋点/日志） */
  template: string
}

export interface RuleContext {
  /** 场景中已命名对象（byName 热匹配；分词期名称优先） */
  names?: readonly string[]
  /** 当前是否有焦点对象（保留给路由上下文，系统指令不依赖） */
  hasFocus?: boolean
}

// ---------- 分词（最长匹配扫描 §2 各词表） ----------

type VerbIntent = keyof typeof VERB_WORDS

type Token =
  | { kind: 'verb'; text: string; intent: VerbIntent }
  | { kind: 'color'; text: string; hex: string }
  | { kind: 'shape'; text: string; alias: ShapeAlias }
  | { kind: 'anchor'; text: string; anchor: Anchor }
  | { kind: 'direction'; text: string; vec: [number, number] }
  | { kind: 'qty-move'; text: string; px: number }
  | { kind: 'size'; text: string; spec: SizeSpec }
  | { kind: 'number'; text: string; value: number }
  | { kind: 'ordinal'; text: string; value: number | 'first' | 'last' }
  | { kind: 'deixis'; text: string }
  | { kind: 'name'; text: string }
  | { kind: 'rotdir'; text: string; sign: 1 | -1 }
  | { kind: 'quoted'; text: string; content: string }
  | { kind: 'ignore'; text: string }
  | { kind: 'func'; text: string } // 结构虚词（的/在/个/往/画布…），模板自由消费
  | { kind: 'punct'; text: string }
  | { kind: 'unknown'; text: string }

type NumberToken = Extract<Token, { kind: 'number' }>

/** 词表 → 统一词典（同词多义时先注册者优先） */
type VocabEntry = (text: string) => Token
const VOCAB = new Map<string, VocabEntry>()

function addVocab(word: string, make: VocabEntry) {
  if (!VOCAB.has(word)) VOCAB.set(word, make)
}

// 词典覆盖全部词表，保证 tokenize 行为不变（decideMode 依赖形状/未知段的准确切分）。
for (const [w, v] of Object.entries(ORDINAL_SPECIAL_WORDS)) addVocab(w, (t) => ({ kind: 'ordinal', text: t, value: v }))
for (const w of FOCUS_DEIXIS_WORDS) addVocab(w, (t) => ({ kind: 'deixis', text: t }))
for (const [group, words] of Object.entries(VERB_WORDS) as [VerbIntent, readonly string[]][])
  for (const w of words) addVocab(w, (t) => ({ kind: 'verb', text: t, intent: group }))
for (const [w, hex] of Object.entries(COLOR_WORDS)) addVocab(w, (t) => ({ kind: 'color', text: t, hex }))
for (const [w, alias] of Object.entries(SHAPE_ALIASES)) addVocab(w, (t) => ({ kind: 'shape', text: t, alias }))
for (const [w, anchor] of Object.entries(ANCHOR_WORDS)) addVocab(w, (t) => ({ kind: 'anchor', text: t, anchor }))
for (const [w, px] of Object.entries(MOVE_DELTA_WORDS)) addVocab(w, (t) => ({ kind: 'qty-move', text: t, px }))
for (const [w, spec] of Object.entries(SEMANTIC_SIZE_WORDS)) addVocab(w, (t) => ({ kind: 'size', text: t, spec }))
for (const [w, vec] of Object.entries(DIRECTION_VECTORS)) addVocab(w, (t) => ({ kind: 'direction', text: t, vec }))
addVocab('顺时针', (t) => ({ kind: 'rotdir', text: t, sign: 1 }))
addVocab('逆时针', (t) => ({ kind: 'rotdir', text: t, sign: -1 }))
for (const w of IGNORE_WORDS) addVocab(w, (t) => ({ kind: 'ignore', text: t }))
// 结构虚词与模板内可自由消费的填充词（含常见量词与"带"类介词）
for (const w of ['画布', '图片', ...'的地在到向往朝是为成个只条根颗间朵棵座幅张带第度步']) addVocab(w, (t) => ({ kind: 'func', text: t }))

const MAX_VOCAB_LEN = Math.max(...[...VOCAB.keys()].map((w) => w.length))

const NUM_RUN_RE = /^([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十百千万]+)/
const ORDINAL_RE = /^第([零一二两三四五六七八九十百千万0-9]+)个?/
const QUOTE_RE = /^[「“"'『]([^「」“”"'『』]+)[」”"'『』]/
const PUNCT_RE = /^[\s，。、,.!?！？;；:：]+/

export function tokenize(text: string, names: readonly string[] = []): Token[] {
  const sortedNames = [...names].filter((n) => n.length > 0).sort((a, b) => b.length - a.length)
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    const punct = rest.match(PUNCT_RE)
    if (punct) {
      tokens.push({ kind: 'punct', text: punct[0] })
      i += punct[0].length
      continue
    }
    const quoted = rest.match(QUOTE_RE)
    if (quoted) {
      tokens.push({ kind: 'quoted', text: quoted[0], content: quoted[1] })
      i += quoted[0].length
      continue
    }
    const ord = rest.match(ORDINAL_RE)
    if (ord) {
      const n = parseChineseNumber(ord[1])
      if (n !== null && n >= 1) {
        tokens.push({ kind: 'ordinal', text: ord[0], value: n })
        i += ord[0].length
        continue
      }
    }
    // 场景对象名热匹配 / 词表 / 数字串，同起点取最长
    const name = sortedNames.find((n) => rest.startsWith(n))
    let vocabLen = 0
    for (let len = Math.min(MAX_VOCAB_LEN, rest.length); len >= 1; len--) {
      if (VOCAB.has(rest.slice(0, len))) {
        vocabLen = len
        break
      }
    }
    const num = rest.match(NUM_RUN_RE)
    const numValue = num ? parseChineseNumber(num[1]) : null
    const numLen = numValue !== null && num ? num[1].length : 0
    const best = Math.max(name?.length ?? 0, vocabLen, numLen)
    if (best === 0) {
      tokens.push({ kind: 'unknown', text: text[i] })
      i += 1
      continue
    }
    if (name !== undefined && name.length === best) {
      tokens.push({ kind: 'name', text: name })
    } else if (vocabLen === best) {
      const w = rest.slice(0, best)
      tokens.push(VOCAB.get(w)!(w))
    } else {
      tokens.push({ kind: 'number', text: num![1], value: numValue! })
    }
    i += best
  }
  return tokens
}

// ---------- 消费记账（§4.1 未消费 token 占比 ≤30%，按字符数计） ----------

class Consumption {
  private used: boolean[]
  constructor(private tokens: Token[]) {
    this.used = tokens.map((t) => t.kind === 'ignore' || t.kind === 'punct')
  }
  take(idx: number) {
    this.used[idx] = true
  }
  /** 消费所有指定 kind 的 token（结构虚词等） */
  takeKinds(...kinds: Token['kind'][]) {
    this.tokens.forEach((t, i) => {
      if (kinds.includes(t.kind)) this.used[i] = true
    })
  }
  ratioOk(): boolean {
    let total = 0
    let unused = 0
    this.tokens.forEach((t, i) => {
      if (t.kind === 'ignore' || t.kind === 'punct') return
      total += t.text.length
      if (!this.used[i]) unused += t.text.length
    })
    return total === 0 ? false : unused / total <= 0.3
  }
}

// ---------- 系统指令模板（T6/T7/T10，LLM 无法产出 → 本地识别） ----------

interface TemplateHit {
  intent: RuleParseResult['intent']
  ops: Op[]
  say?: string
  template: string
}

type Template = (text: string, tokens: Token[], cons: Consumption, ctx: RuleContext) => TemplateHit | null

const verbAt = (tokens: Token[], intent: VerbIntent) =>
  tokens.findIndex((t) => t.kind === 'verb' && t.intent === intent)

/** T6 撤销/重做：动词 + N 步? */
const tUndoRedo: Template = (_text, tokens, cons) => {
  const undoIdx = verbAt(tokens, 'undo')
  const redoIdx = verbAt(tokens, 'redo')
  if (undoIdx < 0 && redoIdx < 0) return null
  cons.take(undoIdx >= 0 ? undoIdx : redoIdx)
  cons.takeKinds('func')
  let steps: number | undefined
  const numIdx = tokens.findIndex((t) => t.kind === 'number')
  if (numIdx >= 0) {
    steps = (tokens[numIdx] as NumberToken).value
    if (!Number.isInteger(steps) || steps < 1) return null
    cons.take(numIdx)
  }
  const op: Op =
    undoIdx >= 0
      ? { op: 'undo', ...(steps !== undefined && { steps }) }
      : { op: 'redo', ...(steps !== undefined && { steps }) }
  return { intent: 'ops', ops: [op], say: undoIdx >= 0 ? '撤销了' : '重做了', template: 'T6' }
}

/** T7 清空：清空(画布)? / 全部删掉 / 重新开始 / 重画 → confirm-pending（协议 §4.3） */
const tClear: Template = (_text, tokens, cons) => {
  const verbIdx = verbAt(tokens, 'clear')
  if (verbIdx < 0) return null
  cons.take(verbIdx)
  cons.takeKinds('func')
  return { intent: 'confirm-pending', ops: [{ op: 'clear' }], say: '确定要清空画布吗？', template: 'T7' }
}

/** T10 导出：保存/导出/下载 + 图片? */
const tExport: Template = (_text, tokens, cons) => {
  const verbIdx = verbAt(tokens, 'export')
  if (verbIdx < 0) return null
  cons.take(verbIdx)
  cons.takeKinds('func')
  return { intent: 'ops', ops: [{ op: 'export', format: 'png' }], say: '已保存图片', template: 'T10' }
}

const TEMPLATES: Template[] = [tUndoRedo, tClear, tExport]

// ---------- 入口 ----------

/**
 * 系统指令本地解析：命中撤销/重做/清空/保存 → 直接产出 Op；其余（绘图/编辑）一律返回
 * null，由路由器升 LLM。命中后仍做"未消费占比 ≤30%"校验，防整段长句里偶含系统动词被误吞。
 */
export function parseRule(utterance: string, ctx: RuleContext = {}): RuleParseResult | null {
  const t0 = performance.now()
  const trimmed = utterance.trim()
  if (trimmed.length === 0) return null

  for (const template of TEMPLATES) {
    const tokens = tokenize(trimmed, ctx.names ?? [])
    const cons = new Consumption(tokens)
    const hit = template(trimmed, tokens, cons, ctx)
    if (hit === null) continue
    if (!cons.ratioOk()) continue // 成段未理解内容 → 宁可升级 LLM 也不猜（§4.1）
    return {
      source: 'rule',
      intent: hit.intent,
      ops: hit.ops,
      say: hit.say,
      confidence: 1.0,
      latencyMs: performance.now() - t0,
      template: hit.template,
    }
  }
  return null
}

// ---------- 升级 LLM 时的 mode 判定（§4.3） ----------

const PLAN_KEYWORDS = ['一幅', '一张', '一个场景', '风景']
const CONNECTOR_RE = /然后|接着|再/g

/**
 * 提取创作话术的主名词（"画一个雪人"→"雪人"），作 llm-plan 自动编组的组名（§5.1）。
 * 取最长的连续未知 token 段（词表外的内容词正是创作主题）；无则 null。
 */
export function extractPlanSubject(utterance: string): string | null {
  const tokens = tokenize(utterance)
  let best = ''
  let cur = ''
  for (const t of tokens) {
    if (t.kind === 'unknown') {
      cur += t.text
      if (cur.length > best.length) best = cur
    } else {
      cur = ''
    }
  }
  return best.length > 0 ? best : null
}

export function decideMode(utterance: string): 'parse' | 'plan' {
  if (PLAN_KEYWORDS.some((k) => utterance.includes(k))) return 'plan'
  const tokens = tokenize(utterance)
  const createVerbs = tokens.filter((t) => t.kind === 'verb' && t.intent === 'create').length
  const hasShape = tokens.some((t) => t.kind === 'shape')
  // 动词"画"+ 非词表具体名词（雪人/房子/树…）→ plan。
  // 阈值 ≥1：尺寸词会吞名词首字（"画一只小猫"的"小"是 size token，剩"猫"1 字），
  // 而"画 + 无形状词 + 有内容词"本就该创作拆解
  if (createVerbs > 0 && !hasShape) {
    const unknownChars = tokens.filter((t) => t.kind === 'unknown').reduce((n, t) => n + t.text.length, 0)
    if (unknownChars >= 1) return 'plan'
  }
  // 2 个以上连接词串联的创建动作 → plan
  const connectors = utterance.match(CONNECTOR_RE)?.length ?? 0
  if (connectors >= 2 && createVerbs >= 2) return 'plan'
  return 'parse'
}

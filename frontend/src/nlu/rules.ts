/**
 * 规则快路径：T1~T11 模板解析（规格 §4）
 *
 * 流程（§4.1）：纠错后文本 → 剔除忽略词 → 最长匹配分词 + 槽位标注
 *   → 按 T1~T11 依序尝试 → 命中且未消费字符占比 ≤30% → ParseResult{source:"rule"}
 *   → 否则 null（路由器升级 LLM，mode 由 decideMode 判定，§4.3）
 *
 * 输出与 LLM 同构（协议 §2.5 ParseResult）；clear 只在此层产生（intent=confirm-pending）。
 */
import type { Anchor, CreateOp, Op, SizeSpec, TargetSelector } from '../dsl'
import {
  ANCHOR_WORDS,
  COLOR_WORDS,
  DEFAULT_MOVE_DELTA,
  DIRECTION_VECTORS,
  FOCUS_DEIXIS_WORDS,
  IGNORE_WORDS,
  MOVE_DELTA_WORDS,
  ORDINAL_SPECIAL_WORDS,
  SCALE_WORDS,
  SEMANTIC_SIZE,
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
  /** 场景中已命名对象（byName 热匹配） */
  names?: readonly string[]
  /** 当前是否有焦点对象（目标缺失时回退 byFocus 的前提） */
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

type ColorToken = Extract<Token, { kind: 'color' }>
type ShapeToken = Extract<Token, { kind: 'shape' }>
type AnchorToken = Extract<Token, { kind: 'anchor' }>
type NumberToken = Extract<Token, { kind: 'number' }>
type SizeToken = Extract<Token, { kind: 'size' }>

/** 词表 → 统一词典（同词多义时先注册者优先） */
type VocabEntry = (text: string) => Token
const VOCAB = new Map<string, VocabEntry>()

function addVocab(word: string, make: VocabEntry) {
  if (!VOCAB.has(word)) VOCAB.set(word, make)
}

// 注意 SCALE_WORDS 不进词典——"变大很多"在左起贪心下会切成 变大+很多，
// T3 改用全句最长子串扫描（见 scanScale）。
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
const QUOTE_RE = /^[「“"'『]([^「」“”"'『』]+)[」”"'』]/
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
  isUsed(idx: number): boolean {
    return this.used[idx]
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

// ---------- 目标槽位统一解析（§4.2，T2~T5、T8、T11 共用） ----------

interface TargetMatch {
  selector: TargetSelector
  /** 消费的 token 下标 */
  idxs: number[]
}

/**
 * 优先级：已命名对象 → [颜色?][序数?][形状] byQuery → 序数单独成分 → 指代词 byFocus。
 * 指代词紧跟查询成分时作限定词消费（"那个红色的圆""刚才那个圆"），单独出现才是 byFocus。
 * mask：调用方排除的下标（如 T1 中被创建的形状本体）。
 */
function findTarget(tokens: Token[], mask: ReadonlySet<number> = new Set()): TargetMatch | null {
  const visible = (i: number) => !mask.has(i)

  const nameIdx = tokens.findIndex((t, i) => t.kind === 'name' && visible(i))
  if (nameIdx >= 0) return { selector: { byName: tokens[nameIdx].text }, idxs: [nameIdx] }

  const shapeIdx = tokens.findIndex((t, i) => t.kind === 'shape' && visible(i))
  if (shapeIdx >= 0) {
    const idxs = [shapeIdx]
    const q: { shape?: ShapeAlias['kind']; fill?: string; ordinal?: number | 'first' | 'last' } = {
      shape: (tokens[shapeIdx] as ShapeToken).alias.kind,
    }
    for (let i = shapeIdx - 1; i >= 0; i--) {
      const t = tokens[i]
      if (!visible(i)) break
      if (t.kind === 'func' && t.text === '的') {
        idxs.push(i)
      } else if (t.kind === 'color' && q.fill === undefined) {
        q.fill = t.hex
        idxs.push(i)
      } else if (t.kind === 'ordinal' && q.ordinal === undefined) {
        q.ordinal = t.value
        idxs.push(i)
      } else if (t.kind === 'deixis') {
        idxs.push(i) // 紧跟查询成分的指代词一律作限定词（那个/这个/刚才那个/刚画的 + 形状）
      } else {
        break
      }
    }
    return { selector: { byQuery: q }, idxs }
  }

  const ordIdx = tokens.findIndex((t, i) => t.kind === 'ordinal' && visible(i))
  if (ordIdx >= 0) {
    const value = (tokens[ordIdx] as Extract<Token, { kind: 'ordinal' }>).value
    return { selector: { byQuery: { ordinal: value } }, idxs: [ordIdx] }
  }

  const deixisIdx = tokens.findIndex((t, i) => t.kind === 'deixis' && visible(i))
  if (deixisIdx >= 0) return { selector: { byFocus: true }, idxs: [deixisIdx] }

  return null
}

const NO_FOCUS_SAY = '请先告诉我要操作哪个图形'

/** 目标缺失时回退焦点；焦点为空 → clarify（明确的信息缺失，不升级 LLM，§4.2 第 4 条） */
function targetOrFocus(
  tokens: Token[],
  cons: Consumption,
  ctx: RuleContext,
  limit?: number,
): { ok: true; selector: TargetSelector } | { ok: false } {
  const scope = limit === undefined ? tokens : tokens.slice(0, limit) // 前缀切片下标与原数组一致
  const m = findTarget(scope)
  if (m) {
    m.idxs.forEach((i) => cons.take(i))
    return { ok: true, selector: m.selector }
  }
  if (ctx.hasFocus) return { ok: true, selector: { byFocus: true } }
  return { ok: false }
}

// ---------- 模板匹配 ----------

interface TemplateHit {
  intent: RuleParseResult['intent']
  ops: Op[]
  say?: string
  template: string
}

type TemplateOutcome = TemplateHit | null | 'clarify-no-focus'
type Template = (text: string, tokens: Token[], cons: Consumption, ctx: RuleContext) => TemplateOutcome

const verbAt = (tokens: Token[], intent: VerbIntent) =>
  tokens.findIndex((t) => t.kind === 'verb' && t.intent === intent)

/** T1 创建：动词 + 位置? + 尺寸? + 颜色? + 形状 + 内容?（text 用） */
const tCreate: Template = (text, tokens, cons) => {
  const verbIdx = verbAt(tokens, 'create')
  if (verbIdx < 0) return null
  const verb = tokens[verbIdx] as Extract<Token, { kind: 'verb' }>
  cons.take(verbIdx)
  cons.takeKinds('func')

  // text 形状之一："写…"引导（§4.2 T1 细则），写之后整段是内容
  if (verb.text === '写') {
    const after = text.slice(text.indexOf('写') + 1).replace(/^上|^着/, '')
    const quoted = after.match(/[「“"'『]([^「」“”"'『』]+)[」”"'』]/)
    const content = (quoted ? quoted[1] : after).replace(/[\s，。、,.!?！？]+$/, '').trim()
    if (content.length === 0) return null
    tokens.forEach((_, i) => i > verbIdx && cons.take(i))
    const anchorIdx = tokens.findIndex((t, i) => t.kind === 'anchor' && i < verbIdx)
    const op: CreateOp = { op: 'create', shape: 'text', text: content }
    if (anchorIdx >= 0) {
      cons.take(anchorIdx)
      op.at = { ref: 'canvas', anchor: (tokens[anchorIdx] as AnchorToken).anchor }
    }
    return { intent: 'ops', ops: [op], say: `写好了：${content}`, template: 'T1' }
  }

  // 被创建形状：优先动词之后的形状 token（"在圆的右边画个方块"里 ref 在动词前）
  let shapeIdx = tokens.findIndex((t, i) => t.kind === 'shape' && i > verbIdx)
  if (shapeIdx < 0) shapeIdx = tokens.findIndex((t) => t.kind === 'shape')
  if (shapeIdx < 0) return null
  const alias = (tokens[shapeIdx] as ShapeToken).alias
  cons.take(shapeIdx)

  // text 形状之二：形状别名（字/文字/文本）+ 引号内容；无内容不命中（T1 细则）
  let textContent: string | undefined
  if (alias.kind === 'text') {
    const qIdx = tokens.findIndex((t) => t.kind === 'quoted')
    if (qIdx < 0) return null
    textContent = (tokens[qIdx] as Extract<Token, { kind: 'quoted' }>).content
    cons.take(qIdx)
  }

  // 位置：方位词 → ref=canvas；anchor 左侧存在目标成分 → "在 X 的 D"（ref=对象）
  let at: CreateOp['at']
  const anchorIdx = tokens.findIndex((t) => t.kind === 'anchor')
  if (anchorIdx >= 0) {
    cons.take(anchorIdx)
    const anchor = (tokens[anchorIdx] as AnchorToken).anchor
    const ref = findTarget(tokens.slice(0, anchorIdx), new Set([shapeIdx]))
    if (ref) {
      ref.idxs.forEach((i) => cons.take(i))
      at = { ref: ref.selector, anchor }
    } else {
      at = { ref: 'canvas', anchor }
    }
  }

  // 数量："画两个圆"展开 N 个 create（上限 5，超出升级 LLM）
  let count = 1
  const numIdx = tokens.findIndex((t, i) => t.kind === 'number' && i < shapeIdx && !cons.isUsed(i))
  if (numIdx >= 0) {
    const n = (tokens[numIdx] as NumberToken).value
    if (!Number.isInteger(n) || n < 1) return null
    if (n > 5) return null
    count = n
    cons.take(numIdx)
  }

  // 颜色 / 尺寸（跳过已被 ref 消费的）
  const colorIdx = tokens.findIndex((t, i) => t.kind === 'color' && !cons.isUsed(i))
  if (colorIdx >= 0) cons.take(colorIdx)
  const sizeIdx = tokens.findIndex((t, i) => t.kind === 'size' && !cons.isUsed(i))
  if (sizeIdx >= 0) cons.take(sizeIdx)
  const size: SizeSpec | undefined = sizeIdx >= 0 ? (tokens[sizeIdx] as SizeToken).spec : undefined

  const base: CreateOp = { op: 'create', shape: alias.kind }
  if (colorIdx >= 0) base.fill = (tokens[colorIdx] as ColorToken).hex
  if (at !== undefined) base.at = at
  if (textContent !== undefined) base.text = textContent
  // variant 几何（规格 §2.2/§2.4）：正方形 边=2v 显式产出 width=height；竖线 rotation=90
  if (alias.variant === 'square') {
    const v = typeof size === 'string' ? SEMANTIC_SIZE[size] : typeof size === 'number' ? size : SEMANTIC_SIZE.medium
    base.width = 2 * v
    base.height = 2 * v
  } else if (size !== undefined) {
    base.size = size
  }
  if (alias.variant === 'vertical') base.rotation = 90

  const ops: Op[] = Array.from({ length: count }, () => ({ ...base }))
  const colorName = colorIdx >= 0 ? tokens[colorIdx].text : ''
  const say = count > 1 ? `画了 ${count} 个${colorName}${tokens[shapeIdx].text}` : `画了一个${colorName}${tokens[shapeIdx].text}`
  return { intent: 'ops', ops, say, template: 'T1' }
}

/** T2 移动：目标? + 动词(移/挪/移动/拖) + 方向 + 量词?（方向×量词，缺省 60） */
const tMove: Template = (_text, tokens, cons, ctx) => {
  const verbIdx = verbAt(tokens, 'move')
  if (verbIdx < 0) return null

  // 方向：上/下/左/右 单字；或 往/向/朝 引导的纯边方位词（"往右边移"）。
  // "移到右边"不算方向（语义是移动到位置，规则层不猜，留给 LLM）。
  const SIDE_VEC: Partial<Record<Anchor, [number, number]>> = {
    top: [0, -1],
    bottom: [0, 1],
    left: [-1, 0],
    right: [1, 0],
  }
  let vec: [number, number] | undefined
  let dirIdx = tokens.findIndex((t) => t.kind === 'direction')
  if (dirIdx >= 0) {
    vec = (tokens[dirIdx] as Extract<Token, { kind: 'direction' }>).vec
  } else {
    dirIdx = tokens.findIndex(
      (t, i) =>
        t.kind === 'anchor' &&
        SIDE_VEC[(t as AnchorToken).anchor] !== undefined &&
        i > 0 &&
        tokens[i - 1].kind === 'func' &&
        ['往', '向', '朝'].includes(tokens[i - 1].text),
    )
    if (dirIdx >= 0) vec = SIDE_VEC[(tokens[dirIdx] as AnchorToken).anchor]
  }
  if (vec === undefined) return null
  cons.take(verbIdx)
  cons.take(dirIdx)
  cons.takeKinds('func')

  let px = DEFAULT_MOVE_DELTA
  const qtyIdx = tokens.findIndex((t) => t.kind === 'qty-move')
  if (qtyIdx >= 0) {
    px = (tokens[qtyIdx] as Extract<Token, { kind: 'qty-move' }>).px
    cons.take(qtyIdx)
  } else {
    const numIdx = tokens.findIndex((t) => t.kind === 'number')
    if (numIdx >= 0) {
      px = (tokens[numIdx] as NumberToken).value
      cons.take(numIdx)
    }
  }

  const target = targetOrFocus(tokens, cons, ctx)
  if (!target.ok) return 'clarify-no-focus'
  return {
    intent: 'ops',
    ops: [{ op: 'move', target: target.selector, delta: [vec[0] * px, vec[1] * px] }],
    say: '移好了',
    template: 'T2',
  }
}

/** T3 缩放：目标? + 缩放话术。话术取全句最长子串（左起贪心会把"变大很多"切成 变大+很多） */
function scanScale(text: string): { phrase: string; factor: number } | null {
  let best: { phrase: string; factor: number } | null = null
  for (const [phrase, factor] of Object.entries(SCALE_WORDS)) {
    if (text.includes(phrase) && (best === null || phrase.length > best.phrase.length)) {
      best = { phrase, factor }
    }
  }
  return best
}

const tResize: Template = (text, tokens, cons, ctx) => {
  const scale = scanScale(text)
  if (scale === null) return null
  // 消费缩放短语覆盖的 token：resize 动词、尺寸/量词、短语内的数字与未知字（"一半"的"半"）
  cons.takeKinds('func', 'qty-move', 'size')
  tokens.forEach((t, i) => {
    if (t.kind === 'verb' && t.intent === 'resize') cons.take(i)
    if ((t.kind === 'number' || t.kind === 'unknown') && scale.phrase.includes(t.text)) cons.take(i)
  })
  const target = targetOrFocus(tokens, cons, ctx)
  if (!target.ok) return 'clarify-no-focus'
  return {
    intent: 'ops',
    ops: [{ op: 'resize', target: target.selector, scale: scale.factor }],
    say: scale.factor > 1 ? '变大了' : '变小了',
    template: 'T3',
  }
}

/** T4 改色：目标? + (涂成/变成/改成/换成/涂) + 颜色（目标在动词左侧） */
const tStyle: Template = (_text, tokens, cons, ctx) => {
  const verbIdx = verbAt(tokens, 'style')
  if (verbIdx < 0) return null
  const colorIdx = tokens.findIndex((t, i) => t.kind === 'color' && i > verbIdx)
  if (colorIdx < 0) return null
  cons.take(verbIdx)
  cons.take(colorIdx)
  cons.takeKinds('func')
  const target = targetOrFocus(tokens, cons, ctx, verbIdx)
  if (!target.ok) return 'clarify-no-focus'
  return {
    intent: 'ops',
    ops: [{ op: 'style', target: target.selector, fill: (tokens[colorIdx] as ColorToken).hex }],
    say: `涂成${tokens[colorIdx].text}了`,
    template: 'T4',
  }
}

/** T5 删除：目标 + (删掉/删除/去掉/移除/擦掉)。"全部删掉"整词属 clear，分词期已截获 */
const tDelete: Template = (_text, tokens, cons, ctx) => {
  const verbIdx = verbAt(tokens, 'delete')
  if (verbIdx < 0) return null
  cons.take(verbIdx)
  cons.takeKinds('func')
  const target = targetOrFocus(tokens, cons, ctx)
  if (!target.ok) return 'clarify-no-focus'
  return { intent: 'ops', ops: [{ op: 'delete', target: target.selector }], say: '删掉了', template: 'T5' }
}

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

/** T8 旋转：目标? + (转/旋转) + N 度 + 顺/逆时针?（逆=负） */
const tRotate: Template = (_text, tokens, cons, ctx) => {
  const verbIdx = verbAt(tokens, 'rotate')
  if (verbIdx < 0) return null
  const numIdx = tokens.findIndex((t) => t.kind === 'number')
  if (numIdx < 0) return null
  cons.take(verbIdx)
  cons.take(numIdx)
  cons.takeKinds('func')
  let sign: 1 | -1 = 1
  const rotIdx = tokens.findIndex((t) => t.kind === 'rotdir')
  if (rotIdx >= 0) {
    sign = (tokens[rotIdx] as Extract<Token, { kind: 'rotdir' }>).sign
    cons.take(rotIdx)
  }
  const target = targetOrFocus(tokens, cons, ctx)
  if (!target.ok) return 'clarify-no-focus'
  const degrees = sign * (tokens[numIdx] as NumberToken).value
  return { intent: 'ops', ops: [{ op: 'rotate', target: target.selector, degrees }], say: '转好了', template: 'T8' }
}

/** T9 命名：(这个/它)? + 叫/命名为 + 名称（目标=焦点） */
const tRename: Template = (text, tokens, cons, ctx) => {
  const verbIdx = verbAt(tokens, 'rename')
  if (verbIdx < 0) return null
  if (!ctx.hasFocus) return 'clarify-no-focus'
  const verb = tokens[verbIdx] as Extract<Token, { kind: 'verb' }>
  const pos = text.indexOf(verb.text)
  if (pos < 0) return null
  const name = text
    .slice(pos + verb.text.length)
    .replace(/[\s，。、,.!?！？]+/g, '')
    .trim()
  if (name.length === 0 || name.length > 12) return null
  cons.takeKinds('deixis')
  tokens.forEach((_, i) => i >= verbIdx && cons.take(i))
  return { intent: 'ops', ops: [{ op: 'rename', target: { byFocus: true }, name }], say: `好，它叫${name}`, template: 'T9' }
}

/** T10 导出：保存/导出/下载 + 图片? */
const tExport: Template = (_text, tokens, cons) => {
  const verbIdx = verbAt(tokens, 'export')
  if (verbIdx < 0) return null
  cons.take(verbIdx)
  cons.takeKinds('func')
  return { intent: 'ops', ops: [{ op: 'export', format: 'png' }], say: '已保存图片', template: 'T10' }
}

/** T11 选中：选中/选择 + 目标 */
const tFocus: Template = (_text, tokens, cons, ctx) => {
  const verbIdx = verbAt(tokens, 'focus')
  if (verbIdx < 0) return null
  cons.take(verbIdx)
  cons.takeKinds('func')
  const m = findTarget(tokens)
  if (!m) return ctx.hasFocus ? null : 'clarify-no-focus'
  m.idxs.forEach((i) => cons.take(i))
  return { intent: 'ops', ops: [{ op: 'focus', target: m.selector }], say: '选中了', template: 'T11' }
}

const TEMPLATES: Template[] = [tCreate, tMove, tResize, tStyle, tDelete, tUndoRedo, tClear, tRotate, tRename, tExport, tFocus]

// ---------- 入口 ----------

export function parseRule(utterance: string, ctx: RuleContext = {}): RuleParseResult | null {
  const t0 = performance.now()
  const trimmed = utterance.trim()
  if (trimmed.length === 0) return null

  for (const template of TEMPLATES) {
    const tokens = tokenize(trimmed, ctx.names ?? [])
    const cons = new Consumption(tokens)
    const hit = template(trimmed, tokens, cons, ctx)
    if (hit === null) continue
    if (hit === 'clarify-no-focus') {
      return {
        source: 'rule',
        intent: 'clarify',
        ops: [],
        say: NO_FOCUS_SAY,
        confidence: 1.0,
        latencyMs: performance.now() - t0,
        template: 'target-missing',
      }
    }
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
  // 动词"画"+ 非词表具体名词（雪人/房子/树…）→ plan
  if (createVerbs > 0 && !hasShape) {
    const unknownChars = tokens.filter((t) => t.kind === 'unknown').reduce((n, t) => n + t.text.length, 0)
    if (unknownChars >= 2) return 'plan'
  }
  // 2 个以上连接词串联的创建动作 → plan
  const connectors = utterance.match(CONNECTOR_RE)?.length ?? 0
  if (connectors >= 2 && createVerbs >= 2) return 'plan'
  return 'parse'
}

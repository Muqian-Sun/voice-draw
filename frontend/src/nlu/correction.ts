/**
 * 同音词纠错（规格 §3）
 *
 * 流程（§3.1）：ASR final → ① 精确词表替换（§3.2，带上下文条件）
 *            → ② 剩余未识别 token 拼音回退（§3.3） → 进路由器
 * 纠错只发生在规则层匹配之前；送 LLM 的 utterance 用纠错后文本，原文放 asr_alternatives[0]。
 */
import { pinyin } from 'pinyin-pro'
import {
  ALL_VERB_WORDS,
  ANCHOR_WORDS,
  COLOR_WORDS,
  CONFIRM_NO_WORDS,
  CONFIRM_YES_WORDS,
  DIRECTION_VECTORS,
  FOCUS_DEIXIS_WORDS,
  IGNORE_WORDS,
  MOVE_DELTA_WORDS,
  ORDINAL_SPECIAL_WORDS,
  RELATIVE_SIZE_WORDS,
  SCALE_WORDS,
  SEMANTIC_SIZE_WORDS,
  SHAPE_ALIASES,
} from '../shared/lexicon'

// ---------- §3.2 纠错词表 ----------

/**
 * 条件类型：
 * - verb-slot：处于动词槽位（句首/连接词或"把…"之后，允许跳过前导忽略词）
 * - color-slot："成色"不紧跟在 变/改/换/涂 之后（否则"成"属于动词"变成/涂成"）
 * - yuan-shape："原"仅后接"形/圈"或紧跟量词（个/只/条/根/颗）之后
 *
 * 表中"保持"条目（如 五角星/星星/蓝）不进此表——它们是测试基线，验证不被误纠。
 */
type CorrectionCondition = 'verb-slot' | 'color-slot' | 'yuan-shape'

interface CorrectionEntry {
  from: string
  to: string
  when?: CorrectionCondition
}

export const HOMOPHONE_TABLE: readonly CorrectionEntry[] = [
  // 动词类（§3.2，条件：动词槽位）
  { from: '花', to: '画', when: 'verb-slot' },
  { from: '划', to: '画', when: 'verb-slot' },
  { from: '化', to: '画', when: 'verb-slot' },
  { from: '桦', to: '画', when: 'verb-slot' },
  { from: '山除', to: '删除' },
  { from: '闪出', to: '删除' },
  { from: '车销', to: '撤销' },
  { from: '撤消', to: '撤销' },
  { from: '重作', to: '重做' },
  { from: '虫做', to: '重做' },
  { from: '青空', to: '清空' },
  { from: '轻空', to: '清空' },
  { from: '亲空', to: '清空' },
  { from: '报存', to: '保存' },
  // 图形类
  { from: '园形', to: '圆形' },
  { from: '原形', to: '圆形' },
  { from: '原型', to: '圆形' },
  { from: '园', to: '圆' },
  { from: '元', to: '圆' },
  { from: '源', to: '圆' },
  { from: '缘', to: '圆' },
  { from: '原', to: '圆', when: 'yuan-shape' },
  { from: '方快', to: '方块' },
  { from: '方亏', to: '方块' },
  { from: '长方型', to: '长方形' },
  { from: '三脚形', to: '三角形' },
  { from: '三角型', to: '三角形' },
  { from: '午角星', to: '五角星' },
  { from: '值线', to: '直线' },
  { from: '知线', to: '直线' },
  // 颜色类
  { from: '篮色', to: '蓝色' },
  { from: '兰色', to: '蓝色' },
  { from: '率色', to: '绿色' },
  { from: '吕色', to: '绿色' },
  { from: '皇色', to: '黄色' },
  { from: '汇色', to: '灰色' },
  { from: '辉色', to: '灰色' },
  { from: '子色', to: '紫色' },
  { from: '成色', to: '橙色', when: 'color-slot' },
  // 方位/操作类
  { from: '做边', to: '左边' },
  { from: '坐边', to: '左边' },
  { from: '右变', to: '右边' },
  { from: '伤面', to: '上面' },
  { from: '虾面', to: '下面' },
  { from: '中减', to: '中间' },
  { from: '防大', to: '放大' },
  { from: '所小', to: '缩小' },
  { from: '锁小', to: '缩小' },
  { from: '依动', to: '移动' },
  { from: '咦动', to: '移动' },
  { from: '悬转', to: '旋转' },
]

// 同一起点取最长 from 优先（原形→圆形 先于 原→圆）
const TABLE_BY_LENGTH = [...HOMOPHONE_TABLE].sort((a, b) => b.from.length - a.from.length)

const QUANTIFIER_CHARS = new Set(['个', '只', '条', '根', '颗'])
const CLAUSE_LEADERS = ['然后', '再', '接着', '把']

/**
 * 从 pos 向左跳过忽略词后，是否处于句首/子句首/"把…"之后（动词槽位判定）。
 * 子句首判定先于忽略词跳过："然后"既是连接词又是忽略词，先按连接词命中。
 */
function isVerbSlot(text: string, pos: number): boolean {
  let i = pos
  for (;;) {
    if (i === 0) return true
    const before = text.slice(0, i)
    if (CLAUSE_LEADERS.some((w) => before.endsWith(w))) return true
    if (/[，。,.!?！？;；\s]$/.test(before)) return true
    const ignore = IGNORE_WORDS.find((w) => before.endsWith(w))
    if (ignore === undefined) return false
    i -= ignore.length
  }
}

function checkCondition(cond: CorrectionCondition, text: string, pos: number, len: number): boolean {
  switch (cond) {
    case 'verb-slot':
      return isVerbSlot(text, pos)
    case 'color-slot':
      return !['变', '改', '换', '涂'].includes(text[pos - 1] ?? '')
    case 'yuan-shape': {
      const next = text[pos + len] ?? ''
      const prev = text[pos - 1] ?? ''
      return next === '形' || next === '圈' || QUANTIFIER_CHARS.has(prev)
    }
  }
}

// ---------- §3.3 拼音回退 ----------

/** 候选词典：§2.1~§2.3 全部词条 + 动词表（预计算无声调拼音建索引） */
const FALLBACK_DICT_WORDS: readonly string[] = [
  ...new Set([
    ...Object.keys(COLOR_WORDS),
    ...Object.keys(SHAPE_ALIASES),
    ...Object.keys(ANCHOR_WORDS),
    ...ALL_VERB_WORDS,
  ]),
]

function toPinyin(word: string): string {
  return pinyin(word, { toneType: 'none', type: 'array' }).join('')
}

const FALLBACK_INDEX: ReadonlyArray<{ word: string; py: string }> = FALLBACK_DICT_WORDS.map(
  (word) => ({ word, py: toPinyin(word) }),
)

/**
 * 已知词全集（含量词/忽略词/确认词等）：能参与任何词表匹配的 token 不进拼音回退，
 * 避免把"一点""然后"这类合法词错纠成领域词。
 */
const KNOWN_WORDS: ReadonlySet<string> = new Set([
  ...FALLBACK_DICT_WORDS,
  ...Object.keys(MOVE_DELTA_WORDS),
  ...Object.keys(SCALE_WORDS),
  ...Object.keys(SEMANTIC_SIZE_WORDS),
  ...Object.keys(RELATIVE_SIZE_WORDS),
  ...Object.keys(ORDINAL_SPECIAL_WORDS),
  ...Object.keys(DIRECTION_VECTORS),
  ...IGNORE_WORDS,
  ...CONFIRM_YES_WORDS,
  ...CONFIRM_NO_WORDS,
  ...FOCUS_DEIXIS_WORDS,
  // 数字/量词/常见功能字：合法成分，不得进入未知段被拼音回退误纠
  ...'零一二两三四五六七八九十百千万个只条根颗第度步的在到向往是和跟与',
])

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2 // 只关心 ≤1，提前剪枝
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i)
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0]
    dp[0] = j
    for (let i = 1; i <= a.length; i++) {
      const cur = dp[i]
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return dp[a.length]
}

/**
 * 对未识别的 2~3 字 token 做拼音回退（§3.3）：
 * 拼音编辑距离 ≤1 且唯一命中 → 返回替换词；多个命中或距离 >1 → null（留给 LLM）。
 * 只比对同字数词条：真同音词音节数必然相同，跨长度比对会把任意双字词
 * 错纠成拼音前缀相近的单字词（如"盒子"hezi → "黑"hei，命名场景误伤）。
 */
export function pinyinCorrectToken(token: string): string | null {
  if (token.length < 2 || token.length > 3) return null
  const py = toPinyin(token)
  let hit: string | null = null
  for (const { word, py: dictPy } of FALLBACK_INDEX) {
    if (word.length !== token.length) continue
    if (word === token) return null // 本来就是词典词，无须纠
    if (editDistance(py, dictPy) <= 1) {
      if (hit !== null && hit !== word) return null // 多个命中 → 不替换
      hit = word
    }
  }
  return hit
}

// ---------- 纠错主流程（§3.1） ----------

export interface AppliedCorrection {
  from: string
  to: string
  index: number
  source: 'table' | 'pinyin'
}

export interface CorrectionResult {
  /** 纠错后文本（规则层与 LLM 的 utterance 用这个） */
  corrected: string
  /** ASR 原文（送 LLM 时放 asr_alternatives[0]） */
  original: string
  applied: AppliedCorrection[]
}

const CJK_RE = /[一-鿿]/

/** ① 精确词表替换：左→右扫描，同一位置最长 from 优先 */
function applyTable(text: string, applied: AppliedCorrection[]): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const entry = TABLE_BY_LENGTH.find(
      (e) =>
        text.startsWith(e.from, i) &&
        (e.when === undefined || checkCondition(e.when, text, i, e.from.length)),
    )
    if (entry) {
      applied.push({ from: entry.from, to: entry.to, index: i, source: 'table' })
      out += entry.to
      i += entry.from.length
    } else {
      out += text[i]
      i += 1
    }
  }
  return out
}

/** 最长匹配切出已知词；连续未知 CJK 段（2~3 字）尝试拼音回退 */
function applyPinyinFallback(text: string, applied: AppliedCorrection[]): string {
  const maxLen = 4 // 已知词最长 4 字（咖啡色/正方形/放大一倍 等；扫描上限）
  let out = ''
  let i = 0
  let unknown = '' // 连续未知 CJK 累积
  let unknownStart = 0

  const flushUnknown = () => {
    if (unknown === '') return
    const fix = pinyinCorrectToken(unknown)
    if (fix !== null) {
      applied.push({ from: unknown, to: fix, index: unknownStart, source: 'pinyin' })
      out += fix
    } else {
      out += unknown
    }
    unknown = ''
  }

  while (i < text.length) {
    const ch = text[i]
    if (!CJK_RE.test(ch)) {
      flushUnknown()
      out += ch
      i += 1
      continue
    }
    let matched = 0
    for (let len = Math.min(maxLen, text.length - i); len >= 1; len--) {
      if (KNOWN_WORDS.has(text.slice(i, i + len))) {
        matched = len
        break
      }
    }
    if (matched > 0) {
      flushUnknown()
      out += text.slice(i, i + matched)
      i += matched
    } else {
      if (unknown === '') unknownStart = i
      unknown += ch
      i += 1
    }
  }
  flushUnknown()
  return out
}

export function correctTranscript(text: string): CorrectionResult {
  const applied: AppliedCorrection[] = []
  const afterTable = applyTable(text, applied)
  const corrected = applyPinyinFallback(afterTable, applied)
  return { corrected, original: text, applied }
}

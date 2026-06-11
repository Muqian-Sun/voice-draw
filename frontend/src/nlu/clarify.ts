/**
 * 歧义澄清（规格 §5.7）
 *
 * AMBIGUOUS_TARGET 时由候选对象构造澄清问题与 expecting 候选答案：
 * - 候选 ≤3：优先用颜色区分（"有红色和蓝色两个圆，要哪个？"），
 *   颜色无法区分用位置（"左边的还是右边的？"）
 * - 候选 >3：提示说得具体一点，不开 expecting 快匹配窗口
 * 下一句 final 与 expecting 做包含匹配（matchExpecting），命中由路由器
 * 以 byId 补全原 Op 直接执行，不再走完整解析。
 */
import { getCenter, type SceneObject } from '../engine/scene'
import { COLOR_WORDS } from '../shared/lexicon'

/** hex → 颜色中文名（优先"X色"形式的词条） */
const HEX_TO_NAME: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>()
  for (const [word, hex] of Object.entries(COLOR_WORDS)) {
    const key = hex.toUpperCase()
    const cur = m.get(key)
    if (cur === undefined || (word.endsWith('色') && !cur.endsWith('色')) || (word.endsWith('色') && word.length < cur.length)) {
      m.set(key, word)
    }
  }
  return m
})()

const SHAPE_LABELS: Record<string, string> = {
  circle: '圆',
  ellipse: '椭圆',
  rect: '矩形',
  triangle: '三角形',
  line: '线',
  polyline: '折线',
  star: '星星',
  text: '文字',
  path: '图形',
}

export interface ExpectingItem {
  /** 用户回答里应包含的词（"红色"/"左边"…） */
  label: string
  /** 命中后补全到原 Op 的对象 id */
  id: string
}

export type ClarifyPlan =
  | { kind: 'choices'; question: string; expecting: ExpectingItem[] }
  | { kind: 'too-many'; question: string }

function shapeLabel(candidates: SceneObject[]): string {
  const kinds = new Set(candidates.map((o) => o.shape))
  return kinds.size === 1 ? (SHAPE_LABELS[candidates[0].shape] ?? '图形') : '图形'
}

/** 由歧义候选构造澄清方案（规格 §5.7） */
export function buildAmbiguityClarify(candidates: SceneObject[]): ClarifyPlan {
  const label = shapeLabel(candidates)
  if (candidates.length > 3) {
    return {
      kind: 'too-many',
      question: `画布上有 ${candidates.length} 个${label}，请说得具体一点，比如颜色或位置`,
    }
  }

  // 1) 颜色可区分：每个候选的填充色都有名字且互不相同
  const colorNames = candidates.map((o) => (o.fill !== undefined ? HEX_TO_NAME.get(o.fill.toUpperCase()) : undefined))
  if (colorNames.every((n): n is string => n !== undefined) && new Set(colorNames).size === candidates.length) {
    const expecting = candidates.map((o, i) => ({ label: colorNames[i]!, id: o.id }))
    return {
      kind: 'choices',
      question: `有${colorNames.join('和')}${numWord(candidates.length)}个${label}，要哪个？`,
      expecting,
    }
  }

  // 2) 位置区分：x 跨度大按左右，否则按上下
  const centers = candidates.map((o) => ({ o, c: getCenter(o) }))
  const xs = centers.map(({ c }) => c.x)
  const ys = centers.map(({ c }) => c.y)
  const horizontal = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys)
  const sorted = [...centers].sort((a, b) => (horizontal ? a.c.x - b.c.x : a.c.y - b.c.y))
  const posLabels =
    sorted.length === 2
      ? horizontal
        ? ['左边', '右边']
        : ['上面', '下面']
      : horizontal
        ? ['左边', '中间', '右边']
        : ['上面', '中间', '下面']
  const expecting = sorted.map(({ o }, i) => ({ label: posLabels[i], id: o.id }))
  return {
    kind: 'choices',
    question: `${posLabels.map((p) => `${p}的`).join('还是')}？`,
    expecting,
  }
}

function numWord(n: number): string {
  return n === 2 ? '两' : n === 3 ? '三' : String(n)
}

/** 澄清回答快匹配（§5.7）：包含匹配，命中唯一才算（"左边"与"右边"都出现则放弃） */
export function matchExpecting(text: string, expecting: ExpectingItem[]): ExpectingItem | null {
  const hits = expecting.filter((e) => text.includes(e.label))
  return hits.length === 1 ? hits[0] : null
}

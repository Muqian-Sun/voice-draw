/**
 * lexicon — 规格文档 §2 数值的唯一来源（docs/题目二-规则层与执行语义规格.md）
 *
 * 当前仅包含执行引擎需要的尺寸/样式表（§2.4）；颜色词、方位词、量词话术等
 * 理解层词表在规则层 PR（计划 PR #10）中补全到本模块。
 * 修改任何数值必须同步规格文档与 System Prompt（构建期由本模块生成）。
 */

/** 语义尺寸 → 特征尺寸 v（规格 §2.4） */
export const SEMANTIC_SIZE = {
  small: 40,
  medium: 80,
  large: 160,
} as const

export type SemanticSize = keyof typeof SEMANTIC_SIZE

/** 对象间距缺省（规格 §2.4） */
export const DEFAULT_GAP = 20
/** ref=canvas 内贴时的内边距（规格 §2.4） */
export const CANVAS_PADDING = 40
/** 自动布局尝试焦点四侧时的间距（规格 §5.2） */
export const AUTO_LAYOUT_GAP = 40

/** 缺省样式（规格 §2.4）：闭合图形缺省填充；线类缺省描边；文字缺省颜色 */
export const DEFAULT_STYLE = {
  fill: '#4B5563',
  lineStroke: '#111827',
  lineStrokeWidth: 3,
  textFill: '#111827',
} as const

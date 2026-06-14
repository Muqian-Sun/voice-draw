/**
 * lexicon — 规格文档 §2 词表与数值的唯一来源（docs/题目二-规则层与执行语义规格.md）
 *
 * 理解层（规则模板/同音词纠错/LLM System Prompt）与执行引擎共用本模块；
 * 修改任何词条或数值必须同步规格文档 §2 与 System Prompt（构建期由本模块生成）。
 * 动词表属规格 §4 模板文法，随规则层模块（计划 PR #12）落地，不在本文件。
 */
import type { Anchor, ShapeKind, SizeSpec } from '../dsl/schema'

// ---------- §2.1 颜色词 → hex ----------

/** 颜色词（含别名）→ hex。未命中的颜色词（如"香槟色"）由规则层升级 LLM 处理 */
export const COLOR_WORDS: Record<string, string> = {
  红: '#FF4136', 红色: '#FF4136', 大红: '#FF4136',
  深红: '#B22222', 暗红: '#B22222',
  粉: '#FFB6C1', 粉色: '#FFB6C1', 粉红: '#FFB6C1',
  橙: '#FF851B', 橙色: '#FF851B', 橘色: '#FF851B', 橘黄: '#FF851B',
  黄: '#FFDC00', 黄色: '#FFDC00',
  金: '#FFD700', 金色: '#FFD700', 金黄: '#FFD700',
  绿: '#2ECC40', 绿色: '#2ECC40',
  深绿: '#006400', 墨绿: '#006400',
  草绿: '#7CFC00', 浅绿: '#7CFC00', 嫩绿: '#7CFC00',
  蓝: '#0074D9', 蓝色: '#0074D9',
  天蓝: '#87CEEB', 浅蓝: '#87CEEB', 淡蓝: '#87CEEB',
  深蓝: '#001F3F', 藏蓝: '#001F3F',
  紫: '#B10DC9', 紫色: '#B10DC9',
  棕: '#8B4513', 棕色: '#8B4513', 咖啡色: '#8B4513', 褐色: '#8B4513',
  黑: '#111111', 黑色: '#111111',
  白: '#FFFFFF', 白色: '#FFFFFF',
  灰: '#AAAAAA', 灰色: '#AAAAAA',
  青: '#39CCCC', 青色: '#39CCCC',
}

// ---------- §2.2 形状别名 → ShapeKind ----------

/**
 * variant 携带别名隐含的几何约束，由理解层翻译为显式 DSL 字段：
 * square → width=height；oblong → 高 = 0.75 × 宽（引擎缺省即长方形，无需显式产出）；
 * horizontal/vertical → line 的方向。
 */
export interface ShapeAlias {
  kind: ShapeKind
  variant?: 'square' | 'oblong' | 'horizontal' | 'vertical'
}

export const SHAPE_ALIASES: Record<string, ShapeAlias> = {
  圆: { kind: 'circle' }, 圆形: { kind: 'circle' }, 圆圈: { kind: 'circle' }, 圈: { kind: 'circle' },
  椭圆: { kind: 'ellipse' }, 鸭蛋形: { kind: 'ellipse' },
  方: { kind: 'rect', variant: 'square' },
  方形: { kind: 'rect', variant: 'square' },
  方块: { kind: 'rect', variant: 'square' },
  正方形: { kind: 'rect', variant: 'square' },
  长方形: { kind: 'rect', variant: 'oblong' },
  矩形: { kind: 'rect', variant: 'oblong' },
  方框: { kind: 'rect', variant: 'oblong' },
  三角: { kind: 'triangle' }, 三角形: { kind: 'triangle' },
  线: { kind: 'line' }, 直线: { kind: 'line' }, 线条: { kind: 'line' },
  横线: { kind: 'line', variant: 'horizontal' },
  竖线: { kind: 'line', variant: 'vertical' },
  星: { kind: 'star' }, 星星: { kind: 'star' }, 五角星: { kind: 'star' },
  字: { kind: 'text' }, 文字: { kind: 'text' }, 文本: { kind: 'text' },
}

// ---------- §2.3 方位词 → Anchor ----------

/**
 * 同一张表服务两种位置：ref=canvas（"在左上角画…"）与 ref=对象（"在 X 的左边画…"），
 * ref 由模板结构决定（规格 §4.2 T1 细则）。
 * "旁边" 缺省 right，目标右侧空间不足 80px 时引擎自动改 left（规格 §2.3）。
 */
export const ANCHOR_WORDS: Record<string, Anchor> = {
  左上: 'top-left', 左上角: 'top-left',
  右上: 'top-right', 右上角: 'top-right',
  左下: 'bottom-left', 左下角: 'bottom-left',
  右下: 'bottom-right', 右下角: 'bottom-right',
  中间: 'center', 中央: 'center', 正中: 'center', 中心: 'center',
  上面: 'top', 上方: 'top', 顶部: 'top', 上边: 'top',
  下面: 'bottom', 下方: 'bottom', 底部: 'bottom', 下边: 'bottom',
  左边: 'left', 左侧: 'left', 左面: 'left',
  右边: 'right', 右侧: 'right', 右面: 'right',
  旁边: 'right',
}

/** 移动方向 → 单位向量（画布 y 轴向下；规格 §4.2 T2 的方向槽位） */
export const DIRECTION_VECTORS: Record<string, [number, number]> = {
  上: [0, -1],
  下: [0, 1],
  左: [-1, 0],
  右: [1, 0],
}

// ---------- §2.4 量词与尺寸映射（数值唯一来源） ----------

/** 移动距离话术 → 像素（move.delta 标量；显式数字走 parseChineseNumber） */
export const MOVE_DELTA_WORDS: Record<string, number> = {
  一点: 60, 一点点: 60, 稍微: 60,
  一些: 120, 一段: 120,
  很多: 240, 一大截: 240, 远一点: 240,
}

/** 缺省移动距离（T2 量词槽位缺失时，规格 §4.2） */
export const DEFAULT_MOVE_DELTA = 60

/**
 * 缩放话术 → resize.scale factor。
 * 注意"大大的"也出现在 SEMANTIC_SIZE_WORDS（创建槽位→large），按所处模板槽位取义。
 */
export const SCALE_WORDS: Record<string, number> = {
  大一点: 1.3, 变大: 1.3, 大一些: 1.3,
  大很多: 1.8, 大大的: 1.8,
  大一倍: 2.0, 放大一倍: 2.0, 两倍: 2.0,
  小一点: 0.77, 变小: 0.77, 小一些: 0.77,
  小很多: 0.55,
  缩小一半: 0.5, 一半: 0.5,
}

/** 语义尺寸 → 特征尺寸 v */
export const SEMANTIC_SIZE = {
  small: 40,
  medium: 80,
  large: 160,
} as const

export type SemanticSize = keyof typeof SEMANTIC_SIZE

/**
 * 创建时的尺寸触发词 → SizeSpec（规格 §2.4）。
 * "巨大" = large × 1.5，直接落为特征尺寸数值 240。
 */
export const SEMANTIC_SIZE_WORDS: Record<string, SizeSpec> = {
  小: 'small', 小小的: 'small', 迷你: 'small',
  大: 'large', 大大的: 'large', 很大: 'large',
  巨大: SEMANTIC_SIZE.large * 1.5,
}

/**
 * 相对尺寸触发词 → factor（"比 X 矮/小一点"→0.7；"和 X 一样大"→1.0；"比 X 大/高"→1.3）。
 * 维度规则（factor 作用于宽/高/特征尺寸哪一维）见规格 §2.4，由理解层按槽位决定。
 */
export const RELATIVE_SIZE_WORDS: Record<string, number> = {
  矮: 0.7, 小: 0.7, 低: 0.7,
  一样: 1.0, 一样大: 1.0, 一样高: 1.0,
  大: 1.3, 高: 1.3,
}

/** 对象间距缺省（规格 §2.4） */
export const DEFAULT_GAP = 20
/** ref=canvas 内贴时的内边距（规格 §2.4） */
export const CANVAS_PADDING = 40
/** 自动布局尝试焦点四侧时的间距（规格 §5.2） */
export const AUTO_LAYOUT_GAP = 40

/** 缺省样式（规格 §2.4）：闭合图形缺省填充；线类缺省描边；文字缺省颜色 */
// v1.7 缺省填充由暗灰 #4B5563（暖纸上发闷）换为饱和蓝 #2D7DD2，未指定颜色时也"出彩"；描边加粗 3→4
export const DEFAULT_STYLE = {
  fill: '#2D7DD2',
  lineStroke: '#111827',
  lineStrokeWidth: 4,
  textFill: '#111827',
} as const

// ---------- §2.5 忽略词（匹配前剔除，不计入未消费 token） ----------

/**
 * 注意两个条件条目，剔除时机由路由器在槽位标注后处理（规格 §4.1）：
 * "把"保留语法功能（界定目标槽位）后剔除；"来"作 T1 创建动词时不剔除；
 * "那个"仅剔除句中填充用法，句首单独成分是指代词（§2.7 FOCUS_DEIXIS_WORDS）。
 */
export const IGNORE_WORDS: readonly string[] = [
  '帮我', '请', '给我', '麻烦', '来', '一下',
  '吧', '啊', '呢', '哦', '嗯',
  '那个', '然后', '就', '把',
]

// ---------- §2.6 确认窗口词表（AWAIT_CONFIRM 子态专用） ----------

export const CONFIRM_YES_WORDS: readonly string[] = [
  '确认', '确定', '对', '对的', '是', '是的', '好', '好的', '嗯', '可以', '行', '清空吧', '删吧',
]

/** 未命中肯定/否定词的任何转写 → 视为否定（保守策略），TTS"已取消" */
export const CONFIRM_NO_WORDS: readonly string[] = [
  '取消', '不', '不要', '不用', '别', '算了', '等等',
]

// ---------- §2.7 序数与指代 ----------

/** 序数特殊词 → ordinal 字面量（"第N个"由 parseOrdinal 解析） */
export const ORDINAL_SPECIAL_WORDS: Record<string, 'first' | 'last'> = {
  最后: 'last', 最后一个: 'last', 最新的: 'last',
  最早: 'first', 最先: 'first',
}

/** 指代词（句首单独成分）→ {byFocus:true} */
export const FOCUS_DEIXIS_WORDS: readonly string[] = [
  '它', '这个', '那个', '刚才那个', '刚画的',
]

/** 解析序数词："第三个"→3，"最后"→'last'；非序数 → null */
export function parseOrdinal(token: string): number | 'first' | 'last' | null {
  const special = ORDINAL_SPECIAL_WORDS[token]
  if (special !== undefined) return special
  const m = token.match(/^第(.+?)个?$/)
  if (!m) return null
  const n = parseChineseNumber(m[1])
  return n !== null && n >= 1 ? n : null
}

// ---------- 动词表（规格 §4.2 模板清单；§3.3 拼音回退词典也引用） ----------

/**
 * 按意图分组的动词词条，唯一来源。模板语义（哪个动词配哪些槽位）在路由器（规格 §4.2），
 * 此处仅声明词形。"来"同时在 IGNORE_WORDS，作 T1 动词时不剔除（§2.5 条件条目）。
 */
export const VERB_WORDS = {
  create: ['画', '添加', '加', '来', '写'],
  move: ['移动', '移', '挪', '拖'],
  resize: ['放大', '缩小', '变', '放', '缩'],
  style: ['涂成', '变成', '改成', '换成', '涂'],
  delete: ['删掉', '删除', '去掉', '移除', '擦掉'],
  // 系统指令（撤销/重做/清空/保存）同义词从宽——绘图规则模板已删、它们没有 LLM 兜底，
  // 漏识别即直接失败，故覆盖更多口语说法（refactor：去绘图规则模板）。
  undo: ['撤销', '撤回', '回退', '退回', '撤一下', '返回上一步'],
  redo: ['重做', '恢复', '再来一次'],
  clear: ['清空', '全部删掉', '重新开始', '重画', '清屏', '清除', '清掉', '全部清掉'],
  rotate: ['旋转', '转'],
  rename: ['命名为', '叫'],
  export: ['保存', '导出', '下载', '存图', '截图', '存一下'],
  focus: ['选中', '选择'],
} as const

/** 全部动词词形（拼音回退词典用） */
export const ALL_VERB_WORDS: readonly string[] = Object.values(VERB_WORDS).flat()

// ---------- 中文数字解析（§2.4 显式数字 / §2.7 序数共用） ----------

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 }

/**
 * 中文/阿拉伯数字串 → 数值；无法解析返回 null。
 * 支持：阿拉伯数字（"100"、"4.5"）、十百千万（"二十五"、"一百零五"、"三千"），
 * 以及口语略尾（"一百二"=120）。范围覆盖话术所需（万级以内），不处理亿。
 */
export function parseChineseNumber(text: string): number | null {
  const s = text.trim()
  if (s === '') return null
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)

  let total = 0 // 已结算的万段
  let section = 0 // 当前万段内累计
  let digit: number | null = null // 待结算的数字
  let lastUnit = Infinity // 当前段内上一个单位，用于"一百二"略尾
  for (const ch of s) {
    if (ch === '零') {
      if (digit !== null) return null
      lastUnit = 10 // "一百零五"：零之后的裸数字按个位结算
      continue
    }
    if (ch in CN_DIGITS) {
      if (digit !== null) return null // "三五"这类连续数字不是数值
      digit = CN_DIGITS[ch]
      continue
    }
    const unit = CN_UNITS[ch]
    if (unit === undefined) return null
    if (unit === 10000) {
      section += digit ?? 0
      if (section === 0) return null // "万"前必须有数
      total += section * 10000
      section = 0
      digit = null
      lastUnit = Infinity
      continue
    }
    if (unit >= lastUnit) return null // "十百"这类单位逆序非法
    section += (digit ?? 1) * unit // "十五"的"十"按 1 计
    digit = null
    lastUnit = unit
  }
  if (digit !== null) {
    // 末尾裸数字：段内有单位时按口语略尾（"一百二"=120），否则是个位
    section += lastUnit !== Infinity ? digit * (lastUnit / 10) : digit
  }
  return total + section
}

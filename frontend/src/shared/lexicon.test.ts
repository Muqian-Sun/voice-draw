/**
 * lexicon 词表与解析函数单测（规格 §2）
 * 词表抽查用例直接取自规格文档表格，防止与文档失同步的静默改动。
 */
import { describe, expect, it } from 'vitest'
import {
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
  SEMANTIC_SIZE,
  SEMANTIC_SIZE_WORDS,
  SHAPE_ALIASES,
  parseChineseNumber,
  parseOrdinal,
} from './lexicon'

describe('§2.1 颜色词', () => {
  it('主词与别名映射到同一 hex', () => {
    expect(COLOR_WORDS['红']).toBe('#FF4136')
    expect(COLOR_WORDS['大红']).toBe('#FF4136')
    expect(COLOR_WORDS['藏蓝']).toBe('#001F3F')
    expect(COLOR_WORDS['咖啡色']).toBe('#8B4513')
    expect(COLOR_WORDS['金黄']).toBe('#FFD700')
    expect(COLOR_WORDS['嫩绿']).toBe('#7CFC00')
  })

  it('全部值是合法 hex', () => {
    for (const [word, hex] of Object.entries(COLOR_WORDS)) {
      expect(hex, word).toMatch(/^#[0-9A-F]{6}$/)
    }
  })
})

describe('§2.2 形状别名', () => {
  it('正方形/长方形区分 variant', () => {
    expect(SHAPE_ALIASES['正方形']).toEqual({ kind: 'rect', variant: 'square' })
    expect(SHAPE_ALIASES['长方形']).toEqual({ kind: 'rect', variant: 'oblong' })
    expect(SHAPE_ALIASES['矩形']).toEqual({ kind: 'rect', variant: 'oblong' })
  })

  it('横线/竖线携带方向', () => {
    expect(SHAPE_ALIASES['横线']).toEqual({ kind: 'line', variant: 'horizontal' })
    expect(SHAPE_ALIASES['竖线']).toEqual({ kind: 'line', variant: 'vertical' })
    expect(SHAPE_ALIASES['直线']).toEqual({ kind: 'line' })
  })

  it('常用别名', () => {
    expect(SHAPE_ALIASES['圈'].kind).toBe('circle')
    expect(SHAPE_ALIASES['鸭蛋形'].kind).toBe('ellipse')
    expect(SHAPE_ALIASES['五角星'].kind).toBe('star')
    expect(SHAPE_ALIASES['文本'].kind).toBe('text')
  })
})

describe('§2.3 方位词与方向', () => {
  it('角点/边/中心', () => {
    expect(ANCHOR_WORDS['左上角']).toBe('top-left')
    expect(ANCHOR_WORDS['右下']).toBe('bottom-right')
    expect(ANCHOR_WORDS['正中']).toBe('center')
    expect(ANCHOR_WORDS['顶部']).toBe('top')
    expect(ANCHOR_WORDS['左侧']).toBe('left')
  })

  it('"旁边"缺省 right（空间不足由引擎改 left）', () => {
    expect(ANCHOR_WORDS['旁边']).toBe('right')
  })

  it('移动方向单位向量（y 轴向下）', () => {
    expect(DIRECTION_VECTORS['上']).toEqual([0, -1])
    expect(DIRECTION_VECTORS['右']).toEqual([1, 0])
  })
})

describe('§2.4 量词与尺寸', () => {
  it('移动距离三档', () => {
    expect(MOVE_DELTA_WORDS['稍微']).toBe(60)
    expect(MOVE_DELTA_WORDS['一段']).toBe(120)
    expect(MOVE_DELTA_WORDS['一大截']).toBe(240)
  })

  it('缩放 factor', () => {
    expect(SCALE_WORDS['大一点']).toBe(1.3)
    expect(SCALE_WORDS['大大的']).toBe(1.8)
    expect(SCALE_WORDS['两倍']).toBe(2.0)
    expect(SCALE_WORDS['小一点']).toBe(0.77)
    expect(SCALE_WORDS['小很多']).toBe(0.55)
    expect(SCALE_WORDS['缩小一半']).toBe(0.5)
  })

  it('语义尺寸触发词；"巨大"= large × 1.5', () => {
    expect(SEMANTIC_SIZE_WORDS['迷你']).toBe('small')
    expect(SEMANTIC_SIZE_WORDS['很大']).toBe('large')
    expect(SEMANTIC_SIZE_WORDS['巨大']).toBe(SEMANTIC_SIZE.large * 1.5)
    expect(SEMANTIC_SIZE_WORDS['巨大']).toBe(240)
  })

  it('相对尺寸 factor', () => {
    expect(RELATIVE_SIZE_WORDS['矮']).toBe(0.7)
    expect(RELATIVE_SIZE_WORDS['一样大']).toBe(1.0)
    expect(RELATIVE_SIZE_WORDS['高']).toBe(1.3)
  })
})

describe('§2.5 忽略词 / §2.6 确认窗口', () => {
  it('忽略词包含条件条目（把/来/那个）', () => {
    for (const w of ['帮我', '一下', '把', '来', '那个']) {
      expect(IGNORE_WORDS).toContain(w)
    }
  })

  it('肯定/否定词表', () => {
    expect(CONFIRM_YES_WORDS).toContain('清空吧')
    expect(CONFIRM_YES_WORDS).toContain('好的')
    expect(CONFIRM_NO_WORDS).toContain('算了')
    expect(CONFIRM_NO_WORDS).toContain('等等')
  })

  it('肯定与否定词不重叠', () => {
    const yes = new Set(CONFIRM_YES_WORDS)
    for (const w of CONFIRM_NO_WORDS) expect(yes.has(w), w).toBe(false)
  })
})

describe('§2.7 序数与指代', () => {
  it('特殊序数词', () => {
    expect(ORDINAL_SPECIAL_WORDS['最后一个']).toBe('last')
    expect(ORDINAL_SPECIAL_WORDS['最新的']).toBe('last')
    expect(ORDINAL_SPECIAL_WORDS['最先']).toBe('first')
  })

  it('parseOrdinal："第N个"', () => {
    expect(parseOrdinal('第一个')).toBe(1)
    expect(parseOrdinal('第三个')).toBe(3)
    expect(parseOrdinal('第3个')).toBe(3)
    expect(parseOrdinal('第十二个')).toBe(12)
    expect(parseOrdinal('最后')).toBe('last')
    expect(parseOrdinal('圆')).toBeNull()
    expect(parseOrdinal('第个')).toBeNull()
  })

  it('指代词表', () => {
    for (const w of ['它', '这个', '刚画的']) {
      expect(FOCUS_DEIXIS_WORDS).toContain(w)
    }
  })
})

describe('parseChineseNumber', () => {
  it('阿拉伯数字原值', () => {
    expect(parseChineseNumber('100')).toBe(100)
    expect(parseChineseNumber('4.5')).toBe(4.5)
  })

  it('个位与"两"', () => {
    expect(parseChineseNumber('一')).toBe(1)
    expect(parseChineseNumber('两')).toBe(2)
    expect(parseChineseNumber('九')).toBe(9)
  })

  it('十位', () => {
    expect(parseChineseNumber('十')).toBe(10)
    expect(parseChineseNumber('十五')).toBe(15)
    expect(parseChineseNumber('二十')).toBe(20)
    expect(parseChineseNumber('四十五')).toBe(45)
  })

  it('百千万与零占位', () => {
    expect(parseChineseNumber('一百')).toBe(100)
    expect(parseChineseNumber('两百')).toBe(200)
    expect(parseChineseNumber('一百零五')).toBe(105)
    expect(parseChineseNumber('一百二十')).toBe(120)
    expect(parseChineseNumber('三千')).toBe(3000)
    expect(parseChineseNumber('一万')).toBe(10000)
    expect(parseChineseNumber('五十六万三千')).toBe(563000)
  })

  it('口语略尾："一百二"=120', () => {
    expect(parseChineseNumber('一百二')).toBe(120)
    expect(parseChineseNumber('三千五')).toBe(3500)
  })

  it('非数值返回 null', () => {
    expect(parseChineseNumber('')).toBeNull()
    expect(parseChineseNumber('圆')).toBeNull()
    expect(parseChineseNumber('三五')).toBeNull()
    expect(parseChineseNumber('十百')).toBeNull()
    expect(parseChineseNumber('万')).toBeNull()
  })
})

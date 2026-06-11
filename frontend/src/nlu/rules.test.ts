/**
 * 规则快路径单测（规格 §4）。用例以 §4.2 模板表的示例句为基线。
 */
import { describe, expect, it } from 'vitest'
import { decideMode, parseRule } from './rules'

const FOCUSED = { hasFocus: true }

describe('T1 创建', () => {
  it('位置 + 尺寸 + 颜色 + 形状：在左上角画个大的蓝色矩形', () => {
    const r = parseRule('在左上角画个大的蓝色矩形')
    expect(r?.template).toBe('T1')
    expect(r?.intent).toBe('ops')
    expect(r?.ops).toEqual([
      {
        op: 'create',
        shape: 'rect',
        fill: '#0074D9',
        size: 'large',
        at: { ref: 'canvas', anchor: 'top-left' },
      },
    ])
  })

  it('最简形式：画一个红色的圆', () => {
    const r = parseRule('画一个红色的圆')
    expect(r?.ops).toEqual([{ op: 'create', shape: 'circle', fill: '#FF4136' }])
  })

  it('数量展开：画两个圆 → 2 个 create；超过 5 个不命中', () => {
    expect(parseRule('画两个圆')?.ops).toHaveLength(2)
    expect(parseRule('画六个圆')).toBeNull()
  })

  it('相对定位：在圆的右边画个方块（正方形显式 width=height=2v）', () => {
    const r = parseRule('在圆的右边画个方块')
    expect(r?.ops).toEqual([
      {
        op: 'create',
        shape: 'rect',
        width: 160,
        height: 160,
        at: { ref: { byQuery: { shape: 'circle' } }, anchor: 'right' },
      },
    ])
  })

  it('竖线带 rotation 90', () => {
    const r = parseRule('画条竖线')
    expect(r?.ops[0]).toMatchObject({ op: 'create', shape: 'line', rotation: 90 })
  })

  it('text："写上你好"；带位置："在右上角写上欢迎光临"', () => {
    expect(parseRule('写上你好')?.ops).toEqual([{ op: 'create', shape: 'text', text: '你好' }])
    expect(parseRule('在右上角写上欢迎光临')?.ops).toEqual([
      { op: 'create', shape: 'text', text: '欢迎光临', at: { ref: 'canvas', anchor: 'top-right' } },
    ])
  })

  it('text 形状无内容 → 不命中（T1 细则）', () => {
    expect(parseRule('画个文字')).toBeNull()
  })
})

describe('T2 移动', () => {
  it('把圆往右移一点 → delta [60,0]', () => {
    const r = parseRule('把圆往右移一点')
    expect(r?.template).toBe('T2')
    expect(r?.ops).toEqual([{ op: 'move', target: { byQuery: { shape: 'circle' } }, delta: [60, 0] }])
  })

  it('显式数字：右移100；缺省量词 60：往左挪', () => {
    expect(parseRule('右移100', FOCUSED)?.ops).toEqual([{ op: 'move', target: { byFocus: true }, delta: [100, 0] }])
    expect(parseRule('往左挪', FOCUSED)?.ops).toEqual([{ op: 'move', target: { byFocus: true }, delta: [-60, 0] }])
  })

  it('"移到右边"是移动到位置，不属 T2 → 升级 LLM', () => {
    expect(parseRule('把它移到右边', FOCUSED)).toBeNull()
  })
})

describe('T3 缩放', () => {
  it('把它变大一点 → 1.3；变大很多 → 1.8（全句最长短语，不被贪心切错）', () => {
    expect(parseRule('把它变大一点', FOCUSED)?.ops).toEqual([{ op: 'resize', target: { byFocus: true }, scale: 1.3 }])
    expect(parseRule('把圆变大很多')?.ops).toEqual([
      { op: 'resize', target: { byQuery: { shape: 'circle' } }, scale: 1.8 },
    ])
  })

  it('缩小一半 → 0.5；放大一倍 → 2.0', () => {
    expect(parseRule('缩小一半', FOCUSED)?.ops[0]).toMatchObject({ op: 'resize', scale: 0.5 })
    expect(parseRule('把它放大一倍', FOCUSED)?.ops[0]).toMatchObject({ op: 'resize', scale: 2.0 })
  })
})

describe('T4 改色', () => {
  it('把房子涂成红色（byName 热匹配）', () => {
    const r = parseRule('把房子涂成红色', { names: ['房子'] })
    expect(r?.ops).toEqual([{ op: 'style', target: { byName: '房子' }, fill: '#FF4136' }])
  })

  it('把它变成蓝色 → byFocus', () => {
    expect(parseRule('把它变成蓝色', FOCUSED)?.ops).toEqual([
      { op: 'style', target: { byFocus: true }, fill: '#0074D9' },
    ])
  })

  it('未知颜色词（香槟色）不命中 → 升级 LLM', () => {
    expect(parseRule('把圆变成香槟色')).toBeNull()
  })
})

describe('T5 删除', () => {
  it('把那个圆删掉（"那个"作限定词）', () => {
    expect(parseRule('把那个圆删掉')?.ops).toEqual([{ op: 'delete', target: { byQuery: { shape: 'circle' } } }])
  })

  it('删除红色的圆 → byQuery 含 fill', () => {
    expect(parseRule('删除红色的圆')?.ops).toEqual([
      { op: 'delete', target: { byQuery: { shape: 'circle', fill: '#FF4136' } } },
    ])
  })

  it('序数目标：把第二个删掉', () => {
    expect(parseRule('把第二个删掉')?.ops).toEqual([{ op: 'delete', target: { byQuery: { ordinal: 2 } } }])
  })
})

describe('T6 撤销/重做', () => {
  it('撤销三步 / 撤销 / 重做', () => {
    expect(parseRule('撤销三步')?.ops).toEqual([{ op: 'undo', steps: 3 }])
    expect(parseRule('撤销')?.ops).toEqual([{ op: 'undo' }])
    expect(parseRule('重做')?.ops).toEqual([{ op: 'redo' }])
  })
})

describe('T7 清空（confirm-pending）', () => {
  it.each(['清空画布', '清空', '全部删掉', '重新开始'])('%s → confirm-pending + clear', (s) => {
    const r = parseRule(s)
    expect(r?.intent).toBe('confirm-pending')
    expect(r?.ops).toEqual([{ op: 'clear' }])
    expect(r?.say).toContain('确定')
  })
})

describe('T8 旋转', () => {
  it('把三角形转45度', () => {
    expect(parseRule('把三角形转45度')?.ops).toEqual([
      { op: 'rotate', target: { byQuery: { shape: 'triangle' } }, degrees: 45 },
    ])
  })

  it('逆时针旋转90度 → 负角度', () => {
    expect(parseRule('逆时针旋转90度', FOCUSED)?.ops).toEqual([
      { op: 'rotate', target: { byFocus: true }, degrees: -90 },
    ])
  })

  it('中文数字：旋转四十五度', () => {
    expect(parseRule('旋转四十五度', FOCUSED)?.ops[0]).toMatchObject({ degrees: 45 })
  })
})

describe('T9 命名', () => {
  it('这个叫屋顶 → rename 焦点', () => {
    expect(parseRule('这个叫屋顶', FOCUSED)?.ops).toEqual([
      { op: 'rename', target: { byFocus: true }, name: '屋顶' },
    ])
  })

  it('无焦点 → clarify', () => {
    const r = parseRule('这个叫屋顶')
    expect(r?.intent).toBe('clarify')
  })
})

describe('T10 导出 / T11 选中', () => {
  it('保存图片 → export png', () => {
    expect(parseRule('保存图片')?.ops).toEqual([{ op: 'export', format: 'png' }])
  })

  it('选中那个红色的圆 → focus byQuery', () => {
    expect(parseRule('选中那个红色的圆')?.ops).toEqual([
      { op: 'focus', target: { byQuery: { shape: 'circle', fill: '#FF4136' } } },
    ])
  })
})

describe('目标缺失与未命中', () => {
  it('目标缺失且无焦点 → clarify，不升级 LLM（§4.2 第 4 条）', () => {
    const r = parseRule('变大一点')
    expect(r?.intent).toBe('clarify')
    expect(r?.say).toBe('请先告诉我要操作哪个图形')
  })

  it('未消费占比 >30% → 不命中（宁可升级 LLM 也不猜）', () => {
    expect(parseRule('画一个圆给妈妈看看怎么样')).toBeNull()
  })

  it('创作型（画雪人）→ 不命中', () => {
    expect(parseRule('画一个雪人')).toBeNull()
  })

  it('命中结果带元数据：source=rule，confidence=1.0', () => {
    const r = parseRule('画一个圆')
    expect(r?.source).toBe('rule')
    expect(r?.confidence).toBe(1.0)
    expect(r?.latencyMs).toBeGreaterThanOrEqual(0)
  })
})

describe('decideMode（§4.3）', () => {
  it('画 + 非词表名词 → plan', () => {
    expect(decideMode('画一个雪人')).toBe('plan')
    expect(decideMode('画个房子')).toBe('plan')
  })

  it('一幅/风景 → plan', () => {
    expect(decideMode('画一幅日落风景')).toBe('plan')
  })

  it('多连接词串联创建 → plan', () => {
    expect(decideMode('画个太阳然后画个房子然后画棵树')).toBe('plan')
  })

  it('普通单指令 → parse', () => {
    expect(decideMode('把圆变成香槟色')).toBe('parse')
    expect(decideMode('把它移到右边')).toBe('parse')
  })
})

/**
 * 规则快路径单测（瘦身版：仅系统指令 + LLM 路由助手）。
 * 绘图/编辑模板已删（升 LLM）；本测试守护「系统指令识别质量」与「绘图一律不命中规则」。
 */
import { describe, expect, it } from 'vitest'
import { decideMode, extractPlanSubject, parseRule } from './rules'
import { correctTranscript } from './correction'

describe('T6 撤销/重做（含同义词 + 步数）', () => {
  it('基础 + 步数：撤销 / 撤销三步 / 重做', () => {
    expect(parseRule('撤销')?.ops).toEqual([{ op: 'undo' }])
    expect(parseRule('撤销三步')?.ops).toEqual([{ op: 'undo', steps: 3 }])
    expect(parseRule('重做')?.ops).toEqual([{ op: 'redo' }])
  })

  it.each(['撤销', '撤回', '回退', '退回', '撤一下', '返回上一步'])('撤销同义词「%s」→ undo', (s) => {
    expect(parseRule(s)?.ops).toEqual([{ op: 'undo' }])
    expect(parseRule(s)?.template).toBe('T6')
  })

  it.each(['重做', '恢复', '再来一次'])('重做同义词「%s」→ redo', (s) => {
    expect(parseRule(s)?.ops).toEqual([{ op: 'redo' }])
  })
})

describe('T7 清空（confirm-pending，含同义词）', () => {
  it.each(['清空画布', '清空', '全部删掉', '重新开始', '清屏', '清除', '清掉', '全部清掉'])(
    '「%s」→ confirm-pending + clear',
    (s) => {
      const r = parseRule(s)
      expect(r?.intent).toBe('confirm-pending')
      expect(r?.ops).toEqual([{ op: 'clear' }])
      expect(r?.say).toContain('确定')
    },
  )
})

describe('T10 导出（含同义词）', () => {
  it.each(['保存图片', '保存', '导出', '下载', '存图', '截图', '存一下'])('「%s」→ export png', (s) => {
    expect(parseRule(s)?.ops).toEqual([{ op: 'export', format: 'png' }])
  })
})

describe('纠错 → 系统指令（同音错也能命中）', () => {
  it('车销→撤销 / 青空→清空 / 倒出→导出', () => {
    expect(parseRule(correctTranscript('车销').corrected)?.template).toBe('T6')
    expect(parseRule(correctTranscript('青空').corrected)?.template).toBe('T7')
    expect(parseRule(correctTranscript('倒出').corrected)?.template).toBe('T10')
  })
})

describe('绘图/编辑指令一律不命中规则（升级 LLM）', () => {
  it.each([
    '画一个红色的圆',
    '在左上角画个大的蓝色矩形',
    '把圆往右移一点',
    '把它变大一点',
    '把房子涂成红色',
    '把那个圆删掉',
    '把三角形转45度',
    '这个叫屋顶',
    '选中那个红色的圆',
    '写上你好',
    '画一个雪人',
  ])('「%s」→ null（交 LLM）', (s) => {
    expect(parseRule(s, { hasFocus: true, names: ['房子'] })).toBeNull()
  })
})

describe('命中结果元数据', () => {
  it('source=rule，confidence=1.0，latency≥0', () => {
    const r = parseRule('撤销')
    expect(r?.source).toBe('rule')
    expect(r?.confidence).toBe(1.0)
    expect(r?.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('长句里偶含系统动词但未消费占比 >30% → 不命中（宁可升 LLM 也不误吞）', () => {
    expect(parseRule('帮我把这幅画保存到我的电脑桌面上去好不好')).toBeNull()
  })
})

describe('decideMode（§4.3 parse/plan 路由判定）', () => {
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

  it('带形状词的简单指令 → parse', () => {
    expect(decideMode('画一个红色的圆')).toBe('parse')
    expect(decideMode('把它移到右边')).toBe('parse')
  })
})

describe('extractPlanSubject（llm-plan 自动编组组名，§5.1）', () => {
  it('取最长未知词段作主名词', () => {
    expect(extractPlanSubject('画一个雪人')).toBe('雪人')
    expect(extractPlanSubject('帮我画一间带烟囱的房子')).toBe('烟囱')
    expect(extractPlanSubject('画个圆')).toBeNull() // 全部是词表词
  })
})

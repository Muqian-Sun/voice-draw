/**
 * 同音词纠错单测（规格 §3）
 * 含 §3.2 表中"保持"条目的基线用例：确认合法词不被误纠。
 */
import { describe, expect, it } from 'vitest'
import { correctTranscript, pinyinCorrectToken } from './correction'

describe('§3.2 精确词表替换', () => {
  it('动词类：句首"花/划/化"→画', () => {
    expect(correctTranscript('花一个园').corrected).toBe('画一个圆')
    expect(correctTranscript('划个圆').corrected).toBe('画个圆')
    expect(correctTranscript('化一个三角形').corrected).toBe('画一个三角形')
  })

  it('动词类：前导忽略词后仍是动词槽位', () => {
    expect(correctTranscript('帮我花个圆').corrected).toBe('帮我画个圆')
    expect(correctTranscript('麻烦花一个方块').corrected).toBe('麻烦画一个方块')
  })

  it('动词类：连接词/逗号后的子句首', () => {
    expect(correctTranscript('画个圆然后花个方块').corrected).toBe('画个圆然后画个方块')
    expect(correctTranscript('画个圆，花个星星').corrected).toBe('画个圆，画个星星')
  })

  it('动词类：非动词槽位不纠（"画一朵花"的"花"是名词）', () => {
    expect(correctTranscript('画一朵花').corrected).toBe('画一朵花')
  })

  it('操作动词：撤销/清空/删除/保存', () => {
    expect(correctTranscript('车销一步').corrected).toBe('撤销一步')
    expect(correctTranscript('撤消').corrected).toBe('撤销')
    expect(correctTranscript('青空画布').corrected).toBe('清空画布')
    expect(correctTranscript('把圆山除').corrected).toBe('把圆删除')
    expect(correctTranscript('报存图片').corrected).toBe('保存图片')
  })

  it('图形类：园/元/原形 → 圆，同位置最长优先', () => {
    expect(correctTranscript('画个园形').corrected).toBe('画个圆形')
    expect(correctTranscript('画一个元').corrected).toBe('画一个圆')
    expect(correctTranscript('画个原型').corrected).toBe('画个圆形')
    expect(correctTranscript('画个三脚形').corrected).toBe('画个三角形')
    expect(correctTranscript('画条值线').corrected).toBe('画条直线')
  })

  it('图形类："原"条件：仅后接形/圈或量词之后', () => {
    expect(correctTranscript('画一个原').corrected).toBe('画一个圆')
    expect(correctTranscript('原来的不要动').corrected).toBe('原来的不要动')
  })

  it('颜色类', () => {
    expect(correctTranscript('画个篮色的圆').corrected).toBe('画个蓝色的圆')
    expect(correctTranscript('涂成皇色').corrected).toBe('涂成黄色')
    expect(correctTranscript('画个子色方块').corrected).toBe('画个紫色方块')
  })

  it('颜色类："成色"条件：不紧跟在变/改/换/涂后', () => {
    expect(correctTranscript('画个成色的圆').corrected).toBe('画个橙色的圆')
    expect(correctTranscript('把它变成色块').corrected).toBe('把它变成色块')
  })

  it('方位/操作类', () => {
    expect(correctTranscript('把圆放到做边').corrected).toBe('把圆放到左边')
    expect(correctTranscript('依动到伤面').corrected).toBe('移动到上面')
    expect(correctTranscript('把它防大').corrected).toBe('把它放大')
    expect(correctTranscript('所小一点').corrected).toBe('缩小一点')
  })

  it('"保持"基线：合法词不被误纠', () => {
    expect(correctTranscript('画个五角星').corrected).toBe('画个五角星')
    expect(correctTranscript('画两个星星').corrected).toBe('画两个星星')
    expect(correctTranscript('画个蓝色的圆').corrected).toBe('画个蓝色的圆')
    expect(correctTranscript('放大一倍').corrected).toBe('放大一倍')
    expect(correctTranscript('旋转四十五度').corrected).toBe('旋转四十五度')
  })
})

describe('§3.3 拼音回退', () => {
  it('距离 ≤1 且唯一命中 → 替换', () => {
    expect(pinyinCorrectToken('员形')).toBe('圆形') // yuanxing 距离 0
    expect(pinyinCorrectToken('撤效')).toBe('撤销') // chexiao 距离 0
    expect(pinyinCorrectToken('重组')).toBe('重做') // chongzu→chongzuo 距离 1
    expect(pinyinCorrectToken('删粗')).toBe('删除') // shancu→shanchu 距离 1
  })

  it('多个命中 → 保守不替换（留给 LLM）', () => {
    // zuse 距离 1 同时命中 橘色(juse) 与 紫色(zise)
    expect(pinyinCorrectToken('祖色')).toBeNull()
  })

  it('词典词本身/无命中 → null', () => {
    expect(pinyinCorrectToken('圆形')).toBeNull()
    expect(pinyinCorrectToken('你好')).toBeNull()
    expect(pinyinCorrectToken('屋顶')).toBeNull()
  })

  it('长度不在 2~3 字 → null', () => {
    expect(pinyinCorrectToken('圆')).toBeNull()
    expect(pinyinCorrectToken('紫不拉几')).toBeNull()
  })

  it('整句流程：表未覆盖的同音词走拼音回退', () => {
    const r = correctTranscript('画个员形')
    expect(r.corrected).toBe('画个圆形')
    expect(r.applied).toEqual([{ from: '员形', to: '圆形', index: 2, source: 'pinyin' }])
  })

  it('文本内容（text 槽位）不被误纠', () => {
    expect(correctTranscript('写上你好').corrected).toBe('写上你好')
  })
})

describe('纠错结果元数据', () => {
  it('original 保留原文，applied 记录替换轨迹', () => {
    const r = correctTranscript('花一个园')
    expect(r.original).toBe('花一个园')
    expect(r.applied).toEqual([
      { from: '花', to: '画', index: 0, source: 'table' },
      { from: '园', to: '圆', index: 3, source: 'table' },
    ])
  })

  it('无纠错时 applied 为空', () => {
    const r = correctTranscript('画一个红色的圆')
    expect(r.applied).toEqual([])
    expect(r.corrected).toBe(r.original)
  })
})

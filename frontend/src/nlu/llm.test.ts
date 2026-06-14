/**
 * LLM 前端客户端单测（协议 §2.2-2.3）：
 * SceneSummary 分层上下文、输出业务校验四条、mock fetch 的重试链路。
 */
import { describe, expect, it, vi } from 'vitest'
import { executeTransaction } from '../engine/interpreter'
import { createEmptyScene, type SceneState } from '../engine/scene'
import { buildSceneSummary, parseWithLlm, validateLlmOutput } from './llm'

function sceneWith(n: number): SceneState {
  let s = createEmptyScene()
  for (let i = 0; i < n; i++) {
    const r = executeTransaction(s, [
      { op: 'create', shape: i % 2 === 0 ? 'circle' : 'rect', at: { x: 100 + i * 5, y: 100 }, size: 20 },
    ])
    s = r.state
  }
  return s
}

/**
 * 构造 8 角色 ~160 对象的复杂多角色场景（白雪公主 + 7 矮人）。
 * 每个角色 ~20 部件，共约 160 对象——远超旧版 MAX_SCENE_OBJECTS=30。
 */
function buildComplexScene(): SceneState {
  const characters = ['白雪公主', '矮人甲', '矮人乙', '矮人丙', '矮人丁', '矮人戊', '矮人己', '矮人庚']
  let s = createEmptyScene()

  for (let ci = 0; ci < characters.length; ci++) {
    const charName = characters[ci]
    const baseX = 100 + ci * 120
    const baseY = 400
    const partNames = [
      '头', '脸', '眼睛', '嘴巴', '鼻子', '耳朵',
      '身体', '左臂', '右臂', '左手', '右手',
      '左腿', '右腿', '左脚', '右脚',
      '帽子', '头发', '衣服', '腰带', '纽扣',
    ]
    const created: string[] = []
    for (let pi = 0; pi < partNames.length; pi++) {
      const partFullName = `${charName}_${partNames[pi]}`
      const r = executeTransaction(s, [
        {
          op: 'create',
          shape: pi % 3 === 0 ? 'circle' : pi % 3 === 1 ? 'rect' : 'ellipse',
          name: partFullName,
          at: { x: baseX + (pi % 4) * 10, y: baseY - pi * 5 },
          size: 15 + pi,
        },
      ])
      s = r.state
      created.push(partFullName)
    }
    // 编组
    const targets = created.map((n) => ({ byName: n }))
    const gr = executeTransaction(s, [{ op: 'group', targets, name: charName }])
    s = gr.state
  }
  return s
}

describe('buildSceneSummary 分层上下文（画布地图 + 聚焦详情）', () => {
  it('简单场景：canvasMap 包含所有未编组对象，details 含 focus 对象', () => {
    const s = sceneWith(3)
    const sum = buildSceneSummary(s, '画一个圆')
    // 所有对象都是未编组的，应在 canvasMap 中出现
    expect(sum.canvasMap).toHaveLength(3)
    expect(sum.truncated).toBeUndefined()
    expect(sum.focusId).toBe(s.focusId)
    // focus 对象应在 details 中展开（含 bbox）
    const focusDetail = sum.details.find((d) => d.id === s.focusId)
    expect(focusDetail).toBeDefined()
    expect(focusDetail?.bbox).toHaveLength(4)
  })

  it('组场景：canvasMap 含组条目，details 按 focus/话术展开相关组', () => {
    let s = createEmptyScene()
    s = executeTransaction(s, [
      { op: 'create', shape: 'circle', name: '头', at: { x: 400, y: 300 }, size: 80 },
      { op: 'create', shape: 'circle', name: '左耳', at: { x: 360, y: 240 }, size: 20 },
    ]).state
    s = executeTransaction(s, [{ op: 'group', targets: [{ byName: '头' }, { byName: '左耳' }], name: '猫' }]).state
    const sum = buildSceneSummary(s, '把头变大')
    // canvasMap 含组"猫"
    const catEntry = sum.canvasMap.find((e) => e.name === '猫')
    expect(catEntry).toBeDefined()
    expect(catEntry?.kind).toBe('group')
    expect(catEntry?.members).toEqual(expect.arrayContaining(['头', '左耳']))
    // "头"在话术中被提到，所在组"猫"应展开到 details
    const headDetail = sum.details.find((d) => d.name === '头')
    expect(headDetail).toBeDefined()
    expect(headDetail?.center).toEqual([400, 300]) // 圆中心 = (x,y)，不是 bbox 角
  })

  it('center 精度：圆中心 = (x,y) 本身，而非 bbox 角', () => {
    let s = createEmptyScene()
    s = executeTransaction(s, [{ op: 'create', shape: 'circle', name: '头', at: { x: 400, y: 300 }, size: 80 }]).state
    const sum = buildSceneSummary(s, '把头变大')
    const entry = sum.details.find((d) => d.name === '头')
    expect(entry?.center).toEqual([400, 300])
  })

  it('焦点粒度：group op → scope=group；resize 单部件 → scope=object', () => {
    let s = createEmptyScene()
    s = executeTransaction(s, [
      { op: 'create', shape: 'circle', name: '头', at: { x: 400, y: 300 }, size: 80 },
      { op: 'create', shape: 'circle', name: '眼', at: { x: 400, y: 290 }, size: 8 },
    ]).state
    s = executeTransaction(s, [{ op: 'group', targets: [{ byName: '头' }, { byName: '眼' }], name: '脸' }]).state
    expect(buildSceneSummary(s, 'x').focus?.scope).toBe('group')
    s = executeTransaction(s, [{ op: 'resize', target: { byName: '眼' }, scale: 2 }]).state
    expect(buildSceneSummary(s, 'x').focus).toEqual({ name: '眼', id: s.focusId, scope: 'object' })
  })
})

describe('buildSceneSummary 8 角色复杂场景（多轮编辑关键断言）', () => {
  let complexScene: SceneState

  it('构造 8 角色 ~160 对象，总对象数 ≥ 160', () => {
    complexScene = buildComplexScene()
    expect(complexScene.objects.length).toBeGreaterThanOrEqual(160)
  })

  it('① 所有组名都在 canvasMap（地图层完整）', () => {
    complexScene = buildComplexScene()
    const mapNames = new Set(complexScene.objects
      .map((o) => o.groupId)
      .filter((g): g is string => g !== undefined))
    // buildComplexScene 中每个角色的 groupId 即角色名
    const expectedGroups = ['白雪公主', '矮人甲', '矮人乙', '矮人丙', '矮人丁', '矮人戊', '矮人己', '矮人庚']
    const sum = buildSceneSummary(complexScene, '看看场景')
    const mapGroupNames = sum.canvasMap.filter((e) => e.kind === 'group').map((e) => e.name)
    for (const expected of expectedGroups) {
      const found = mapGroupNames.includes(expected) || mapNames.has(expected)
      // 地图层一定能找到所有组条目
      expect(sum.canvasMap.some((e) => e.name === expected || e.name === expected)).toBe(true)
      void found
    }
    expect(mapGroupNames.length).toBeGreaterThanOrEqual(8)
  })

  it('② 话术提到的组展开了部件详情', () => {
    complexScene = buildComplexScene()
    // 话术提到"白雪公主"
    const sum = buildSceneSummary(complexScene, '把白雪公主移到中间')
    // 白雪公主的部件应出现在 details
    const snowWhiteDetails = sum.details.filter((d) => d.groupId === '白雪公主')
    expect(snowWhiteDetails.length).toBeGreaterThan(0)
    // 部件应有 bbox
    expect(snowWhiteDetails[0].bbox).toHaveLength(4)
  })

  it('③ 未提到的组只在 canvasMap、不在 details', () => {
    complexScene = buildComplexScene()
    // 把焦点移到"白雪公主"某个部件，确保 focus 不在矮人组
    const snowPart = complexScene.objects.find((o) => o.groupId === '白雪公主')!
    const sceneFocusedOnSnow = executeTransaction(complexScene, [
      { op: 'resize', target: { byId: snowPart.id }, scale: 1 },
    ]).state
    // 话术只提到"白雪公主"，其余 7 个矮人不应有部件出现在 details
    const sum = buildSceneSummary(sceneFocusedOnSnow, '把白雪公主移到中间')
    const unmentionedGroups = ['矮人甲', '矮人乙', '矮人丙', '矮人丁', '矮人戊', '矮人己', '矮人庚']
    for (const g of unmentionedGroups) {
      const inDetails = sum.details.some((d) => d.groupId === g)
      expect(inDetails).toBe(false)
      // 但在地图层可见
      const inMap = sum.canvasMap.some((e) => e.name === g)
      expect(inMap).toBe(true)
    }
  })

  it('④ 展开部件数受预算控制（≤40），地图层不计入预算', () => {
    complexScene = buildComplexScene()
    // 话术同时提到所有 8 个角色，触发最大展开压力
    const sum = buildSceneSummary(
      complexScene,
      '让白雪公主矮人甲矮人乙矮人丙矮人丁矮人戊矮人己矮人庚都往前走',
    )
    // details 总部件数 ≤ 40
    expect(sum.details.length).toBeLessThanOrEqual(40)
    // 地图层仍有全部 8 个组（不受预算影响）
    const mapGroups = sum.canvasMap.filter((e) => e.kind === 'group')
    expect(mapGroups.length).toBeGreaterThanOrEqual(8)
    // 有截断标识
    expect(sum.truncated).toBe(true)
  })

  it('canvasMap 组条目包含 union bbox、成员名清单和形状摘要', () => {
    complexScene = buildComplexScene()
    const sum = buildSceneSummary(complexScene, '看看场景')
    const snowEntry = sum.canvasMap.find((e) => e.name === '白雪公主')
    expect(snowEntry).toBeDefined()
    expect(snowEntry?.bbox).toHaveLength(4)
    expect(snowEntry?.center).toHaveLength(2)
    expect(snowEntry?.memberCount).toBe(20) // 20 部件
    expect(snowEntry?.members).toHaveLength(20)
    expect(snowEntry?.shapes).toBeDefined()
    expect(snowEntry?.shapes?.length).toBeGreaterThan(0)
  })
})

describe('validateLlmOutput（协议 §2.3 业务校验）', () => {
  const okOps = JSON.stringify({
    intent: 'ops',
    confidence: 0.9,
    ops: [{ op: 'create', shape: 'circle', fill: '#FF4136' }],
    say: '画好了',
  })

  it('合法输出通过，Op 经 zod 校验', () => {
    const r = validateLlmOutput(okOps, 'parse')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result.ops[0]).toMatchObject({ op: 'create', shape: 'circle' })
  })

  it('非 JSON / intent=ops 但 ops 空 → 失败', () => {
    expect(validateLlmOutput('画好了', 'parse').ok).toBe(false)
    expect(validateLlmOutput(JSON.stringify({ intent: 'ops', confidence: 0.9, ops: [], say: 'x' }), 'parse').ok).toBe(false)
  })

  it('clear/undo 来自 LLM → 失败（只能本地产生）', () => {
    const bad = JSON.stringify({ intent: 'ops', confidence: 0.9, ops: [{ op: 'clear' }], say: 'x' })
    const r = validateLlmOutput(bad, 'parse')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('clear')
  })

  it('plan 模式 create 缺 desc / 超 50 个 Op → 失败；≤50 通过', () => {
    const noDesc = JSON.stringify({
      intent: 'ops',
      confidence: 0.9,
      ops: [{ op: 'create', shape: 'circle' }],
      say: 'x',
    })
    expect(validateLlmOutput(noDesc, 'plan').ok).toBe(false)
    const tooMany = JSON.stringify({
      intent: 'ops',
      confidence: 0.9,
      ops: Array.from({ length: 51 }, () => ({ op: 'create', shape: 'circle', desc: 'd' })),
      say: 'x',
    })
    expect(validateLlmOutput(tooMany, 'plan').ok).toBe(false)
    // 多主体放宽：50 个 op 合法（白雪公主+7 矮人需按角色给足）
    const okMany = JSON.stringify({
      intent: 'ops',
      confidence: 0.9,
      ops: Array.from({ length: 50 }, () => ({ op: 'create', shape: 'circle', desc: 'd' })),
      say: 'x',
    })
    expect(validateLlmOutput(okMany, 'plan').ok).toBe(true)
  })

  it('confidence <0.6 的 ops → 转 clarify（§2.3 第 4 条）', () => {
    const low = JSON.stringify({
      intent: 'ops',
      confidence: 0.4,
      ops: [{ op: 'create', shape: 'circle' }],
      say: 'x',
    })
    const r = validateLlmOutput(low, 'parse')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.intent).toBe('clarify')
      expect(r.result.ops).toHaveLength(0)
    }
  })

  it('clarify 输出合法通过', () => {
    const c = JSON.stringify({
      intent: 'clarify',
      confidence: 0.5,
      ops: [],
      say: '',
      clarify: { question: '哪个圆？', expecting: ['红色', '蓝色'] },
    })
    const r = validateLlmOutput(c, 'parse')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result.clarify?.expecting).toEqual(['红色', '蓝色'])
  })
})

describe('parseWithLlm（mock fetch：成功 / 校验失败重试）', () => {
  const ctx = (fetchFn: typeof fetch) => ({ scene: sceneWith(1), fetchFn, baseUrl: 'http://test' })
  const httpOk = (content: string) =>
    new Response(JSON.stringify({ content, latencyMs: 5 }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  it('一次通过：返回 ParseResult，source 随 mode', async () => {
    const fetchFn = vi.fn(async () =>
      httpOk(JSON.stringify({ intent: 'ops', confidence: 0.9, ops: [{ op: 'create', shape: 'circle' }], say: '好了' })),
    ) as unknown as typeof fetch
    const r = await parseWithLlm('画个圆', 'parse', ctx(fetchFn))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.source).toBe('llm-parse')
      expect(r.result.ops).toHaveLength(1)
    }
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('首轮校验失败 → 带 retry 重试一次 → 通过', async () => {
    const calls: unknown[] = []
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return calls.length === 1
        ? httpOk('不是JSON')
        : httpOk(JSON.stringify({ intent: 'ops', confidence: 0.9, ops: [{ op: 'create', shape: 'rect' }], say: '好' }))
    }) as unknown as typeof fetch
    const r = await parseWithLlm('画个方块', 'parse', ctx(fetchFn))
    expect(r.ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const second = calls[1] as { retry?: { previous: string; error: string } }
    expect(second.retry?.previous).toBe('不是JSON')
    expect(second.retry?.error).toBeTruthy()
  })

  it('重试后仍失败 → 返回错误（本轮丢弃，§2.3）', async () => {
    const fetchFn = vi.fn(async () => httpOk('还是不是JSON')) as unknown as typeof fetch
    const r = await parseWithLlm('画个方块', 'parse', ctx(fetchFn))
    expect(r.ok).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('backend 503（未配密钥）→ 返回错误信息', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'LLM_NOT_CONFIGURED', message: '未配置 ARK_API_KEY（火山方舟）' }), { status: 503 }),
    ) as unknown as typeof fetch
    const r = await parseWithLlm('画个圆', 'parse', ctx(fetchFn))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('ARK_API_KEY')
  })
})

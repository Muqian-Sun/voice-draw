/**
 * TTS 编排器单测（协议 §3 半双工 / 兜底策略）。Provider 注入假实现，不碰 DOM Audio。
 */
import { describe, expect, it } from 'vitest'
import { TtsOrchestrator, type TtsProvider } from './tts'

function fakeProvider(name: string, opts: { fail?: number; delay?: number } = {}) {
  let failLeft = opts.fail ?? 0
  const spoken: string[] = []
  const provider: TtsProvider = {
    name,
    async speak(text: string) {
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay))
      if (failLeft > 0) {
        failLeft -= 1
        throw new Error('上游失败')
      }
      spoken.push(text)
    },
    cancel() {},
  }
  return { provider, spoken }
}

describe('TtsOrchestrator', () => {
  it('串行播放：连续 speak 按入队顺序逐条播完', async () => {
    const g = fakeProvider('gateway', { delay: 5 })
    const o = new TtsOrchestrator(g.provider, fakeProvider('webspeech').provider)
    await Promise.all([o.speak('一'), o.speak('二'), o.speak('三')])
    expect(g.spoken).toEqual(['一', '二', '三'])
  })

  it('网关失败单条降级兜底；连续 2 次失败后固定走兜底', async () => {
    const g = fakeProvider('gateway', { fail: 2 })
    const w = fakeProvider('webspeech')
    const logs: string[] = []
    const o = new TtsOrchestrator(g.provider, w.provider, { onLog: (_l, t) => logs.push(t) })
    await o.speak('一')
    expect(w.spoken).toEqual(['一'])
    expect(o.providerName).toBe('gateway') // 1 次失败还没切
    await o.speak('二')
    expect(w.spoken).toEqual(['一', '二'])
    expect(o.providerName).toBe('webspeech') // 连续 2 次 → 固定兜底
    await o.speak('三')
    expect(g.spoken).toEqual([]) // 网关不再被尝试
    expect(w.spoken).toEqual(['一', '二', '三'])
    expect(logs.some((t) => t.includes('speechSynthesis 兜底'))).toBe(true)
  })

  it('网关成功会重置失败计数', async () => {
    const g = fakeProvider('gateway', { fail: 1 })
    const w = fakeProvider('webspeech')
    const o = new TtsOrchestrator(g.provider, w.provider)
    await o.speak('一') // 失败 1 → 兜底
    await o.speak('二') // 成功 → 计数清零
    await o.speak('三')
    expect(g.spoken).toEqual(['二', '三'])
    expect(o.providerName).toBe('gateway')
  })

  it('onSpeakingChange：队列开播 true，播空 false（半双工互斥信号）', async () => {
    const changes: boolean[] = []
    const o = new TtsOrchestrator(fakeProvider('gateway', { delay: 5 }).provider, fakeProvider('w').provider, {
      onSpeakingChange: (s) => changes.push(s),
    })
    const p1 = o.speak('一')
    const p2 = o.speak('二') // 排队期间不应再发 true
    await Promise.all([p1, p2])
    expect(changes).toEqual([true, false])
  })

  it('cancelAll 清空队列并 resolve 等待者', async () => {
    const g = fakeProvider('gateway', { delay: 30 })
    const o = new TtsOrchestrator(g.provider, fakeProvider('w').provider)
    const p1 = o.speak('一')
    const p2 = o.speak('二')
    o.cancelAll() // 「二」尚未开播，应被丢弃
    await Promise.all([p1, p2])
    expect(g.spoken).toEqual(['一'])
  })

  it('空文本直接 resolve，不触发播报', async () => {
    const changes: boolean[] = []
    const o = new TtsOrchestrator(fakeProvider('g').provider, fakeProvider('w').provider, {
      onSpeakingChange: (s) => changes.push(s),
    })
    await o.speak('   ')
    expect(changes).toEqual([])
  })
})

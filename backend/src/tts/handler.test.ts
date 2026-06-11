/**
 * TTS 转发纯函数单测（v1 协议结构/成功码/配置读取）。网络路径由前端编排器测试覆盖语义。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildTtsRequest, parseTtsResponse, readTtsConfig } from './handler.js'

const ENV_KEYS = ['VOLC_TTS_APPID', 'VOLC_TTS_TOKEN', 'VOLC_TTS_VOICE_TYPE', 'VOLC_TTS_CLUSTER', 'VOLC_TTS_SPEED']

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('readTtsConfig', () => {
  it('appid 与 token 都有才算配置；缺省音色/簇/语速', () => {
    expect(readTtsConfig()).toBeNull()
    process.env.VOLC_TTS_APPID = 'app1'
    expect(readTtsConfig()).toBeNull()
    process.env.VOLC_TTS_TOKEN = 'tk1'
    expect(readTtsConfig()).toEqual({
      appid: 'app1',
      token: 'tk1',
      voiceType: 'BV001_streaming',
      cluster: 'volcano_tts',
      speedRatio: 1.0,
    })
  })
})

describe('buildTtsRequest（v1 协议结构）', () => {
  it('app/user/audio/request 四段齐全，operation=query，encoding=mp3', () => {
    const r = buildTtsRequest('画好了', { appid: 'a', token: 't', voiceType: 'BV001_streaming', cluster: 'volcano_tts', speedRatio: 1.1 }, 'rid-1')
    expect(r).toEqual({
      app: { appid: 'a', token: 't', cluster: 'volcano_tts' },
      user: { uid: 'voice-draw' },
      audio: { voice_type: 'BV001_streaming', encoding: 'mp3', speed_ratio: 1.1 },
      request: { reqid: 'rid-1', text: '画好了', operation: 'query' },
    })
  })
})

describe('parseTtsResponse（成功码 3000）', () => {
  it('3000 + base64 → 音频 Buffer', () => {
    const r = parseTtsResponse({ code: 3000, data: Buffer.from('mp3bytes').toString('base64') })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.audio.toString()).toBe('mp3bytes')
  })

  it('非 3000 / 缺 data → 错误带上游信息', () => {
    const r = parseTtsResponse({ code: 3001, message: 'invalid voice' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('3001')
    expect(parseTtsResponse({}).ok).toBe(false)
  })
})

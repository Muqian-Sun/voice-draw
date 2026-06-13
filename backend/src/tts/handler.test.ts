/**
 * TTS 转发纯函数单测（v3 unidirectional 协议结构/流解析/配置读取）。
 * 网络路径由前端编排器测试覆盖语义。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildTtsRequest, parseTtsStream, readTtsConfig } from './handler.js'

const ENV_KEYS = ['VOLC_TTS_APPID', 'VOLC_TTS_TOKEN', 'VOLC_TTS_SPEAKER']

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('readTtsConfig', () => {
  it('appid 与 token 都有才算配置；缺省音色樱桃丸子', () => {
    expect(readTtsConfig()).toBeNull()
    process.env.VOLC_TTS_APPID = 'app1'
    expect(readTtsConfig()).toBeNull()
    process.env.VOLC_TTS_TOKEN = 'tk1'
    expect(readTtsConfig()).toEqual({ appid: 'app1', token: 'tk1', speaker: 'zh_female_yingtaowanzi_mars_bigtts' })
  })
})

describe('buildTtsRequest（v3 协议结构）', () => {
  it('user/req_params 结构，mp3 24k', () => {
    const r = buildTtsRequest('画好了', { appid: 'a', token: 't', speaker: 'zh_female_cancan_mars_bigtts' })
    expect(r).toEqual({
      user: { uid: 'voice-draw' },
      req_params: {
        text: '画好了',
        speaker: 'zh_female_cancan_mars_bigtts',
        audio_params: { format: 'mp3', sample_rate: 24000 },
      },
    })
  })
})

describe('parseTtsStream（JSON-lines 流）', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64')

  it('拼接音频块，跳过句元数据行，结束码停止', () => {
    const body = [
      JSON.stringify({ code: 0, message: '', data: b64('aa') }),
      JSON.stringify({ code: 0, message: '', data: b64('bb') }),
      JSON.stringify({ code: 0, message: '', data: null, sentence: { text: 'x' } }),
      JSON.stringify({ code: 20000000, message: 'OK', data: null }),
    ].join('\n')
    const r = parseTtsStream(body)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.audio.toString()).toBe('aabb')
  })

  it('错误码（如配额/未授权）→ 错误带上游信息', () => {
    const body = JSON.stringify({ code: 45000292, message: 'quota exceeded' })
    const r = parseTtsStream(body)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('45000292')
  })

  it('无音频数据 / 非法行 → 错误', () => {
    expect(parseTtsStream(JSON.stringify({ code: 20000000, message: 'OK' })).ok).toBe(false)
    expect(parseTtsStream('not-json').ok).toBe(false)
  })
})

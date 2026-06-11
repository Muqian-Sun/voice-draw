import { describe, expect, it } from 'vitest'
import { transition, type VoiceEvent, type VoiceState } from './fsm'

describe('主状态机（协议 §4.1）', () => {
  const valid: Array<[VoiceState, VoiceEvent, VoiceState]> = [
    ['idle', 'START_LISTEN', 'listening'],
    ['listening', 'SEGMENT_END', 'parsing'],
    ['parsing', 'PARSE_DONE', 'executing'],
    ['parsing', 'PARSE_FAIL', 'speaking'],
    ['executing', 'EXEC_DONE', 'speaking'],
    ['speaking', 'TTS_END', 'listening'],
    ['listening', 'STOP_LISTEN', 'idle'],
    ['parsing', 'STOP_LISTEN', 'idle'],
    ['executing', 'STOP_LISTEN', 'idle'],
    ['speaking', 'STOP_LISTEN', 'idle'],
  ]
  it.each(valid)('%s --%s--> %s', (from, event, to) => {
    expect(transition(from, event)).toBe(to)
  })

  const invalid: Array<[VoiceState, VoiceEvent]> = [
    ['idle', 'SEGMENT_END'], // 未聆听不可能有断句
    ['idle', 'TTS_END'],
    ['listening', 'PARSE_DONE'],
    ['listening', 'TTS_END'],
    ['parsing', 'SEGMENT_END'], // 解析期间的语音段进缓存队列（§4.1），不驱动状态
    ['executing', 'PARSE_DONE'],
    ['speaking', 'SEGMENT_END'], // 半双工：播报期间不收语音（§3.1）
    ['speaking', 'EXEC_DONE'],
  ]
  it.each(invalid)('非法转移 %s --%s--> null', (from, event) => {
    expect(transition(from, event)).toBeNull()
  })

  it('完整一轮：聆听→断句→解析→执行→播报→回聆听', () => {
    let s: VoiceState = 'idle'
    for (const e of ['START_LISTEN', 'SEGMENT_END', 'PARSE_DONE', 'EXEC_DONE', 'TTS_END'] as VoiceEvent[]) {
      const next = transition(s, e)
      expect(next).not.toBeNull()
      s = next!
    }
    expect(s).toBe('listening')
  })
})

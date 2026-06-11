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

describe('awaitConfirm 确认窗口（协议 §4.3）', () => {
  it('speaking 播完确认问题 → awaitConfirm；普通播完仍回 listening', () => {
    expect(transition('speaking', 'AWAIT_CONFIRM')).toBe('awaitConfirm')
    expect(transition('speaking', 'TTS_END')).toBe('listening')
  })

  it('确认窗口内回答 → parsing（回答经正常理解通道匹配 §2.6 词表）', () => {
    expect(transition('awaitConfirm', 'SEGMENT_END')).toBe('parsing')
  })

  it('5s 超时 → speaking（播报"已取消"）；可随时停止', () => {
    expect(transition('awaitConfirm', 'CONFIRM_TIMEOUT')).toBe('speaking')
    expect(transition('awaitConfirm', 'STOP_LISTEN')).toBe('idle')
  })

  it('AWAIT_CONFIRM 只能从 speaking 进入', () => {
    expect(transition('listening', 'AWAIT_CONFIRM')).toBeNull()
    expect(transition('parsing', 'AWAIT_CONFIRM')).toBeNull()
    expect(transition('idle', 'AWAIT_CONFIRM')).toBeNull()
  })
})

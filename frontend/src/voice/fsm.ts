/**
 * 主状态机（协议 §4.1）
 *
 *   idle ──START_LISTEN──▶ listening ──SEGMENT_END──▶ parsing ──PARSE_DONE──▶ executing
 *     ▲                        ▲  ▲                      │                        │
 *     └──────STOP_LISTEN───────┘  │                      │ PARSE_FAIL             │ EXEC_DONE
 *        （任意状态可停止）        └────TTS_END──── speaking ◀────────────────────┘
 *
 * 失败路径：解析失败 → speaking（播报"没听懂"）→ TTS_END → listening。
 * AWAIT_CONFIRM（破坏性操作确认）是 speaking 的子态，随计划 PR #16 引入。
 */
export type VoiceState = 'idle' | 'listening' | 'parsing' | 'executing' | 'speaking'

export type VoiceEvent =
  | 'START_LISTEN' // 用户开启语音（麦克风授权完成）
  | 'STOP_LISTEN' // 用户关闭语音（任意状态可用）
  | 'SEGMENT_END' // VAD 判定句尾，进入解析
  | 'PARSE_DONE' // 解析得到 ops，进入执行
  | 'PARSE_FAIL' // 解析失败/拒识，直接进入播报
  | 'EXEC_DONE' // 执行完成（成功或部分失败），进入播报
  | 'TTS_END' // 播报结束，回到聆听

const TRANSITIONS: Record<VoiceState, Partial<Record<VoiceEvent, VoiceState>>> = {
  idle: { START_LISTEN: 'listening' },
  listening: { SEGMENT_END: 'parsing', STOP_LISTEN: 'idle' },
  parsing: { PARSE_DONE: 'executing', PARSE_FAIL: 'speaking', STOP_LISTEN: 'idle' },
  executing: { EXEC_DONE: 'speaking', STOP_LISTEN: 'idle' },
  speaking: { TTS_END: 'listening', STOP_LISTEN: 'idle' },
}

/** 返回新状态；非法转移返回 null（调用方决定忽略或告警） */
export function transition(state: VoiceState, event: VoiceEvent): VoiceState | null {
  return TRANSITIONS[state][event] ?? null
}

export const STATE_LABELS: Record<VoiceState, string> = {
  idle: '待机',
  listening: '聆听中',
  parsing: '解析中',
  executing: '执行中',
  speaking: '播报中',
}

/**
 * 主状态机（协议 §4.1 / §4.3）
 *
 *   idle ──START_LISTEN──▶ listening ──SEGMENT_END──▶ parsing ──PARSE_DONE──▶ executing
 *     ▲                        ▲  ▲                    ▲  │                       │
 *     └──────STOP_LISTEN───────┘  │                    │  │ PARSE_FAIL            │ EXEC_DONE
 *        （任意状态可停止）        └────TTS_END──── speaking ◀───────────────────┘
 *                                                      │  ▲
 *                                  AWAIT_CONFIRM       ▼  │ CONFIRM_TIMEOUT（5s 视为取消）
 *                              （确认问题播完）  awaitConfirm ──SEGMENT_END──▶ parsing
 *
 * 失败路径：解析失败 → speaking（播报"没听懂"）→ TTS_END → listening。
 * awaitConfirm（协议 §4.3 破坏性操作确认窗口）：确认问题播完后进入，
 * 用户的回答经 SEGMENT_END 正常进解析（§2.6 词表匹配在理解层），5s 无回答视为取消。
 */
export type VoiceState = 'idle' | 'listening' | 'parsing' | 'executing' | 'speaking' | 'awaitConfirm'

export type VoiceEvent =
  | 'START_LISTEN' // 用户开启语音（麦克风授权完成）
  | 'STOP_LISTEN' // 用户关闭语音（任意状态可用）
  | 'SEGMENT_END' // VAD 判定句尾，进入解析
  | 'PARSE_DONE' // 解析得到 ops，进入执行
  | 'PARSE_FAIL' // 解析失败/拒识，直接进入播报
  | 'EXEC_DONE' // 执行完成（成功或部分失败），进入播报
  | 'TTS_END' // 播报结束，回到聆听
  | 'AWAIT_CONFIRM' // 确认问题播完，进入确认窗口（协议 §4.3）
  | 'CONFIRM_TIMEOUT' // 确认窗口超时 → 播报"已取消"

const TRANSITIONS: Record<VoiceState, Partial<Record<VoiceEvent, VoiceState>>> = {
  idle: { START_LISTEN: 'listening' },
  listening: { SEGMENT_END: 'parsing', STOP_LISTEN: 'idle' },
  parsing: { PARSE_DONE: 'executing', PARSE_FAIL: 'speaking', STOP_LISTEN: 'idle' },
  executing: { EXEC_DONE: 'speaking', STOP_LISTEN: 'idle' },
  speaking: { TTS_END: 'listening', AWAIT_CONFIRM: 'awaitConfirm', STOP_LISTEN: 'idle' },
  awaitConfirm: { SEGMENT_END: 'parsing', CONFIRM_TIMEOUT: 'speaking', STOP_LISTEN: 'idle' },
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
  awaitConfirm: '等待确认',
}

/** 确认窗口时长（协议 §4.3：超时视为取消） */
export const CONFIRM_WINDOW_MS = 5000

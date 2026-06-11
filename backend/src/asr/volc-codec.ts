/**
 * 火山引擎豆包流式 ASR —— WebSocket 二进制帧编解码
 * 协议依据：官方文档《大模型流式语音识别API》（volcengine.com/docs/6561/1354869）
 *
 * 帧结构：4 字节 header + [4 字节 sequence（按 flags）] + 4 字节 payload size（大端）+ payload
 * header：| ver(4b) headerSize(4b) | msgType(4b) flags(4b) | serialization(4b) compression(4b) | reserved(8b) |
 * 本实现发送端不压缩（compression=none），服务端按客户端方式回包；解码端对 gzip 做防御性兼容。
 */
import { gunzipSync } from 'node:zlib'

export const MSG_FULL_CLIENT = 0b0001
export const MSG_AUDIO_ONLY = 0b0010
export const MSG_FULL_SERVER = 0b1001
export const MSG_ERROR = 0b1111

export const FLAG_NONE = 0b0000
export const FLAG_LAST = 0b0010 // 最后一包（负包），不带 sequence

const SERIAL_NONE = 0b0000
const SERIAL_JSON = 0b0001
const COMPRESS_NONE = 0b0000
const COMPRESS_GZIP = 0b0001

function header(type: number, flags: number, serialization: number): Buffer {
  return Buffer.from([0x11, (type << 4) | flags, (serialization << 4) | COMPRESS_NONE, 0x00])
}

/** 建连后的第一包：识别配置（JSON 序列化，不压缩） */
export function encodeFullClientRequest(payload: object): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const size = Buffer.alloc(4)
  size.writeUInt32BE(body.length)
  return Buffer.concat([header(MSG_FULL_CLIENT, FLAG_NONE, SERIAL_JSON), size, body])
}

/** 音频包（裸 PCM）；isLast=true 时标记为最后一包（负包） */
export function encodeAudioPacket(pcm: Buffer, isLast: boolean): Buffer {
  const size = Buffer.alloc(4)
  size.writeUInt32BE(pcm.length)
  return Buffer.concat([header(MSG_AUDIO_ONLY, isLast ? FLAG_LAST : FLAG_NONE, SERIAL_NONE), size, pcm])
}

export interface VolcAsrPayload {
  result?: {
    text?: string
    utterances?: Array<{ text: string; definite?: boolean; start_time?: number; end_time?: number }>
  }
  audio_info?: { duration?: number }
}

export type VolcServerMessage =
  | { kind: 'response'; isLast: boolean; sequence?: number; payload: VolcAsrPayload }
  | { kind: 'error'; code: number; message: string }

export function decodeServerMessage(data: Buffer): VolcServerMessage {
  const headerSize = (data[0] & 0x0f) * 4
  const type = (data[1] >> 4) & 0x0f
  const flags = data[1] & 0x0f
  const compression = data[2] & 0x0f
  let offset = headerSize

  if (type === MSG_ERROR) {
    const code = data.readUInt32BE(offset)
    offset += 4
    const size = data.readUInt32BE(offset)
    offset += 4
    let body = data.subarray(offset, offset + size)
    if (compression === COMPRESS_GZIP) body = gunzipSync(body)
    return { kind: 'error', code, message: body.toString('utf8') }
  }

  // full server response：flags 低位为 1 时 header 后是 4 字节 sequence
  let sequence: number | undefined
  if (flags & 0b0001) {
    sequence = data.readInt32BE(offset)
    offset += 4
  }
  const size = data.readUInt32BE(offset)
  offset += 4
  let body = data.subarray(offset, offset + size)
  if (compression === COMPRESS_GZIP) body = gunzipSync(body)
  const payload = (body.length > 0 ? JSON.parse(body.toString('utf8')) : {}) as VolcAsrPayload
  // flags 第 2 位（0b0010/0b0011）= 最后一包结果
  return { kind: 'response', isLast: (flags & 0b0010) !== 0, sequence, payload }
}

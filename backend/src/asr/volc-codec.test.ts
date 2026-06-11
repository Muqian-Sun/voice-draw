import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeServerMessage, encodeAudioPacket, encodeFullClientRequest } from './volc-codec.js'

describe('火山 ASR 二进制帧编码（官方协议 header 布局）', () => {
  it('full client request：JSON 序列化、不压缩、大端长度', () => {
    const buf = encodeFullClientRequest({ a: 1 })
    // ver1+headerSize1 / type=0001 flags=0000 / serial=JSON compress=none / reserved
    expect([...buf.subarray(0, 4)]).toEqual([0x11, 0x10, 0x10, 0x00])
    const size = buf.readUInt32BE(4)
    expect(size).toBe(buf.length - 8)
    expect(JSON.parse(buf.subarray(8).toString('utf8'))).toEqual({ a: 1 })
  })

  it('audio packet 非末包：type=0010 flags=0000，裸负载', () => {
    const pcm = Buffer.from([1, 2, 3, 4])
    const buf = encodeAudioPacket(pcm, false)
    expect([...buf.subarray(0, 4)]).toEqual([0x11, 0x20, 0x00, 0x00])
    expect(buf.readUInt32BE(4)).toBe(4)
    expect([...buf.subarray(8)]).toEqual([1, 2, 3, 4])
  })

  it('audio packet 末包（负包）：flags=0010，允许空负载', () => {
    const buf = encodeAudioPacket(Buffer.alloc(0), true)
    expect([...buf.subarray(0, 4)]).toEqual([0x11, 0x22, 0x00, 0x00])
    expect(buf.readUInt32BE(4)).toBe(0)
  })
})

function buildServerResponse(flags: number, payload: object, opts?: { gzip?: boolean; sequence?: number }) {
  let body = Buffer.from(JSON.stringify(payload), 'utf8')
  if (opts?.gzip) body = gzipSync(body)
  const header = Buffer.from([0x11, (0b1001 << 4) | flags, (0b0001 << 4) | (opts?.gzip ? 0b0001 : 0), 0x00])
  const parts: Buffer[] = [header]
  if (flags & 0b0001) {
    const seq = Buffer.alloc(4)
    seq.writeInt32BE(opts?.sequence ?? 1)
    parts.push(seq)
  }
  const size = Buffer.alloc(4)
  size.writeUInt32BE(body.length)
  parts.push(size, body)
  return Buffer.concat(parts)
}

describe('火山 ASR 服务端响应解码', () => {
  it('中间响应（带正 sequence）→ partial 文本', () => {
    const msg = decodeServerMessage(buildServerResponse(0b0001, { result: { text: '画一个' } }, { sequence: 2 }))
    expect(msg).toMatchObject({ kind: 'response', isLast: false, sequence: 2 })
    if (msg.kind === 'response') expect(msg.payload.result?.text).toBe('画一个')
  })

  it('末包响应（flags=0011，负 sequence）→ isLast', () => {
    const msg = decodeServerMessage(
      buildServerResponse(0b0011, { result: { text: '画一个红色的圆。' } }, { sequence: -3 }),
    )
    expect(msg).toMatchObject({ kind: 'response', isLast: true, sequence: -3 })
  })

  it('末包响应（flags=0010，无 sequence）→ isLast', () => {
    const msg = decodeServerMessage(buildServerResponse(0b0010, { result: { text: '完' } }))
    expect(msg).toMatchObject({ kind: 'response', isLast: true, sequence: undefined })
  })

  it('gzip 压缩的响应可解（防御性兼容）', () => {
    const msg = decodeServerMessage(buildServerResponse(0b0001, { result: { text: '压缩' } }, { gzip: true, sequence: 1 }))
    if (msg.kind === 'response') expect(msg.payload.result?.text).toBe('压缩')
  })

  it('错误帧：code + UTF8 消息', () => {
    const errMsg = Buffer.from('invalid request', 'utf8')
    const header = Buffer.from([0x11, 0xf0, 0x10, 0x00])
    const code = Buffer.alloc(4)
    code.writeUInt32BE(45000001)
    const size = Buffer.alloc(4)
    size.writeUInt32BE(errMsg.length)
    const msg = decodeServerMessage(Buffer.concat([header, code, size, errMsg]))
    expect(msg).toEqual({ kind: 'error', code: 45000001, message: 'invalid request' })
  })
})

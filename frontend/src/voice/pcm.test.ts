import { describe, expect, it } from 'vitest'
import { float32ToPcm16Base64 } from './pcm'

const decode = (b64: string) => {
  const buf = Buffer.from(b64, 'base64')
  const out: number[] = []
  for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i))
  return out
}

describe('float32 → pcm16 base64（协议 §3.2 音频帧格式）', () => {
  it('满幅正负与静音', () => {
    expect(decode(float32ToPcm16Base64(new Float32Array([1, -1, 0])))).toEqual([0x7fff, -0x8000, 0])
  })

  it('半幅与小端字节序', () => {
    const [half] = decode(float32ToPcm16Base64(new Float32Array([0.5])))
    expect(half).toBe(Math.floor(0.5 * 0x7fff))
  })

  it('越界值截断到 ±1', () => {
    expect(decode(float32ToPcm16Base64(new Float32Array([2.5, -3])))).toEqual([0x7fff, -0x8000])
  })

  it('512 样本帧（VAD 帧长）输出 1024 字节', () => {
    const b64 = float32ToPcm16Base64(new Float32Array(512))
    expect(Buffer.from(b64, 'base64').length).toBe(1024)
  })
})

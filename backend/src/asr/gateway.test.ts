import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { attachAsrGateway } from './gateway.js'
import type { ServerMsg } from './protocol.js'

let server: Server
let url = ''

beforeAll(async () => {
  server = createServer()
  attachAsrGateway(server)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const addr = server.address()
  if (typeof addr === 'object' && addr) url = `ws://127.0.0.1:${addr.port}/asr`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

/** 测试客户端：收集服务端消息，可等待指定类型出现 */
async function openClient() {
  const ws = new WebSocket(url)
  const received: ServerMsg[] = []
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const waitFor = (type: ServerMsg['type'], timeoutMs = 1500) =>
    new Promise<ServerMsg>((resolve, reject) => {
      const t0 = Date.now()
      const timer = setInterval(() => {
        const hit = received.find((m) => m.type === type)
        if (hit) {
          clearInterval(timer)
          resolve(hit)
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer)
          reject(new Error(`等待 ${type} 超时，已收到：${JSON.stringify(received)}`))
        }
      }, 10)
    })
  return { ws, received, waitFor, send: (m: unknown) => ws.send(JSON.stringify(m)) }
}

/** 20ms@16kHz/16bit 单声道静音帧（640 字节） */
const FRAME = Buffer.alloc(640).toString('base64')
const START = { type: 'start', format: 'pcm16', sampleRate: 16000, lang: 'zh' }

describe('ASR WebSocket 网关（协议 §3.2）', () => {
  it('start → ready；推流出 partial（final 文本递增前缀）；stop → final', async () => {
    const c = await openClient()
    c.send(START)
    await c.waitFor('ready')

    for (let i = 0; i < 30; i++) c.send({ type: 'audio', seq: i, data: FRAME })
    const partial = (await c.waitFor('partial')) as Extract<ServerMsg, { type: 'partial' }>
    expect('画一个圆'.startsWith(partial.text)).toBe(true)
    expect(partial.text.length).toBeGreaterThan(0)

    c.send({ type: 'stop' })
    const final = (await c.waitFor('final')) as Extract<ServerMsg, { type: 'final' }>
    expect(final.text).toBe('画一个圆') // MOCK_ASR_FINAL 缺省值
    expect(final.confidence).toBeGreaterThan(0)
    expect(Array.isArray(final.alternatives)).toBe(true)
    c.ws.close()
  })

  it('未 start 先 audio → NOT_STARTED（recoverable）', async () => {
    const c = await openClient()
    c.send({ type: 'audio', seq: 0, data: FRAME })
    const e = (await c.waitFor('error')) as Extract<ServerMsg, { type: 'error' }>
    expect(e.code).toBe('NOT_STARTED')
    expect(e.recoverable).toBe(true)
    c.ws.close()
  })

  it('非 JSON / 不符协议的消息 → BAD_MESSAGE', async () => {
    const c = await openClient()
    c.ws.send('not-json{{{')
    const e1 = (await c.waitFor('error')) as Extract<ServerMsg, { type: 'error' }>
    expect(e1.code).toBe('BAD_MESSAGE')

    c.received.length = 0
    c.send({ type: 'start', format: 'mp3', sampleRate: 44100 }) // 协议外采样率/格式
    const e2 = (await c.waitFor('error')) as Extract<ServerMsg, { type: 'error' }>
    expect(e2.code).toBe('BAD_MESSAGE')
    c.ws.close()
  })

  it('二进制帧 → BAD_MESSAGE（协议为 JSON 文本 + base64）', async () => {
    const c = await openClient()
    c.ws.send(Buffer.alloc(640))
    const e = (await c.waitFor('error')) as Extract<ServerMsg, { type: 'error' }>
    expect(e.code).toBe('BAD_MESSAGE')
    c.ws.close()
  })

  it('重复 start 重置会话后链路仍可用', async () => {
    const c = await openClient()
    c.send(START)
    await c.waitFor('ready')
    c.received.length = 0
    c.send(START) // 重置
    await c.waitFor('ready')
    for (let i = 0; i < 15; i++) c.send({ type: 'audio', seq: i, data: FRAME })
    c.send({ type: 'stop' })
    await c.waitFor('final')
    c.ws.close()
  })
})

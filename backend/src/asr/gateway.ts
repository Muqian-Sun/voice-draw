/**
 * ASR WebSocket 网关（协议 §3.2）：密钥隔离 + 协议适配，无业务状态。
 * 每个连接一个会话：start 建立上游 → audio 帧转发 → stop 触发 final → 连接断开释放上游。
 */
import type { Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { clientMsgSchema, type ServerMsg } from './protocol.js'
import { createUpstreamFactory, type AsrUpstream } from './upstream.js'

export function attachAsrGateway(server: HttpServer, path = '/asr'): WebSocketServer {
  const wss = new WebSocketServer({ server, path })
  const factory = createUpstreamFactory()

  wss.on('connection', (ws: WebSocket) => {
    let upstream: AsrUpstream | null = null

    const send = (m: ServerMsg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
    }

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        send({ type: 'error', code: 'BAD_MESSAGE', recoverable: true })
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString())
      } catch {
        send({ type: 'error', code: 'BAD_MESSAGE', recoverable: true })
        return
      }
      const msg = clientMsgSchema.safeParse(parsed)
      if (!msg.success) {
        send({ type: 'error', code: 'BAD_MESSAGE', recoverable: true })
        return
      }

      switch (msg.data.type) {
        case 'start':
          upstream?.close() // 重复 start = 重置会话
          upstream = factory({
            onPartial: (text) => send({ type: 'partial', text }),
            onFinal: (r) => send({ type: 'final', ...r }),
            onError: (code, recoverable) => send({ type: 'error', code, recoverable }),
          })
          send({ type: 'ready' })
          break
        case 'audio':
          if (!upstream) {
            send({ type: 'error', code: 'NOT_STARTED', recoverable: true })
            return
          }
          upstream.sendAudio(Buffer.from(msg.data.data, 'base64'))
          break
        case 'stop':
          upstream?.stop()
          break
      }
    })

    ws.on('close', () => {
      upstream?.close()
      upstream = null
    })
  })

  return wss
}

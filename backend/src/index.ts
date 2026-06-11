import 'dotenv/config'
import { createServer } from 'node:http'
import express from 'express'
import { attachAsrGateway } from './asr/gateway.js'
import { isVolcConfigured } from './asr/volc.js'

const app = express()
const port = Number(process.env.PORT ?? 8787)

app.use(express.json())

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    service: 'voice-draw-backend',
    // 密钥缺失时自动降级（ASR→mock 上游；前端可再降 WebSpeech），此字段供探测
    asrUpstream: isVolcConfigured() ? 'volc' : 'mock',
    llmConfigured: Boolean(process.env.QINIU_API_KEY),
  })
})

const server = createServer(app)
attachAsrGateway(server) // ws://host:PORT/asr（协议 §3.2）

server.listen(port, () => {
  console.log(`[backend] listening on http://localhost:${port}（ASR 网关 ws://localhost:${port}/asr）`)
})

import 'dotenv/config'
import { createServer } from 'node:http'
import express from 'express'
import { attachAsrGateway } from './asr/gateway.js'
import { isVolcConfigured } from './asr/volc.js'
import { handleLlmParse, isLlmConfigured } from './llm/handler.js'
import { handleTts, isTtsConfigured } from './tts/handler.js'

const app = express()
const port = Number(process.env.PORT ?? 8787)

app.use(express.json({ limit: '256kb' }))

// 前端 dev server（5173）跨端口调用 HTTP 接口；本地工具，放开即可
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
})

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    service: 'voice-draw-backend',
    // 密钥缺失时自动降级（ASR→mock 上游；前端可再降 WebSpeech），此字段供探测
    asrUpstream: isVolcConfigured() ? 'volc' : 'mock',
    llmConfigured: isLlmConfigured(),
    ttsConfigured: isTtsConfigured(),
  })
})

app.post('/api/llm/parse', handleLlmParse) // 协议 §2：LLM 转发（密钥隔离）
// 协议 §3：TTS 转发（豆包语音合成 2.0，分块流式）。GET 供前端 <audio src> 渐进播放，POST 兼容旧契约
app.get('/api/tts', handleTts)
app.post('/api/tts', handleTts)

const server = createServer(app)
attachAsrGateway(server) // ws://host:PORT/asr（协议 §3.2）

server.listen(port, () => {
  console.log(`[backend] listening on http://localhost:${port}（ASR 网关 ws://localhost:${port}/asr）`)
})

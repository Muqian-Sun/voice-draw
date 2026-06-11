import 'dotenv/config'
import express from 'express'

const app = express()
const port = Number(process.env.PORT ?? 8787)

app.use(express.json())

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    service: 'voice-draw-backend',
    // 密钥缺失时前端会降级（WebSpeech / 调试面板），此字段供前端探测
    qiniuConfigured: Boolean(process.env.QINIU_API_KEY),
  })
})

app.listen(port, () => {
  console.log(`[backend] listening on http://localhost:${port}`)
})

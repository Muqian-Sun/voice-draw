/**
 * 自由画笔 · 绘制过程演示（research：feat/freehand-pen）
 * 在画布上用「会动的笔」逐笔把一幅墨线速写画出来——演示自由画笔引擎：
 * 变宽墨带 + 弧长匀速运笔 + 渐进显墨 + 笔尖沿轨迹移动 + 抬笔换行。
 * 访问 http://localhost:5174/?freehand 查看。
 */
import { useEffect, useRef, useState } from 'react'
import { getStroke } from 'perfect-freehand'
import {
  cumulativeLengths,
  densifyLinear,
  roughen,
  sampleCenterline,
  sliceUpTo,
  tipAt,
  type Pt,
  type Stroke,
} from './engine'

const W = 1024
const H = 768
const INK = '#2b2b2b'

/** 椭圆弧采样（生成 demo 笔画的锚点） */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n: number): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Pt
  })
}

/** demo：一只墨线速写小猫（每个元素是一"笔"，按数组顺序逐笔画出） */
export const CAT_DEMO: Stroke[] = [
  { pts: arc(512, 392, 150, 140, -Math.PI / 2, -Math.PI / 2 + Math.PI * 1.96, 26), color: INK, width: 9, taper: true },
  { pts: [[430, 282], [402, 200], [486, 258]], color: INK, width: 9, taper: true },
  { pts: [[594, 282], [622, 200], [538, 258]], color: INK, width: 9, taper: true },
  { pts: arc(458, 372, 17, 22, 0, Math.PI * 2, 16), closed: true, color: INK, fill: '#222', width: 3 },
  { pts: arc(566, 372, 17, 22, 0, Math.PI * 2, 16), closed: true, color: INK, fill: '#222', width: 3 },
  { pts: arc(478, 366, 5, 6, 0, Math.PI * 2, 10), closed: true, color: '#fff', fill: '#fff', width: 1 },
  { pts: arc(586, 366, 5, 6, 0, Math.PI * 2, 10), closed: true, color: '#fff', fill: '#fff', width: 1 },
  { pts: [[512, 410], [500, 400], [524, 400]], closed: true, color: '#E07090', fill: '#F4A0BC', width: 2 },
  { pts: [[490, 430], [512, 444], [534, 430]], color: INK, width: 5, taper: true },
  { pts: [[466, 408], [388, 398]], color: INK, width: 3, taper: true },
  { pts: [[466, 420], [390, 426]], color: INK, width: 3, taper: true },
  { pts: [[558, 408], [636, 398]], color: INK, width: 3, taper: true },
  { pts: [[558, 420], [634, 426]], color: INK, width: 3, taper: true },
]

interface Prepared {
  s: Stroke
  pts: Pt[]
  cum: number[]
  total: number
}

const SPEED = 920 // 运笔速度 px/s
const TRAVEL_S = 0.3 // 抬笔换行时长
const ease = (t: number) => t * t * (3 - 2 * t)
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

export function FreehandStage({
  strokes = CAT_DEMO,
  title,
  roughness = 0,
}: {
  strokes?: Stroke[]
  title?: string
  roughness?: number // 手绘抖动幅度 px（缺省 0=直线笔直、圆顺滑；>0 才加手画弓形感，可选）
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [runId, setRunId] = useState(0)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = Math.max(2, window.devicePixelRatio || 1)
    cv.width = W * dpr
    cv.height = H * dpr
    setDone(false)

    const prep: Prepared[] = strokes.map((s, i) => {
      // 先手绘抖动（确定性 seed=笔序，逐帧稳定），再平滑/稠密化
      const anchors = roughen(s.pts, s.closed ?? false, roughness, i * 0x9e3779b1 + 1)
      // smooth=false（多边形/矩形）走线性稠密化保棱角；否则向心 CR 平滑
      const pts =
        s.smooth === false ? densifyLinear(anchors, s.closed ?? false, 7) : sampleCenterline(anchors, s.closed ?? false, 18)
      const cum = cumulativeLengths(pts)
      return { s, pts, cum, total: cum[cum.length - 1] }
    })

    let strokeI = 0
    let drawn = 0
    let mode: 'draw' | 'travel' | 'end' = 'draw'
    let travelT = 0
    let penFrom: Pt = prep[0].pts[0]
    let penTo: Pt = prep[0].pts[0]
    let last = 0
    let raf = 0

    const paintStroke = (p: Prepared, L: number) => {
      const slice = sliceUpTo(p.pts, p.cum, L)
      if (slice.length < 2) return
      if (p.s.closed && L >= p.total) {
        // 闭合完成：先填充内部，再描墨边
        ctx.beginPath()
        ctx.moveTo(p.pts[0][0], p.pts[0][1])
        for (const pt of p.pts) ctx.lineTo(pt[0], pt[1])
        ctx.closePath()
        if (p.s.fill) {
          ctx.fillStyle = p.s.fill
          ctx.fill()
        }
        ctx.lineWidth = p.s.width ?? 6
        ctx.strokeStyle = p.s.color ?? INK
        ctx.lineJoin = 'round'
        ctx.stroke()
        return
      }
      // 开放笔画（或闭合显墨中）：perfect-freehand 生成变宽墨带轮廓（尖角不夹断、含笔帽/收笔/速度模拟压感）
      const w = p.s.width ?? 8
      const taper = p.s.taper !== false
      const outline = getStroke(slice as number[][], {
        size: w,
        thinning: taper ? 0.55 : 0.2,
        smoothing: 0.5,
        streamline: 0.15,
        simulatePressure: true,
        last: L >= p.total,
        start: { cap: !taper, taper: taper ? w * 3 : 0 },
        end: { cap: !taper, taper: taper ? w * 3 : 0 },
      })
      if (outline.length < 3) return
      ctx.beginPath()
      ctx.moveTo(outline[0][0], outline[0][1])
      for (const pt of outline) ctx.lineTo(pt[0], pt[1])
      ctx.closePath()
      ctx.fillStyle = p.s.color ?? INK
      ctx.fill()
    }

    const drawPen = (pos: Pt, lifted: boolean) => {
      ctx.save()
      if (lifted) {
        // 抬笔投影
        ctx.save()
        ctx.fillStyle = 'rgba(40,32,24,0.16)'
        ctx.beginPath()
        ctx.ellipse(pos[0] + 6, pos[1] + 10, 9, 4, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
      ctx.translate(pos[0], pos[1] - (lifted ? 9 : 0))
      ctx.rotate(-0.52)
      // 笔尖
      ctx.fillStyle = '#1c1c1c'
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(-5, -17)
      ctx.lineTo(5, -17)
      ctx.closePath()
      ctx.fill()
      // 金属箍
      ctx.fillStyle = '#cfc8b8'
      ctx.fillRect(-6, -23, 12, 6)
      // 笔杆
      ctx.fillStyle = '#E8743B'
      ctx.beginPath()
      ctx.moveTo(-6, -23)
      ctx.lineTo(6, -23)
      ctx.lineTo(6, -66)
      ctx.quadraticCurveTo(0, -74, -6, -66)
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    }

    const render = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#f6f0e4'
      ctx.fillRect(0, 0, W, H)
      // 已完成的笔（travel 时含刚画完、尚未自增 strokeI 的当前笔——否则换行间隙它会短暂消失）
      const doneCount = mode === 'end' ? prep.length : mode === 'travel' ? strokeI + 1 : strokeI
      for (let i = 0; i < doneCount; i++) paintStroke(prep[i], prep[i].total)
      // 笔尖位置
      let penPos: Pt = penFrom
      let lifted = false
      if (mode === 'draw' && strokeI < prep.length) {
        paintStroke(prep[strokeI], drawn)
        penPos = tipAt(prep[strokeI].pts, prep[strokeI].cum, drawn).pt
      } else if (mode === 'travel') {
        penPos = lerp(penFrom, penTo, ease(Math.min(1, travelT)))
        lifted = true
      }
      if (mode !== 'end') drawPen(penPos, lifted)
    }

    const frame = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      if (mode === 'draw') {
        drawn += SPEED * dt
        const cur = prep[strokeI]
        if (drawn >= cur.total) {
          drawn = cur.total
          penFrom = cur.pts[cur.pts.length - 1]
          const next = prep[strokeI + 1]
          if (next) {
            penTo = next.pts[0]
            mode = 'travel'
            travelT = 0
          } else {
            mode = 'end'
          }
        }
      } else if (mode === 'travel') {
        travelT += dt / TRAVEL_S
        if (travelT >= 1) {
          strokeI++
          drawn = 0
          mode = 'draw'
        }
      }
      render()
      if (mode === 'end') {
        setDone(true)
        return
      }
      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [runId, strokes, roughness])

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#efe9dd',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
        padding: '28px 16px',
        fontFamily: 'ui-monospace, monospace',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <strong style={{ fontSize: 22, letterSpacing: 1 }}>自由画笔 · FREEHAND</strong>
        <span style={{ color: '#8a8170', fontSize: 13 }}>
          {title ?? 'research / feat/freehand-pen — 变宽墨带 · 弧长运笔 · 渐进显墨 · 笔尖动画'}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        style={{
          width: 'min(92vw, 980px)',
          aspectRatio: `${W} / ${H}`,
          height: 'auto',
          borderRadius: 10,
          boxShadow: '14px 14px 0 0 #1FA6A0, 14px 14px 0 2px #2b2b2b, 0 12px 28px rgba(40,32,24,0.18)',
          background: '#f6f0e4',
        }}
      />
      <button
        onClick={() => setRunId((n) => n + 1)}
        style={{
          padding: '8px 20px',
          fontSize: 14,
          fontFamily: 'inherit',
          border: '2px solid #2b2b2b',
          borderRadius: 8,
          background: done ? '#FFD23F' : '#fff',
          cursor: 'pointer',
        }}
      >
        {done ? '↻ 重画一遍' : '绘制中…'}
      </button>
    </div>
  )
}

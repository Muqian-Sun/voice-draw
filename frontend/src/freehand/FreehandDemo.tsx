/**
 * 自由画笔演示（research）：两种 stroke 来源对照
 *  ① 手绘示例（CAT_DEMO，人工编排笔触）
 *  ② 组件引擎场景重绘——用真实 DSL 管线（parseOps→executeTransaction）产出 SceneObject[]，
 *     再 sceneToStrokes 拆成笔触，由自由画笔逐笔"手绘"出来。证明"组件引擎决定画什么 +
 *     自由画笔决定怎么画出来"的桥接。访问 http://localhost:5174/?freehand 查看。
 */
import { useMemo, useState } from 'react'
import { parseOps } from '../dsl'
import { executeTransaction } from '../engine/interpreter'
import { createEmptyScene } from '../engine/scene'
import { CAT_DEMO, FreehandStage } from './FreehandStage'
import { sceneToStrokes } from './fromScene'
import type { Stroke } from './engine'

/** 一段真实 DSL（组件引擎眼中的"一幅画"）：太阳/云/树/房子，绝对定位免相对解析 */
const SCENE_OPS = [
  { op: 'create', shape: 'circle', name: '太阳', fill: '#FFD23F', stroke: '#E0A21E', strokeWidth: 3, at: { x: 840, y: 140 }, size: 64 },
  { op: 'create', shape: 'ellipse', name: '云', fill: '#FFFFFF', stroke: '#C9D4DE', strokeWidth: 2, at: { x: 250, y: 150 }, width: 180, height: 92 },
  { op: 'create', shape: 'rect', name: '树干', fill: '#8B5A2B', at: { x: 175, y: 540 }, width: 34, height: 150 },
  { op: 'create', shape: 'circle', name: '树冠', fill: '#7BBF5A', stroke: '#4E8A35', strokeWidth: 3, at: { x: 175, y: 420 }, size: 82 },
  { op: 'create', shape: 'rect', name: '房子', fill: '#F2A65A', stroke: '#C77B3B', strokeWidth: 3, at: { x: 540, y: 470 }, width: 280, height: 200 },
  { op: 'create', shape: 'triangle', name: '屋顶', fill: '#E2574C', stroke: '#A83A30', strokeWidth: 3, at: { x: 540, y: 320 }, size: 185 },
  { op: 'create', shape: 'rect', name: '门', fill: '#8B5A2B', stroke: '#5E3C1C', strokeWidth: 2, at: { x: 540, y: 525 }, width: 62, height: 110 },
  { op: 'create', shape: 'rect', name: '窗', fill: '#7FB6E8', stroke: '#3B6FA0', strokeWidth: 2, at: { x: 640, y: 435 }, width: 58, height: 58 },
]

function buildSceneStrokes(): Stroke[] {
  const parsed = parseOps(SCENE_OPS)
  if (!parsed.ok) return []
  return sceneToStrokes(executeTransaction(createEmptyScene(), parsed.ops).state)
}

export function FreehandDemo() {
  const [mode, setMode] = useState<'cat' | 'scene'>('scene')
  const sceneStrokes = useMemo(buildSceneStrokes, [])

  const tab = (m: 'cat' | 'scene', label: string) => (
    <button
      onClick={() => setMode(m)}
      style={{
        padding: '6px 14px',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 13,
        border: '2px solid #2b2b2b',
        borderRadius: 8,
        background: mode === m ? '#1FA6A0' : '#fff',
        color: mode === m ? '#fff' : '#2b2b2b',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )

  return (
    <div>
      <div style={{ position: 'fixed', top: 10, right: 14, zIndex: 10, display: 'flex', gap: 8 }}>
        {tab('scene', '组件引擎场景 → 重绘')}
        {tab('cat', '手绘示例')}
      </div>
      <FreehandStage
        key={mode}
        strokes={mode === 'cat' ? CAT_DEMO : sceneStrokes}
        title={
          mode === 'cat'
            ? '手绘示例 — 人工编排笔触'
            : '组件引擎场景 → sceneToStrokes → 自由画笔逐笔重绘（真实 DSL 管线产出）'
        }
      />
    </div>
  )
}

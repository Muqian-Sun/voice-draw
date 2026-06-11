/**
 * 文本调试面板（架构文档 M0 验收项）
 *
 * 用途：整个开发期不依赖语音验证主链路——文本灌 DSL JSON 直接执行；
 * 自然语言输入口已预留，理解层（规则/LLM，计划 PR #10~#13）接入后同一入口生效。
 * 面板属于开发/评委验证工具，不属于最终用户交互面（最终用户纯语音）。
 */
import { useState } from 'react'

export interface LogEntry {
  id: number
  time: string
  level: 'info' | 'warn' | 'error'
  text: string
}

interface DebugPanelProps {
  entries: LogEntry[]
  onSubmit: (text: string) => void
  onUndo: () => void
  onRedo: () => void
  onClear: () => void
}

const SAMPLE = JSON.stringify(
  [
    { op: 'create', shape: 'circle', name: '身体', at: { x: 512, y: 500 }, size: 110, fill: '#FFFFFF', stroke: '#AAAAAA', strokeWidth: 2 },
    { op: 'create', shape: 'circle', name: '头', at: { x: 512, y: 330 }, size: 65, fill: '#FFFFFF', stroke: '#AAAAAA', strokeWidth: 2 },
    { op: 'create', shape: 'circle', name: '左眼', at: { x: 490, y: 315 }, size: 7, fill: '#111111' },
    { op: 'create', shape: 'circle', name: '右眼', at: { x: 534, y: 315 }, size: 7, fill: '#111111' },
    { op: 'create', shape: 'triangle', name: '鼻子', at: { x: 512, y: 345 }, size: 12, fill: '#FF851B', rotation: 180 },
  ],
  null,
  1,
)

export function DebugPanel({ entries, onSubmit, onUndo, onRedo, onClear }: DebugPanelProps) {
  const [text, setText] = useState('')

  const submit = () => {
    if (text.trim().length === 0) return
    onSubmit(text)
    setText('')
  }

  return (
    <aside className="debug-panel">
      <div className="debug-panel-title">调试面板</div>
      <textarea
        className="debug-input"
        value={text}
        placeholder={'输入自然语言或 DSL JSON，⌘/Ctrl+Enter 执行\n例：画一个红色的圆 ｜ 把它变大一点 ｜ 清空画布'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
        rows={5}
        spellCheck={false}
      />
      <div className="debug-actions">
        <button onClick={submit}>执行</button>
        <button onClick={onUndo}>撤销</button>
        <button onClick={onRedo}>重做</button>
        <button onClick={onClear}>清空</button>
        <button onClick={() => setText(SAMPLE)}>示例</button>
      </div>
      <div className="debug-log">
        {entries.length === 0 && <div className="debug-log-empty">事件日志为空——执行一条指令试试</div>}
        {[...entries].reverse().map((e) => (
          <div key={e.id} className={`debug-log-entry debug-log-${e.level}`}>
            <span className="debug-log-time">{e.time}</span>
            <span>{e.text}</span>
          </div>
        ))}
      </div>
    </aside>
  )
}

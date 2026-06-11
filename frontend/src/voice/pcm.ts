/** Float32 音频帧 → 16bit PCM（小端）→ base64（协议 §3.2 audio.data 格式） */
export function float32ToPcm16Base64(frame: Float32Array): string {
  const buf = new ArrayBuffer(frame.length * 2)
  const view = new DataView(buf)
  for (let i = 0; i < frame.length; i++) {
    const s = Math.max(-1, Math.min(1, frame[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

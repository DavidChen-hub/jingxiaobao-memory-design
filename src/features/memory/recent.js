// 轮转后注入用的「最近一天原话」。数据只来自 aurabot 自己的 chatlog：
// 用户发来的原话 + 她真正发出去的正文；不读 DSH 会话文件。

export const RECENT_HEADER = '【最近一天的原话】'

const clipBlock = (text, max) => {
  const t = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!t || !(max > 0) || t.length <= max) return t
  return `${t.slice(0, Math.max(0, max - 1))}…`
}

const clockOf = (at) => {
  const d = new Date(Number(at) || 0)
  if (!Number.isFinite(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const roleOf = (row) => {
  const who = String(row?.who ?? row?.role ?? '').toLowerCase()
  if (['bot', 'assistant', 'model', '我', '助手'].includes(who)) return 'assistant'
  if (['system', 'event', 'diary', 'tool', '系统', '经历'].includes(who)) return ''
  return 'user'
}

const cleanText = (text, role) => {
  let out = String(text ?? '').trim()
  if (!out || /^【系统/.test(out)) return ''
  if (role === 'assistant') out = out.replace(/\[(?:poke|sticker|image|voice)\]/gi, '').trim()
  return out
}

const timeOf = (row) => {
  const n = Number(row?.t ?? row?.at ?? row?.time ?? 0)
  if (Number.isFinite(n) && n > 0) return n
  const parsed = Date.parse(row?.t || row?.at || row?.time || '')
  return Number.isFinite(parsed) ? parsed : 0
}

function turnsOf(records, chatId) {
  const rows = (Array.isArray(records) ? records : [])
    .filter((r) => r && (!chatId || String(r.chatId || '') === String(chatId)))
    .map((r) => {
      const role = roleOf(r)
      return { at: timeOf(r), role, text: cleanText(r.text, role) }
    })
    .filter((r) => r.role && r.at > 0 && r.text)
    .sort((a, b) => a.at - b.at)

  const turns = []
  let cur = null
  for (const row of rows) {
    if (row.role === 'user') {
      if (cur && cur.assistant.length) {
        turns.push(cur)
        cur = null
      }
      if (!cur) cur = { at: row.at, user: [], assistant: [] }
      cur.user.push(row.text)
      cur.at = row.at
      continue
    }
    if (!cur) continue
    cur.assistant.push(row.text)
    cur.at = row.at
  }
  if (cur && (cur.user.length || cur.assistant.length)) turns.push(cur)
  return turns.filter((t) => t.user.length || t.assistant.length)
}

/**
 * @param {{
 *   records?: Array<{t?:number,at?:number,chatId?:string,who?:string,role?:string,text?:string}>,
 *   entries?: Array, lines?: Array, chatId?: string, hours?: number, maxChars?: number,
 *   perTurn?: number, fallbackTurns?: number, now?: number
 * }} options
 * @returns {{text:string,chars:number,turns:number,fallback:boolean}}
 */
export function formatRecentSlice({
  records,
  entries,
  lines,
  chatId = '',
  hours = 24,
  maxChars = 2400,
  perTurn = 600,
  fallbackTurns = 6,
  now = Date.now(),
} = {}) {
  const budget = Math.max(0, Math.floor(Number(maxChars) || 0))
  if (budget <= 0) return { text: '', chars: 0, turns: 0, fallback: false }
  const source = records ?? entries ?? lines ?? []
  const usable = turnsOf(source, chatId)
  const cutoff = Number(now) - Math.max(1, Number(hours) || 24) * 3600_000
  let picked = usable.filter((t) => t.at >= cutoff)
  let fallback = false
  if (!picked.length && fallbackTurns > 0) {
    picked = usable.slice(-Math.max(1, Math.floor(fallbackTurns)))
    fallback = picked.length > 0
  }
  if (!picked.length) return { text: '', chars: 0, turns: 0, fallback: false }

  const out = []
  let used = RECENT_HEADER.length + 1
  for (let i = picked.length - 1; i >= 0; i -= 1) {
    const turn = picked[i]
    const clock = clockOf(turn.at)
    const linesOut = []
    const user = clipBlock(turn.user.join('\n'), Math.max(40, Math.floor(Number(perTurn) || 600)))
    const assistant = clipBlock(turn.assistant.join('\n'), Math.max(40, Math.floor(Number(perTurn) || 600) - 80))
    if (user) linesOut.push(`[${clock}] 用户：${user}`)
    if (assistant) linesOut.push(`[${clock}] 助手：${assistant}`)
    if (!linesOut.length) continue
    const chunk = linesOut.join('\n')
    if (used + chunk.length + 1 > budget) break
    out.unshift(chunk)
    used += chunk.length + 1
  }
  if (!out.length) return { text: '', chars: 0, turns: 0, fallback }

  const body = `${RECENT_HEADER}\n${out.join('\n')}`
  const note = `（以上是最近 ${out.length} 轮原话）`
  const text = body.length + note.length + 1 <= budget ? `${body}\n${note}` : body
  return { text, chars: text.length, turns: out.length, fallback }
}

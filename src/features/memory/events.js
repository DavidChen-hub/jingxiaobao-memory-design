// 事件层：把「发生过什么」从「事实」里拆出来单独注入。
// 事实卡不带日期（事实不需要时间），事件必须带日期——不然她会把十天前的事说成“最近”，
// 也讲不清「什么时候、因为什么、后来怎样」这条因果。
export const EVENT_HEADER = '【最近经历】'

const HOUR_MS = 3600_000

const pad = (n) => String(n).padStart(2, '0')

function stampOf(at) {
  const d = new Date(Number(at) || Date.now())
  return `[${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}]`
}

function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, Math.max(0, max - 1))}…`
}

/** 取窗口内的事件（source=event 是历史口径，kind=event 是新口径），新的在前。 */
function eventRows(items, { hours, now }) {
  const since = now - hours * HOUR_MS
  return (Array.isArray(items) ? items : [])
    .filter((m) => m && !m.invalidAt && Number(m.at) >= since && (m.kind === 'event' || (!m.kind && m.source === 'event')))
    .sort((a, b) => b.at - a.at)
}

/** 按条数与总字数打包（长行跳过、不中断，免得一条长句把后面的短句全挡住）。 */
function packRows(rows, { maxItems, maxChars, startChars = EVENT_HEADER.length }) {
  const out = []
  let chars = startChars
  for (const m of rows) {
    if (out.length >= maxItems) break
    const text = clip(m.text, 90)
    if (!text) continue
    const line = `- ${stampOf(m.at)} ${text}`
    if (chars + line.length + 1 > maxChars) continue
    out.push({ line, at: Number(m.at) || 0 })
    chars += line.length + 1
  }
  return { out, chars }
}

function render(rows) {
  if (!rows.length) return { text: '', chars: 0, count: 0 }
  const text = `${EVENT_HEADER}\n${rows.map((r) => r.line).join('\n')}`
  return { text, chars: text.length, count: rows.length }
}

/** 按条数与总字数打包成一段带日期前缀的经历。 */
function pack(rows, { maxItems, maxChars }) {
  return render(packRows(rows, { maxItems, maxChars }).out)
}

/**
 * 把最近 hours 小时内的事件压成一段带日期的阅历。
 * @returns {{text:string, chars:number, count:number}}
 */
export function formatEventSlice(items = [], { hours = 24, maxItems = 6, maxChars = 600, now = Date.now() } = {}) {
  return pack(eventRows(items, { hours, now }), { maxItems, maxChars })
}

/**
 * 经历流（T-031）：本场合最多 maxItems 条 + 其他场合最多 otherMaxItems 条，共享同一个字数预算。
 * 原来只按时间倒序取 6 条，群里一热闹就把私聊、抖音的经历全挤掉，换场合就「不记得」了。
 * 本场合先放，剩下的预算再给其他场合，所以热闹的场合也不会把本场合挤没。
 */
export function formatEventSliceMixed(items = [], { chatId = '', board = '', hours = 24, maxItems = 4, otherMaxItems = 2, maxChars = 600, now = Date.now() } = {}) {
  const rows = eventRows(items, { hours, now })
  // 「本场合」按发生地判：有 chatId 就比 chatId；没有 chatId 的老事件（抖音/B站经历）用板块判
  const here = (m) => (m.chatId ? String(m.chatId) === String(chatId || '') : Boolean(board) && String(m.scope || '') === String(board))
  // 预算先给本场合，剩下的才给其他场合（否则一条很新的别处长句会把本场合挤掉）
  const mine = packRows(rows.filter(here), { maxItems, maxChars })
  // 「别的场合」优先给**她自己说过的话**（T-031 的跨场合回忆）：抖音活动/日记再多也不能把「我刚在群里说了什么」挤没
  const elsewhere = rows.filter((m) => !here(m))
  const said = elsewhere.filter((m) => m.source === 'turn')
  const other = elsewhere.filter((m) => m.source !== 'turn')
  const picked = [...said.slice(0, otherMaxItems), ...other.slice(0, Math.max(0, otherMaxItems - Math.min(said.length, otherMaxItems)))]
  const others = packRows(picked, { maxItems: otherMaxItems, maxChars, startChars: mine.chars })
  return render([...mine.out, ...others.out].sort((a, b) => b.at - a.at))
}

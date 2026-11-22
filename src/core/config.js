// 记忆项目独立运行所需的最小配置归一化。
// 只保留记忆子系统会读到的字段；插件里的其它配置不在这里。

const DEFAULTS = {
  ownerQQ: '',
  ownerName: '主人',
  botQQ: '',
  model: { provider: '', model: '' },
  memory: {
    enabled: true,
    recallCount: 6,
    dailyConsolidate: true,
    consolidateTimes: ['04:00', '16:00'],
    reviewRemindAt: '22:40',
    decay: { eventHalfLifeDays: 30, eventForgetDays: 180 },
    route: { enabled: true },
    graph: { enabled: true, maxNeighbors: 2 },
    identity: { enabled: true, botName: '大肥鱼', maxChars: 500 },
    v2: { enabled: false, shadow: true, cardMaxChars: 1500, recentMaxChars: 2400 },
  },
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function merge(base, next) {
  const out = Array.isArray(base) ? [] : { ...base }
  if (!isObj(next)) return out
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) continue
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v
  }
  return out
}

const pad = (n) => String(n).padStart(2, '0')
const clamp = (n, min, max, fallback) => {
  if (n === null || n === undefined || n === '') return fallback
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}

/** "7:05" / "07:05" → "07:05"；非法返回 fallback（可为 ''）。 */
function hhmm(v, fallback = '') {
  const m = String(v ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return fallback
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return fallback
  return `${pad(h)}:${pad(min)}`
}

function normalizeMemory(raw = {}) {
  const m = merge(DEFAULTS.memory, raw)
  m.enabled = m.enabled !== false
  m.dailyConsolidate = m.dailyConsolidate !== false
  m.recallCount = clamp(m.recallCount, 0, 20, 6)

  // 老配置只有一个 consolidateAt：按原来的「+12 小时」规则拆成两次。
  const legacy = hhmm(raw?.consolidateAt ?? raw?.consolidateTimes, '')
  if (raw?.consolidateAt && legacy) {
    const [h, min] = legacy.split(':')
    m.consolidateTimes = [legacy, `${pad((Number(h) + 12) % 24)}:${min}`]
  } else {
    const list = Array.isArray(m.consolidateTimes) ? m.consolidateTimes : String(m.consolidateTimes || '').split(/[\s,，]+/)
    const times = [...new Set(list.map((t) => hhmm(t, '')).filter(Boolean))].sort().slice(0, 4)
    m.consolidateTimes = times.length ? times : ['04:00', '16:00']
  }
  delete m.consolidateAt

  const remind = String(m.reviewRemindAt ?? '22:40').trim()
  m.reviewRemindAt = remind === '' || remind.toLowerCase() === 'off' ? '' : hhmm(remind, '22:40')

  m.decay = m.decay || {}
  m.decay.eventHalfLifeDays = clamp(m.decay.eventHalfLifeDays, 1, 365, 30)
  m.decay.eventForgetDays = clamp(m.decay.eventForgetDays, 7, 3650, 180)

  m.route = m.route || {}
  m.route.enabled = m.route.enabled !== false

  m.graph = m.graph || {}
  m.graph.enabled = m.graph.enabled !== false
  m.graph.maxNeighbors = clamp(m.graph.maxNeighbors, 0, 5, 2)

  m.identity = m.identity || {}
  m.identity.enabled = m.identity.enabled !== false
  m.identity.botName = String(m.identity.botName || '大肥鱼').trim().slice(0, 20) || '大肥鱼'
  m.identity.maxChars = clamp(m.identity.maxChars, 80, 1000, 500)

  m.v2 = m.v2 || {}
  m.v2.enabled = m.v2.enabled === true
  m.v2.shadow = m.v2.shadow !== false
  m.v2.cardMaxChars = clamp(m.v2.cardMaxChars, 300, 6000, 1500)
  m.v2.recentMaxChars = clamp(m.v2.recentMaxChars, 300, 12000, 2400)
  return m
}

/** 只归一化本仓库关心的字段；其它字段原样保留。 */
export function normalize(raw = {}) {
  const c = merge(DEFAULTS, raw)
  c.ownerQQ = String(c.ownerQQ || '')
  c.botQQ = String(c.botQQ || '')
  c.ownerName = String(c.ownerName || '主人')
  c.model = { provider: String(c.model?.provider || ''), model: String(c.model?.model || '') }
  c.memory = normalizeMemory(raw.memory || {})
  return c
}

export { DEFAULTS }

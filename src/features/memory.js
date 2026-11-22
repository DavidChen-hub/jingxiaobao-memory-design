// 索引记忆库：本地 JSON 存储 + 倒排索引（中文按二元字组切词，英文数字按词）+ BM25 打分，
// 再叠加「关于当前说话人」「重要程度」「新近程度」的加权。不依赖外部向量库，几千条也是毫秒级。
//
// 记忆来源：她自己调 remember 工具记的、后台从聊天里自动提炼的、主人在面板里手动加的。
// 召回时机：每一轮回复前，用「这一轮对方说的话」（太短就连上一句）检索最相关的几条，作为上下文悄悄告诉她。
//
// 借鉴的做法：
// - 遗忘曲线（MemoryBank）：记得多牢按「多久没想起 + 被想起过几天 + 重要程度」算，常聊到的忘得慢。
// - 整理时先比对旧记忆（Mem0）：新事实是新增、补充旧的，还是说明旧的过时了。
// - 过时不删（Graphiti）：旧记忆标成「已过时」，不再被想起，但留着历史、面板里能恢复。
// - 常驻的人物小档案（Letta 的 memory block）：每个人一小段印象，聊天时一直带着，不靠关键词碰运气。

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { askModel } from '../core/llm.js'
import { buildFactCard } from './memory/card.js'
import { formatRecentSlice } from './memory/recent.js'
import { formatEventSlice, formatEventSliceMixed } from './memory/events.js'
import { routeQuery, routeScore, routeBonus } from './memory/route.js'
import { buildGraph, expandNeighbors, GRAPH_VERSION } from './memory/graph.js'
import { buildIdentityCard, isIdentityFact } from './memory/identity.js'

// ---------------- 纯函数：切词与打分 ----------------

const STOP = new Set('的了是我你他她它们在有和就不也都很吗吧呢啊呀哦嗯这那个一上下来去说要会能着过'.split(''))
const CARD_REFRESH_TURNS = 8
const RECENT_LOOKBACK_DAYS = 7
const DAY_MS = 86400_000
const DEFAULT_EVENT_HALF_LIFE_DAYS = 30
const DEFAULT_EVENT_FORGET_DAYS = 180

/** 切词：英文/数字整词；中文连续段拆成二元字组（单字段保留单字，去掉停用字）。 */
export function tokenize(text) {
  const out = []
  const s = String(text || '').toLowerCase()
  for (const m of s.matchAll(/[a-z0-9_]{2,}|[一-鿿]+/g)) {
    const w = m[0]
    if (/^[a-z0-9_]+$/.test(w)) { out.push(w); continue }
    if (w.length === 1) { if (!STOP.has(w)) out.push(w); continue }
    for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2))
  }
  return out
}

/** 两段文字有多像（字组 Jaccard），用于去重。 */
export function similarity(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/** 建索引：返回 { docs, df, avgLen }。 */
export function buildIndex(items) {
  const df = new Map()
  const docs = items.map((it) => {
    const toks = tokenize(`${it.text} ${(it.tags || []).join(' ')} ${it.aboutName || ''}`)
    const tf = new Map()
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1)
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1)
    return { it, tf, len: toks.length || 1 }
  })
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1)
  return { docs, df, avgLen, N: docs.length }
}

/**
 * 检索。
 * @param idx buildIndex() 的结果
 * @param {string} query
 * @param {{about?:string|string[], now?:number, limit?:number, minScore?:number, includeInvalid?:boolean}} [o]
 *   about：关于这些人（QQ 号）的记忆加分；群里可以传这一段里所有说话的人
 */
export function search(idx, query, o = {}) {
  const q = [...new Set(tokenize(query))]
  const now = o.now ?? Date.now()
  const aboutSet = new Set((Array.isArray(o.about) ? o.about : o.about ? [o.about] : []).map(String))
  const k1 = 1.4
  const b = 0.7
  const scored = []
  for (const d of idx.docs) {
    let s = 0
    const why = []
    for (const t of q) {
      const f = d.tf.get(t)
      if (!f) continue
      const n = idx.df.get(t) || 0
      const idf = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5))
      const part = idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / idx.avgLen))
      s += part
      why.push([t, part])
    }
    const it = d.it
    if (it.invalidAt && !o.includeInvalid) continue
    // 板块过滤必须在打分/截断之前：否则别的板块的高分结果会占满名额（Codex P1-9）
    if (typeof o.allow === 'function' && !o.allow(it)) continue
    const aboutHit = Boolean(it.about) && aboutSet.has(String(it.about))
    // 问法路由（T-039）：结构命中可以救回「问法和正文不重合」的事实（如「生日」对上「9月5日出生」）。
    // 主体单独命中只救「点名的人」，不救泛泛的「我/她」，否则任何问句都会把该板全部记忆捞进来。
    const rs = o.route ? routeScore(it, o.route) : null
    const specificWho = Boolean(o.route?.who && o.route.who !== 'owner' && o.route.who !== 'bot')
    const structural = Boolean(rs && (rs.slotHit || rs.dateHit || (rs.subjectHit && specificWho)))
    if (s <= 0 && !aboutHit && !structural) continue
    const importance = 0.6 + 0.8 * (Number(it.importance) || 0.5)
    // 潮汐衰减（T-034）：事实不随时间打折，事件按半衰期淡出；被想起过的事件略占优（不惩罚新事件）
    const aliveness = retention(it, now, o)
    const evidence = isEventMemory(it) ? 1 + 0.1 * evidenceScore(it) : 1
    // 结构分按问句问的 facet 门控：问槽位就只认槽位，问日期只认日期；不命中 facet 不加分
    const facet = o.route?.slots?.length ? 'slot' : o.route?.dayKeys?.length ? 'date' : o.route?.topics?.length ? 'topic' : ''
    const gate = !facet || (facet === 'slot' ? rs?.slotHit : facet === 'date' ? rs?.dateHit : rs?.topicHit)
    const onlyAbout = aboutHit && s <= 0
    const bonus = rs && gate && !(onlyAbout && !specificWho && !rs.slotHit && !rs.dateHit) ? routeBonus(rs) : 0
    const routeWhy = []
    if (bonus && rs?.subjectHit) routeWhy.push('（主体）')
    if (bonus && rs?.slotHit) routeWhy.push(`（槽位:${rs.slot}）`)
    if (bonus && rs?.topicHit) routeWhy.push(`（主题:${rs.topic}）`)
    if (bonus && rs?.dateHit) routeWhy.push('（日期）')
    const score = (s + (aboutHit ? 0.8 : 0)) * importance * (0.55 + 0.45 * aliveness) * evidence + bonus
    scored.push({ it, score, why: why.sort((x, y) => y[1] - x[1]).slice(0, 3).map((w) => w[0]).concat(aboutHit ? ['（关于这个人）'] : []).concat(routeWhy) })
  }
  scored.sort((x, y) => y.score - x.score)
  return scored.filter((x) => x.score >= (o.minScore ?? 0.35)).slice(0, o.limit ?? 6)
}

/** 「刚才」「3 小时前」「昨天」这样的说法。 */
export function agoText(at, now = Date.now()) {
  const m = Math.max(0, Math.round((now - at) / 60000))
  if (m < 30) return '刚才'
  if (m < 60 * 20) return `${Math.max(1, Math.round(m / 60))} 小时前`
  return '昨天'
}

/** 一条记忆是什么时候的：今天 / 昨天 / 3 天前 / 09-17 / 去年 03-02 / 2024-05-01。 */
export function whenText(at, now = Date.now()) {
  if (!at) return ''
  const d = new Date(at)
  const n = new Date(now)
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day0(n) - day0(d)) / 86400_000)
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  if (d.getFullYear() === n.getFullYear()) return md
  if (d.getFullYear() === n.getFullYear() - 1) return '去年 ' + md
  return `${d.getFullYear()}-${md}`
}

/** 想起来的一条记忆怎么写给她：[什么时候] [关于谁] 内容。 */
export function memoryLine(it, now = Date.now()) {
  return `[${whenText(it.at, now)}] ` + (it.aboutName ? `[${it.aboutName}] ` : '') + it.text
}

/** 事件还是事实：事件会随潮汐淡出，事实不会（T-034）。
 * 老数据没有 kind（425 条），只能按 source:'event' 认；新数据 kind 优先，
 * 所以 kind:'fact' + source:'event'（抖音/B站「记住的知识」）仍算事实。 */
export function isEventMemory(m) {
  return Boolean(m) && (m.kind === 'event' || (!m.kind && m.source === 'event'))
}

/** 证据分 0~1：被想起/确认过的次数越多越接近 1（s/(s+2) 饱和，不会无限膨胀）。 */
export function evidenceScore(m) {
  const s = Math.max(0, Number(m?.hits) || 0)
  return s / (s + 2)
}

export const MEMORY_MAX_ITEMS = 3000

/**
 * 记忆库上限（T-034 复核 P1）：事实优先保留，剩余名额才给事件。
 * 不再用「importance 一刀切」——那样低重要度的事实会先被静默挤掉，
 * 等于绕过 shouldForget 又删了一次事实。
 */
export function capItems(items = [], max = MEMORY_MAX_ITEMS) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  if (list.length <= max) return list
  const rank = (a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0) || (Number(b.at) || 0) - (Number(a.at) || 0)
  const facts = list.filter((m) => !isEventMemory(m)).sort(rank)
  const keepFacts = facts.slice(0, max)
  const room = Math.max(0, max - keepFacts.length)
  const events = list.filter((m) => isEventMemory(m)).sort(rank).slice(0, room)
  return [...keepFacts, ...events]
}

/**
 * 该不该忘掉——潮汐式（T-034）：
 * - 过时的（被新事实取代）留半年后回收，和以前一样；
 * - 事实永不过期（自己记的、面板加的、整理出来的都留着）；
 * - 事件按半衰期淡出，太重要的留着；默认 6 个半衰期（180 天）后仍没被想起才清。
 */
export function shouldForget(m, now = Date.now(), opts = {}) {
  if (!m) return false
  // 过时的留半年（面板里能看到、能恢复），之后清掉
  if (m.invalidAt) return now - m.invalidAt > 180 * DAY_MS
  if (!isEventMemory(m)) return false
  if ((Number(m.importance) || 0) >= 0.6) return false
  const half = Math.max(1, Number(opts.eventHalfLifeDays) || DEFAULT_EVENT_HALF_LIFE_DAYS)
  // 清理期直接听配置，不再用 half*2 覆盖（半衰期 365 + 清理 30 不该变成 730）
  const forgetDays = Math.max(1, Number(opts.eventForgetDays) || DEFAULT_EVENT_FORGET_DAYS)
  // 「多久没被想起」：事件发生时间或最近一次被想起，取较晚的——想起会给事件续命（潮汐）
  const last = Math.max(Number(m.at) || 0, Number(m.lastHit) || 0, 0)
  const ageDays = Math.max(0, (now - (last || now)) / DAY_MS)
  return ageDays > forgetDays
}

/**
 * 记得多牢（0~1）——潮汐式衰减：
 * - 事实恒为 1：事实不会随时间过时，只有被新事实取代（invalidAt）才退出；
 * - 事件：R = 0.5^(Δt / 半衰期)，默认 30 天半衰期，60 天剩 1/4、180 天剩 1/64；
 *   Δt 从「发生时间或最近一次被想起」算，被想起会续命（潮汐）；
 * - 情绪不加权（主人 2026-11-16 明确不做「生一次气记半年」）。
 * @param {{eventHalfLifeDays?:number}} [opts]
 */
export function retention(m, now = Date.now(), opts = {}) {
  if (!m) return 0
  if (!isEventMemory(m)) return 1
  const half = Math.max(1, Number(opts.eventHalfLifeDays) || DEFAULT_EVENT_HALF_LIFE_DAYS)
  // 「多久没被想起」：发生时间或最近一次被想起，取较晚的（想起会续命）
  const last = Math.max(Number(m.at) || 0, Number(m.lastHit) || 0, 0)
  const days = Math.max(0, (now - (last || now)) / DAY_MS)
  return Math.pow(0.5, days / half)
}

// ---------------- 记忆库 ----------------

/** 解析「回顾」的模型输出：{insights:[], style:[]}；老格式的纯数组当作 insights。 */
export function parseReflection(out) {
  const str = (t) => String(typeof t === 'string' ? t : t?.text || '').trim()
  const obj = String(out || '').match(/\{[\s\S]*\}/)
  if (obj) {
    try {
      const j = JSON.parse(obj[0])
      if (Array.isArray(j.insights) || Array.isArray(j.style)) {
        return { insights: (j.insights || []).map(str).filter(Boolean), style: (j.style || []).map(str).filter(Boolean) }
      }
    } catch (error) {}
  }
  const arr = String(out || '').match(/\[[\s\S]*\]/)
  try {
    return { insights: arr ? JSON.parse(arr[0]).map(str).filter(Boolean) : [], style: [] }
  } catch (error) {
    return { insights: [], style: [] }
  }
}

/**
 * 抽取出来的事实该挂到谁头上。
 * 模型给了 QQ 号就按号挂；只给了名字、没给号时，不能因为「这段聊天是跟主人聊的」
 * 就把别人的事挂到主人 uid 上（2026-11-09 真实数据里「朋友A」那条就是这么错挂的）。
 */
export function pickAboutForFact({ qq = '', about = '', chatId = '', botQQ = '', ownerQQ = '', ownerName = '主人' } = {}) {
  const digits = String(qq || '').replace(/\D/g, '')
  if (digits.length >= 5 && digits !== String(botQQ || '')) return digits
  const uid = String(chatId || '').startsWith('private:') ? String(chatId).slice(8) : ''
  if (!uid) return ''
  const name = String(about || '').trim()
  if (!name) return uid
  // 跟别人私聊：这段话里的「对方」就是他本人，照挂
  if (uid !== String(ownerQQ || '')) return uid
  // 跟主人私聊：只有明确说主人时才算主人的事，说别人的（朋友A、朋友C…）不挂他的号
  const own = String(ownerName || '主人')
  return name === own || name === '主人' ? uid : ''
}

/**
 * 按「情境段」切聊天：间隔超过 gapMs 断开，单段最多 maxTurns 轮。
 * 一段话是一个完整话题，比"一整天散着看"更容易抽出「当时发生了什么」。
 */
export function segmentLines(lines, { gapMs = 90 * 60e3, maxTurns = 40 } = {}) {
  const out = []
  let cur = []
  let last = 0
  for (const l of Array.isArray(lines) ? lines : []) {
    const t = Number(l?.t) || 0
    if (cur.length && t && last && t - last > gapMs) { out.push(cur); cur = [] }
    cur.push(l)
    if (t) last = t
    if (cur.length >= maxTurns) { out.push(cur); cur = [] }
  }
  if (cur.length) out.push(cur)
  return out
}

/** 引文能不能在原文里逐字找到（忽略空白差异）。找不到 = 模型在编，丢掉。 */
export function quoteInTranscript(quote, haystack) {
  const q = String(quote || '').replace(/\s+/g, '')
  if (!q) return false
  return String(haystack || '').replace(/\s+/g, '').includes(q)
}

/**
 * 她自己的五个板块（2026-11-10 主人定的口径）：
 *   owner        主人：QQ 私聊 + 他在抖音的私信/评论/@
 *   group:<id>   某个群；group 是群公共事实（跨群）
 *   douyin       抖音里的公开活动（刷视频、回陌生人）
 *   friend:<名字> 她自己的朋友（朋友A这种），不是主人的附属
 *   self         她自己的事：空间日记、说说、心事
 *   quarantine   旧档案导入的隔离区，不进任何注入
 * 原则：记忆是一整套，按场合收窄注入——群里不注入主人/朋友的私事。
 */
export function deriveMemoryScope({ chatId = '', about = '', aboutName = '', text = '', source = '', tags = [], ownerQQ = '', ownerName = '主人' } = {}) {
  const cid = String(chatId || '')
  const owner = String(ownerQQ || '')
  // 旧档案导入永远进隔离区，不看 chatId/tags（Codex P1-7：import 必须最前，否则 tags=空间 / private:* 能绕过）
  if (source === 'import') return 'quarantine'
  if (cid.startsWith('group:')) {
    // 群规、群梗这种公共事实由写入方显式传 scope='group'
    return cid
  }
  if (cid.startsWith('private:')) {
    const uid = cid.slice(8)
    return owner && uid === owner ? 'owner' : `friend:${uid}`
  }
  if (cid === 'qzone') return 'self'
  if (cid) return 'douyin' // 抖音来的显式 scope 优先；这里兜底
  if (source === 'diary') return 'self'
  if (Array.isArray(tags) && tags.includes('空间')) return 'self'
  const who = String(about || '').trim()
  const whoName = String(aboutName || '').trim()
  if (owner && who && who === owner) return 'owner'
  // 只给了名字、又正好是主人的称呼：归主人板块（不能落到 friend:主人）
  if (owner && whoName && (whoName === '主人' || whoName === String(ownerName || '主人'))) return 'owner'
  if (whoName) return `friend:${whoName}`
  if (who) return source === 'event' ? 'douyin' : `friend:${who}`
  return /主人/.test(String(text || '')) && owner ? 'owner' : 'douyin'
}

/**
 * 新条目最终的板块：deriveMemoryScope 之后再拆「关于主人、但写的是另一个人名字」（朋友A那次）。
 * 写入口和迁移脚本共用这一份规则，禁止脚本各自再实现一份 derive（Codex 复核 P2 / 上次漂移教训）。
 */
/** 两份档案同时存在时谁赢：带板块的 canonical 键永远优先；同类取更新的。 */
function betterProfile(prev, next, nextCanonical) {
  if (!prev) return { p: next, canonical: nextCanonical }
  if (nextCanonical !== prev.canonical) return nextCanonical ? { p: next, canonical: true } : prev
  return Number(next?.at || 0) >= Number(prev.p?.at || 0) ? { p: next, canonical: nextCanonical } : prev
}

/** 档案键现在有两种：旧「QQ」和新「板块|QQ」。查人一律按 QQ 查，canonical 键优先。 */
function profilesByQQ(profiles) {
  const picked = new Map()
  for (const [k, p] of Object.entries(profiles || {})) {
    const i = String(k).indexOf('|')
    const qq = i > 0 ? String(k).slice(i + 1) : String(k)
    if (!qq) continue
    picked.set(qq, betterProfile(picked.get(qq), p, i > 0))
  }
  const out = new Map()
  for (const [qq, v] of picked) out.set(qq, v.p)
  return out
}

export function resolveMemoryScope({ chatId = '', about = '', aboutName = '', text = '', source = '', tags = [], ownerQQ = '', ownerName = '', profiles = {} } = {}) {
  const key = deriveMemoryScope({ chatId, about, aboutName, text, source, tags, ownerQQ, ownerName })
  if (key !== 'owner') return key
  const who = String(about || '').trim()
  const owner = String(ownerQQ || '').trim()
  // 有别人的 QQ 号：统一用 friend:<QQ>，这样和 TA 自己私聊的板块对得上（Codex P1-1）
  if (who && who !== owner) return 'friend:' + who
  const name = String(aboutName || '').trim()
  if (!name) return key
  const ownName = String(ownerName || '主人')
  if (name === ownName || name === '主人') return key
  if (who && name === String(profilesByQQ(profiles).get(who)?.name || '')) return key
  // 只有名字时：档案里唯一对应一个 QQ 就用 QQ 当键，否则用名字（Codex P1-1：名字和 QQ 不能是两套互不相认的主键）
  const hits = [...profilesByQQ(profiles)].filter(([, p]) => String(p?.name || '') === name).map(([qq]) => String(qq))
  if (hits.length === 1 && hits[0] !== owner) return 'friend:' + hits[0]
  return 'friend:' + name
}

/**
 * 这条改写是不是在改「对的那个人」：朋友板块要比对 QQ / 名字，防止模型拿朋友A的 id 去改小明的事实。
 * 主人 / 群 / 自己 / 抖音 不做主体校验（这些板块没有「人名主键」问题）。
 */
export function subjectMatchesScope({ scope = '', about = '', aboutName = '', ownerQQ = '', ownerName = '', profiles = {} } = {}) {
  const s = String(scope || '')
  if (!s.startsWith('friend:')) return true
  const key = s.slice(7)
  const who = String(about || '').trim()
  const name = String(aboutName || '').trim()
  // 纯数字当 QQ（scopeOfChat 生成的 friend:<QQ>），其它当名字
  const keyIsQQ = /^\d+$/.test(key)
  // 目标那条是谁：QQ 键直接用；名字键去 profiles 反查 QQ
  const byQQ = profilesByQQ(profiles)
  const targetQQ = keyIsQQ ? key : ([...byQQ].find(([, p]) => String(p?.name || '') === key) || [])[0] || ''
  const targetName = keyIsQQ ? String(byQQ.get(key)?.name || '') : key
  // 给了 QQ：必须对得上
  if (who && targetQQ && who !== targetQQ) return false
  if (who && !targetQQ && who !== key) return false
  // 给了名字：也必须对得上（防「QQ 对、名字错」：朋友A的 id 配小明的名字）
  if (name) {
    if (targetName && name !== targetName) return false
    if (!targetName && name !== key) return false
  }
  return Boolean(who || name)
}

/** 当前聊天属于哪个板块。system 会话（抖音）返回 'douyin'，其它未知返回 ''。 */
export function scopeOfChat(chat, ownerQQ = '') {
  if (!chat) return ''
  const owner = String(ownerQQ || '')
  if (chat.kind === 'group' && chat.groupId) return `group:${chat.groupId}`
  if (chat.kind === 'private' && chat.userId) return owner && String(chat.userId) === owner ? 'owner' : `friend:${chat.userId}`
  if (chat.kind === 'system') return 'douyin'
  return ''
}

/**
 * 模型输出 → 条目数组。正常情况直接 JSON.parse；被 maxTokens 截断时从后往前
 * 在每个 } 处收口，把已经完整的条目救回来（2026-11-12：1879 字的长流水整批丢过一次）。
 */
export function parseItemsJson(out) {
  const text = String(out || '')
  const start = text.indexOf('[')
  if (start < 0) return []
  const tail = text.slice(start)
  const parse = (s) => {
    try {
      const v = JSON.parse(s)
      return Array.isArray(v) ? v : null
    } catch (error) { return null }
  }
  const end = tail.lastIndexOf(']')
  if (end > 0) {
    const direct = parse(tail.slice(0, end + 1))
    if (direct) return direct
    const fixed = parse(tail.slice(0, end + 1).replace(/,\s*([\]}])/g, '$1'))
    if (fixed) return fixed
  }
  let i = tail.length
  for (let guard = 0; guard < 60 && i > 0; guard++) {
    const cut = tail.lastIndexOf('}', i - 1)
    if (cut < 0) break
    const cand = parse(`${tail.slice(0, cut + 1).replace(/,\s*$/, '')}]`)
    if (cand && cand.length) return cand
    i = cut
  }
  return []
}

/**
 * 这条记忆能不能进这个板块的注入。
 * 主人和抖音互相看得见（她是一个人）；抖音的公开活动群里也看得到；朋友和群各自收窄；隔离区永远不注入。
 */
export function scopeVisible(item, board) {
  const s = String(item?.scope || '')
  const b = String(board || '')
  if (s === 'quarantine') return false
  if (!b) return false // 没有板块 = 不可见（fail-closed）；管理视图走 visibleForAdmin
  if (b === 'quarantine') return false // 隔离区不是注入目标
  if (!s) return false // 缺 scope 也不可见
  // 她说的话（T-031）按发生地收窄：本场合 + 主人私聊（主人是一个人，能回想别处说过什么）；
  // 不进别的群、不进抖音、不进朋友别处——私聊里听到的话不能以她的口吻出现在群里（Codex 复核 P0）
  if (s === 'self' && item?.board) return b === String(item.board) || b === 'owner'
  if (s === 'identity') return true // 全局身份卡：非敏感身份/关系，每个场合都可见
  if (s === 'self' || s === 'global') return true
  if (s === 'owner') return b === 'owner'
  // T-027 P0-mini：抖音的「公开活动」写进群聊也能提（P0 全量放开 owner 仍搁置）。
  // 注意 douyin 板里不能再有跟别人的私信内容——那些写 friend:<名字>（duty.js 发私信那处）。
  if (s === 'douyin') return b === 'douyin' || b === 'owner' || b.startsWith('group:')
  // P1-4：B 站公开活动单独一个桶（public:bili），抖音不再看到 B 站看了什么；目前没有 B 站会话，只在面板/日报可见
  if (s === 'public:bili') return b === 'public:bili'
  if (s === 'group' || s.startsWith('group:')) return b === s || (s === 'group' && b.startsWith('group:'))
  // A 决策：朋友只在主人的私聊和 TA 自己的私聊里出现，抖音是公开场不给
  if (s.startsWith('friend:')) return b === s || b === 'owner'
  return false
}

/** 管理视图（面板列表/日报）：只排除隔离区，其它都看得到。chat 注入不准用它。 */
export function visibleForAdmin(item) {
  return String(item?.scope || '') !== 'quarantine'
}

// 面板只能往这几类板块写：主人/她自己/抖音/群公共/某个群/某个朋友/待确认（Codex P1-3）
const SCOPE_RE = /^(owner|self|douyin|identity|group|quarantine)$|^group:\d+$|^friend:[^\s:]{1,32}$|^public:[a-z]{2,12}$/
export function cleanScope(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  return SCOPE_RE.test(s) ? s : null
}

/**
 * 面板手动加一条：没选板块、只给了个还没对上 QQ 的名字 → 先放隔离区，等主人在面板里选板块。
 * 「关于主人」直接归主人板块，不能误隔离。
 */
export function panelAddScope({ scope = '', about = '', aboutName = '', ownerName = '主人', profiles = {} } = {}) {
  const s = String(scope || '').trim()
  const name = String(aboutName || '').trim()
  if (s || !name || about) return { scope: s, note: '' }
  if (name === String(ownerName || '主人') || name === '主人') return { scope: '', note: '' }
  const known = Object.values(profiles || {}).some((p) => String(p?.name || '') === name)
  if (known) return { scope: '', note: '' }
  return { scope: 'quarantine', note: '（「' + name + '」还没对上 QQ，先放待确认；在列表里给它选个板块才会用）' }
}

/** 从 chatId 反推板块（整理/抽取时只有 chatId，没有 chat 对象）。 */
export function boardFromChatId(chatId, ownerQQ = '') {
  const cid = String(chatId || '')
  if (cid.startsWith('group:')) return cid
  if (cid.startsWith('private:')) {
    const uid = cid.slice(8)
    return String(uid) === String(ownerQQ || '') ? 'owner' : `friend:${uid}`
  }
  if (cid === 'qzone') return 'self'
  return ''
}

export function createMemoryStore({ dsh, getConfig, hub, log }) {
  const file = () => dataDir('memories.json')
  const load = () => {
    const s = readJson(file(), () => ({ items: [] }))
    // 读时补 scope：旧运行态写进来的条目没有 scope，按生产规则补上（不额外整文件重写；下一次正常 save 自然落盘）。
    // 这样 DSH 一直在写也不会因为「迁移脚本 replace 数据文件」丢更新（Codex P0-1）。
    if (s && Array.isArray(s.items)) {
      const c = typeof getConfig === 'function' ? getConfig() : null
      for (const m of s.items) {
        if (!m) continue
        if (!m.scope) {
          // 无 scope 的旧 B 站公开事件先认出来：带着 about 的记录会被 resolve 成 owner/friend，就迁不到 public:bili 了
          const biliEvent = !m.kind && m.source === 'event' && !m.chatId && Array.isArray(m.tags) && m.tags.includes('B站')
          m.scope = biliEvent ? 'public:bili' : resolveMemoryScope({ chatId: m.chatId, about: m.about, aboutName: m.aboutName, text: m.text, source: m.source, tags: m.tags, ownerQQ: c?.ownerQQ, ownerName: c?.ownerName, profiles: s.profiles })
        }
        // P1-4 口径修正：B 站公开活动原来写进 douyin 桶（含无 scope 被补成 douyin 的），统一改到 public:bili
        if (m.scope === 'douyin' && Array.isArray(m.tags) && m.tags.includes('B站')) m.scope = 'public:bili'
      }
    }
    return s
  }
  const save = (s) => {
    writeJson(file(), s)
    cache = null
    graphCache = null
  }
  let cache = null // { stamp, idx }
  let graphCache = null // { stamp, graph } 记忆图谱（T-040）：按 items 状态缓存
  const index = () => {
    const s = load()
    const stamp = s.items.length + ':' + (s.items.at(-1)?.id || '') + ':' + (s.rev || 0)
    if (!cache || cache.stamp !== stamp) cache = { stamp, idx: buildIndex(s.items) }
    return cache.idx
  }
  const graphIndex = () => {
    const s = load()
    const stamp = s.items.length + ':' + (s.items.at(-1)?.id || '') + ':' + (s.rev || 0)
    if (!graphCache || graphCache.stamp !== stamp) graphCache = { stamp, graph: buildGraph(s.items, { now: Date.now() }) }
    return graphCache.graph
  }
  // 潮汐衰减的配置（T-034）：默认 30 天半衰期、180 天清事件，配置里可改
  const decayOpts = () => (typeof getConfig === 'function' ? (getConfig().memory?.decay || {}) : {})
  // 问法路由（T-039）：把问句变成主体/槽位/主题/日期；关掉开关就返回 null（回旧检索）
  const routeFor = (text, people = [], speaker = '') => {
    const cfg = typeof getConfig === 'function' ? getConfig() : null
    if (!String(text || '').trim() || cfg?.memory?.route?.enabled === false) return null
    const s = load()
    const list = []
    for (const [k, p] of Object.entries(s.profiles || {})) {
      const name = String(p?.name || '').trim()
      if (!name) continue
      const qq = String(k).includes('|') ? String(k).split('|').pop() : String(k)
      list.push({ qq, name })
    }
    for (const p of Array.isArray(people) ? people : []) if (p) list.push({ qq: String(p), name: '' })
    return routeQuery(text, { now: Date.now(), people: list, ownerQQ: cfg?.ownerQQ || '', ownerName: cfg?.ownerName || '主人', speaker: String(speaker || '') })
  }

  // T-035：当前抖音昵称补一条 self 事实（只跑一次；以后改名由 profileUpdate 写）。
  // 不直接改 memories.json，走正常 add()，下一次 save 自然落盘。
  let selfProfileBackfilled = false
  function backfillSelfProfile() {
    if (selfProfileBackfilled) return
    selfProfileBackfilled = true
    try {
      const d = readJson(dataDir('douyin.json'), () => null)
      const nick = String(d?.account?.nickname || '').trim()
      if (!nick) return
      const s = load()
      const has = s.items.some((m) => m && !m.invalidAt && m.scope === 'self' && /我的抖音昵称/.test(String(m.text || '')) && String(m.text || '').includes(nick))
      if (!has) add({ text: `我的抖音昵称是${nick}`, kind: 'fact', source: 'tool', scope: 'self', board: 'owner', importance: 0.8, tags: ['资料', '她自己'] })
    } catch (error) {
      log?.debug?.('回填自己的资料失败：', error.message)
    }
  }

  function add({ text, about = '', aboutName = '', tags = [], importance = 0.5, source = 'tool', chatId = '', kind = 'fact', scope = '', board = '' }) {
    const t = String(text || '').trim().slice(0, 200)
    if (!t) return { ok: false, message: '内容是空的' }
    const s = load()
    const c0 = typeof getConfig === 'function' ? getConfig() : null
    // import 永远进隔离区，显式 scope 也绕不过（Codex P1-3）
    let scopeKey = source === 'import' ? 'quarantine' : (scope || resolveMemoryScope({ chatId, about, aboutName, text: t, source, tags, ownerQQ: c0?.ownerQQ, ownerName: c0?.ownerName, profiles: s.profiles }))
    // 去重只在同一板块内做：同一句话在群里和私聊是两条，不能互相覆盖（Codex P1-4）
    const dup = s.items.find((m) => !m.invalidAt
      && String(m.scope || '') === String(scopeKey || '')
      // 去重不跨事实/事件：同文的事件和事实是两种东西，合并会让事实被事件拖着衰减、或事件被事实续命
      && isEventMemory(m) === (kind === 'event')
      && String(m.board || '') === String(board || '')
      && similarity(m.text, t) >= 0.6
      && (!about || !m.about || m.about === String(about)))
    if (dup) {
      dup.text = t.length >= dup.text.length ? t : dup.text
      dup.at = Date.now()
      dup.importance = Math.max(Number(dup.importance) || 0, Number(importance) || 0)
      s.rev = (s.rev || 0) + 1
      save(s)
      return { ok: true, message: '✓', updated: dup.id }
    }
    const item = { id: randomUUID().slice(0, 8), text: t, about: String(about || ''), aboutName: String(aboutName || ''), tags: (tags || []).slice(0, 5), importance: Math.max(0, Math.min(1, Number(importance) || 0.5)), source, chatId, kind: kind === 'event' ? 'event' : 'fact', scope: scopeKey, board: String(board || ''), at: Date.now(), hits: 0 }
    s.items.push(item)
    if (s.items.length > MEMORY_MAX_ITEMS) {
      const before = s.items.length
      s.items = capItems(s.items)
      log?.warn?.(`记忆库超过 ${MEMORY_MAX_ITEMS} 条，按事实优先挤掉 ${before - s.items.length} 条`)
    }
    save(s)
    return { ok: true, message: '✓', id: item.id }
  }

  // ---------- 候选池：模型抽取先宽进，日终整理再严出 ----------
  const CANDIDATE_PASS_MENTIONS = 3
  const CANDIDATE_STALE_DAYS = 14
  const CANDIDATE_ARCHIVE_DAYS = 30 // blocked 之后再过 30 天，从池子里清掉（只留统计）

  function candidateKeyOf(text, key = '') {
    const explicit = String(key || '').trim().toLowerCase().replace(/\s+/g, '')
    if (explicit) return explicit
    return [...new Set(tokenize(String(text || '')))].sort().join('|')
  }

  function activeCandidates(s = load()) {
    return (Array.isArray(s.memoryCandidates) ? s.memoryCandidates : []).filter((c) => c && c.status === 'candidate')
  }

  /** 低置信 / 模型抽取的内容先放这里；不建索引、不进事实卡。 */
  function addCandidate({ text, about = '', aboutName = '', tags = [], importance = 0.45, confidence = 0.45, source = 'auto', chatId = '', key = '', op = 'add', targetId = '', at = Date.now(), kind = 'fact', scope = '' }) {
    const t = String(text || '').trim().slice(0, 200)
    if (!t) return { ok: false, message: '内容是空的' }
    const c0 = typeof getConfig === 'function' ? getConfig() : null
    // import 永远进隔离区，显式 scope 也绕不过（Codex P1-3）
    const scopeKey = source === 'import' ? 'quarantine' : (scope || resolveMemoryScope({ chatId, about, aboutName, text: t, source, tags, ownerQQ: c0?.ownerQQ, ownerName: c0?.ownerName, profiles: load().profiles }))
    // 候选 key 带上板块：同一个偏好 key 不会跨板块累计到三次（Codex P1-5）
    const ck = `${scopeKey}|${candidateKeyOf(t, key)}`
    if (!ck) return { ok: false, message: '没有可用的 key' }
    const now = Number(at) || Date.now()
    const s = load()
    s.memoryCandidates = Array.isArray(s.memoryCandidates) ? s.memoryCandidates : []
    const dup = s.memoryCandidates.find((c) => c.status === 'candidate' && c.key === ck)
    if (dup) {
      dup.mentions = (Number(dup.mentions) || 1) + 1
      dup.lastAt = now
      if (t.length >= String(dup.text || '').length) dup.text = t
      dup.importance = Math.max(Number(dup.importance) || 0, Math.max(0, Math.min(1, Number(importance) || 0.45)))
      dup.confidence = Math.max(Number(dup.confidence) || 0, Math.max(0, Math.min(1, Number(confidence) || 0.45)))
      dup.decision = 'new'
      s.rev = (s.rev || 0) + 1
      save(s)
      return { ok: true, updated: dup.id, id: dup.id, mentions: dup.mentions, key: ck }
    }
    const item = {
      id: randomUUID().slice(0, 8),
      key: ck,
      text: t,
      about: String(about || ''),
      aboutName: String(aboutName || ''),
      tags: (Array.isArray(tags) ? tags : []).slice(0, 5),
      importance: Math.max(0, Math.min(1, Number(importance) || 0.45)),
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0.45)),
      source: String(source || 'auto'),
      chatId: String(chatId || ''),
      kind: kind === 'event' ? 'event' : 'fact',
      scope: scopeKey,
      op: String(op || 'add'),
      targetId: String(targetId || ''),
      status: 'candidate',
      decision: 'new',
      mentions: 1,
      firstAt: now,
      lastAt: now,
      lastJudgedAt: 0,
    }
    s.memoryCandidates.push(item)
    // 留审计，但池子不能无限长：优先保留未决候选，已决最多留 100 条。
    if (s.memoryCandidates.length > 1000) {
      const pending = s.memoryCandidates.filter((c) => c.status === 'candidate')
      const resolved = s.memoryCandidates.filter((c) => c.status !== 'candidate').slice(-100)
      s.memoryCandidates = [...pending, ...resolved].slice(-1000)
    }
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true, id: item.id, mentions: 1, key: ck }
  }

  /**
   * 日终裁决。期 1 的死规则：同一 key 累计被提及 >= 3 次 → pass；
   * 14 天仍只出现 1 次 → block；其余 mark，继续留在候选池观察。
   */
  function judgeCandidates({ now = Date.now() } = {}) {
    const s0 = load()
    const list = activeCandidates(s0)
    const decisions = []
    for (const c of list) {
      const ageDays = Math.max(0, (Number(now) - Number(c.firstAt || c.at || now)) / 86400_000)
      if ((Number(c.mentions) || 1) >= CANDIDATE_PASS_MENTIONS) decisions.push({ id: c.id, next: 'passed', c })
      else if (ageDays >= CANDIDATE_STALE_DAYS) decisions.push({ id: c.id, next: 'blocked', c })
      else decisions.push({ id: c.id, next: 'mark', c })
    }

    let passed = 0
    let marked = 0
    let blocked = 0
    const resolved = new Map()
    for (const d of decisions) {
      if (d.next !== 'passed') continue
      const c = d.c
      const r = add({ text: c.text, about: c.about, aboutName: c.aboutName, tags: c.tags, importance: c.importance, source: 'auto', chatId: c.chatId, kind: c.kind, scope: c.scope })
      if (!r.ok) continue
      const factId = r.id || r.updated || ''
      if (c.op === 'outdated' && c.targetId) invalidate(c.targetId, factId)
      resolved.set(c.id, { factId })
      passed += 1
    }

    const s = load()
    for (const d of decisions) {
      const c = (s.memoryCandidates || []).find((x) => x.id === d.id)
      if (!c) continue
      c.lastJudgedAt = Number(now)
      if (d.next === 'passed') {
        if (!resolved.has(d.id)) continue
        c.status = 'passed'
        c.decision = 'pass'
        c.factId = resolved.get(d.id).factId
        c.resolvedAt = Number(now)
      } else if (d.next === 'blocked') {
        c.status = 'blocked'
        c.decision = 'block'
        c.resolvedAt = Number(now)
        blocked += 1
      } else {
        c.decision = 'mark'
        marked += 1
      }
    }
    // 归档：blocked 之后再过 CANDIDATE_ARCHIVE_DAYS 天，就从池子里清掉（记忆库不受影响），避免文件无限增长
    const dropBefore = Number(now) - CANDIDATE_ARCHIVE_DAYS * 86400_000
    const beforeCount = (s.memoryCandidates || []).length
    s.memoryCandidates = (s.memoryCandidates || []).filter((c) => !(c.status === 'blocked' && Number(c.resolvedAt || 0) < dropBefore))
    const archived = beforeCount - s.memoryCandidates.length
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true, pending: activeCandidates(s).length, passed, marked, blocked, archived }
  }

  function candidateList({ includeResolved = false } = {}) {
    const s = load()
    const all = Array.isArray(s.memoryCandidates) ? s.memoryCandidates : []
    return all.filter((c) => includeResolved || c.status === 'candidate').map((c) => ({ ...c }))
  }

  function candidateStats() {
    const all = Array.isArray(load().memoryCandidates) ? load().memoryCandidates : []
    return {
      pending: all.filter((c) => c.status === 'candidate').length,
      passed: all.filter((c) => c.status === 'passed').length,
      blocked: all.filter((c) => c.status === 'blocked').length,
    }
  }

  // ---------- T-045 待确认审阅：模型拿不准的先给人过一眼，再决定进不进卡 ----------
  const REVIEW_MAX_BULK = 60
  const reviewBrief = (c) => ({
    id: c.id,
    text: String(c.text || ''),
    scope: String(c.scope || ''),
    aboutName: String(c.aboutName || ''),
    importance: Number(c.importance) || 0,
    mentions: Number(c.mentions) || 1,
    firstAt: Number(c.firstAt || c.at) || 0,
    lastAt: Number(c.lastAt || c.firstAt || c.at) || 0,
    // 空板块的候选本来就不会注入任何场合，面板上要标出来，别让人以为确认了就能用
    noScope: !c.scope,
  })

  /** 今天新增的候选 + 历史积压（all=true 时才带积压明细，免得每次刷面板都传 100 多条）。 */
  function reviewQueue({ all = false, now = Date.now() } = {}) {
    const pending = activeCandidates(load())
    const today = dayKey(new Date(now))
    const sameDay = (t) => Number(t) > 0 && dayKey(new Date(Number(t))) === today
    const todayList = pending.filter((c) => sameDay(c.firstAt || c.at) || sameDay(c.lastAt))
    const backlog = pending
      .filter((c) => !todayList.includes(c))
      .sort((a, b) => (Number(a.firstAt || a.at) || 0) - (Number(b.firstAt || b.at) || 0))
    return {
      ok: true,
      day: today,
      pending: pending.length,
      today: todayList.map(reviewBrief),
      backlogCount: backlog.length,
      backlog: all ? backlog.map(reviewBrief) : [],
    }
  }

  /**
   * 人对一条候选下裁决：fact=确认是事实、event=记成经过、drop=丢掉。
   * 22:00 的自动裁决可能已经把这条处理掉，所以落库前再查一次 status（幂等）。
   */
  function decideReview(id, decision) {
    const d = String(decision || '').trim()
    if (!['fact', 'event', 'drop'].includes(d)) return { ok: false, message: '不认识的裁决：' + d }
    const s0 = load()
    const c = (Array.isArray(s0.memoryCandidates) ? s0.memoryCandidates : []).find((x) => x && x.id === String(id))
    if (!c) return { ok: false, message: '找不到这条候选，可能已经清理了' }
    if (c.status !== 'candidate') return { ok: false, message: '这条已经处理过了' }
    if (d !== 'drop') {
      // 板块必须落定：空板块的候选如果是「确认/经过」，写进去也不会被任何场合看见，
      // 与其让 add() 悄悄重算（结果和审阅时看到的不一样），不如先算清楚、算不出来就拒绝。
      const cfg = typeof getConfig === 'function' ? getConfig() : null
      const scope = String(c.scope || '').trim() || resolveMemoryScope({
        chatId: c.chatId, about: c.about, aboutName: c.aboutName, text: c.text,
        source: 'auto', tags: c.tags, ownerQQ: cfg?.ownerQQ, ownerName: cfg?.ownerName, profiles: s0.profiles,
      })
      if (!scope) return { ok: false, message: '这条没有板块，写进去也不会生效；建议直接删掉' }
      const r = add({
        text: c.text,
        about: c.about || '',
        aboutName: c.aboutName || '',
        tags: c.tags || [],
        importance: c.importance,
        source: 'auto',
        chatId: c.chatId || '',
        kind: d === 'event' ? 'event' : 'fact',
        scope,
      })
      if (!r.ok) return { ok: false, message: r.message || '写不进记忆' }
      const s = load()
      const c2 = (s.memoryCandidates || []).find((x) => x.id === c.id)
      if (c2) {
        c2.status = 'passed'
        c2.decision = d === 'event' ? 'event' : 'pass'
        c2.factId = r.id || r.updated || ''
        c2.resolvedAt = Date.now()
        c2.lastJudgedAt = Date.now()
        s.rev = (s.rev || 0) + 1
        save(s)
      }
      return { ok: true, message: d === 'event' ? '记成经过了' : '记成事实了', id: c.id, factId: r.id || r.updated || '', scope, ...reviewQueue() }
    }
    const s = load()
    const c2 = (s.memoryCandidates || []).find((x) => x.id === c.id)
    if (c2) {
      c2.status = 'blocked'
      c2.decision = 'block'
      c2.resolvedAt = Date.now()
      c2.lastJudgedAt = Date.now()
      s.rev = (s.rev || 0) + 1
      save(s)
    }
    return { ok: true, message: '丢了', id: c.id, ...reviewQueue() }
  }

  /** 批量裁决（面板「今天这些都算事实」/积压批量处理）。一次上限 60 条，逐条都走同一套校验。 */
  function decideReviewMany(ids, decision) {
    const list = (Array.isArray(ids) ? ids : []).slice(0, REVIEW_MAX_BULK)
    let done = 0
    const failed = []
    for (const id of list) {
      const r = decideReview(id, decision)
      if (r.ok) done += 1
      else failed.push({ id: String(id), message: r.message || '失败' })
    }
    return { ok: true, done, failed, message: `处理了 ${done} 条${failed.length ? `，${failed.length} 条没动` : ''}`, ...reviewQueue() }
  }
  /** 导入旧档案第一步：让模型从一大段文字里挑出值得记的，返回候选（不直接存）。 */
  async function importCandidates(text) {
    const src = String(text || '').trim()
    if (!src) return []
    const chunks = []
    for (let i = 0; i < src.length && chunks.length < 6; i += 5000) chunks.push(src.slice(i, i + 5000))
    const out = []
    for (const part of chunks) {
      const r = await askModel(dsh, {
        cfg: getConfig(),
        system: '你帮一个叫「大肥鱼」的聊天角色从旧档案（设定、聊天笔记、以前的记忆文件）里挑出值得长期记住的事：别人的名字/称呼、喜好、身份、约定、重要经历、和她的关系。不要记她自己的人设和外貌（那些在人格里），不要记无关的说明文字。每条一句话、主语写清楚。只输出 JSON 数组，例如 [{"text":"小明喜欢吃辣","about":"小明","importance":0.6}]。',
        text: part,
        maxTokens: 4000,
        temperature: 0.2,
      })
      const m = String(r).match(/\[[\s\S]*\]/)
      try { for (const x of m ? JSON.parse(m[0]) : []) if (x && x.text) out.push({ text: String(x.text).slice(0, 200), aboutName: String(x.about || ''), importance: Math.max(0, Math.min(1, Number(x.importance) || 0.5)) }) } catch (error) {}
    }
    // 和已有记忆、彼此之间去重
    const have = load().items
    const uniq = []
    for (const c of out) if (!have.some((m) => similarity(m.text, c.text) >= 0.6) && !uniq.some((u) => similarity(u.text, c.text) >= 0.6)) uniq.push(c)
    return uniq.slice(0, 80)
  }

  /** 导入旧档案第二步：把勾选的候选存进记忆库。 */
  function importCommit(items) {
    let n = 0
    for (const c of items || []) if (add({ text: c.text, aboutName: c.aboutName || '', importance: c.importance ?? 0.5, source: 'import' }).id) n++
    return n
  }

  /** 她自己做过的事（唱了歌、在空间评论了谁……）：记成「经历」，最近一天的会常驻在上下文里。 */
  function addEvent({ text, about = '', aboutName = '', tags = [], importance = 0.45, scope = '' }) {
    return add({ text, about, aboutName, tags: ['经历', ...tags], importance, source: 'event', kind: 'event', scope })
  }

  // ---------- 经历流（T-031）：她真的开口后，把「她说了什么」记成一条 self 经历 ----------
  const SAID_PER_CHAT_HOUR = 4
  const SAID_OWNER_HOUR = 6
  const SAID_PER_DAY = 80
  const SAID_DEDUPE_MS = 86400_000
  // 敏感信息（QQ/手机号/邮箱/链接）不进 self
  const SAID_SENSITIVE = /(?:^|\D)\d{5,12}(?:\D|$)|1[3-9]\d{9}|[\d][\d\s-]{7,}\d|[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}|https?:\/\//i
  // 无协议链接（www.x.com / b23.tv/xxx）也算敏感：Codex P2
  const SAID_DOMAIN = /\b(?:[a-z0-9-]+\.)+(?:com|cn|net|org|tv|cc|top|xyz|io|me|app|be|dev|ai|co|info|site|online|shop|link|run|art|design|plus|ink)\b/i
  // 成段引用别人原话（≥8 字）算转述，不写进 self（Codex §4.1 ①）
  const SAID_QUOTED = /[「『“"][^」』”"]{8,}[」』”"]/
  // 回复里的表情/语音/图片标记不进 self（会写成「好呀<sticker:开心>」这种）
  const SAID_TAG = /<\/?(?:sticker|voice|face|image|at|reply|poke)[^>]*>/gi

  function saidPlace(cid, c) {
    if (cid.startsWith('group:')) return '在群里说：'
    const qq = cid.slice('private:'.length)
    return qq === String(c?.ownerQQ || '') ? '和主人说：' : '和朋友说：'
  }


  /**
   * 记一条「她刚说了什么」。纯拼接、零模型调用；只写她自己的话。
   * 拿不准就不写（隐私边界），限额与去重防库膨胀（T-031 §2.2）。
   */
  function noteSaid({ chatId = '', reply = '', userText = '', phase = 'final' } = {}) {
    const c = typeof getConfig === 'function' ? getConfig() : null
    if (!c?.memory?.enabled) return { ok: false, skipped: 'disabled' }
    const cid = String(chatId || '')
    if (!cid || cid.startsWith('system:')) return { ok: false, skipped: 'system' }
    // 带工具调用的中间步骤会先发一句垫话（「让我看看」），那些不算她的正式回复（Codex P1-2）
    if (phase === 'mid') return { ok: false, skipped: 'mid' }
    // 记下发生地：她的话按场合收窄，私聊里说的话不会进群/抖音（Codex 复核 P0）
    const board = boardFromChatId(cid, c?.ownerQQ)
    if (!board) return { ok: false, skipped: 'board' }
    const body = String(reply || '').replace(SAID_TAG, '').replace(/\s+/g, ' ').trim()
    if (!body) return { ok: false, skipped: 'empty' }
    if (SAID_SENSITIVE.test(body) || SAID_DOMAIN.test(body)) return { ok: false, skipped: 'sensitive' }
    if (SAID_QUOTED.test(body)) return { ok: false, skipped: 'quote' }
    const ask = String(userText || '').replace(/\s+/g, '')
    if (ask.length >= 8) {
      const head = ask.slice(0, 8)
      const tail = ask.slice(-8)
      const flat = body.replace(/\s+/g, '')
      if (flat.includes(head) || (tail !== head && flat.includes(tail))) return { ok: false, skipped: 'retell' }
    }
    const text = `${saidPlace(cid, c)}${body.slice(0, 60)}`.slice(0, 80)
    const s = load()
    const now = Date.now()
    const rows = (Array.isArray(s.items) ? s.items : []).filter((m) => m && m.source === 'turn' && !m.invalidAt)
    const cap = cid === `private:${String(c?.ownerQQ || '')}` ? SAID_OWNER_HOUR : SAID_PER_CHAT_HOUR
    if (rows.filter((m) => String(m.chatId) === cid && Number(m.at) >= now - 3600_000).length >= cap) return { ok: false, skipped: 'rate' }
    if (rows.filter((m) => Number(m.at) >= now - 86400_000).length >= SAID_PER_DAY) return { ok: false, skipped: 'daily' }
    // 去重改成「整句相同」：原来比前 30 字，同一句开头不同结尾的合法回复会被误吞（Codex P2）
    const sameBody = body.slice(0, 60)
    if (rows.some((m) => {
      if (String(m.chatId) !== cid || Number(m.at) < now - SAID_DEDUPE_MS) return false
      const t = String(m.text || '')
      const i = t.indexOf('：')
      return i > 0 && t.slice(i + 1) === sameBody
    })) return { ok: false, skipped: 'dup' }
    s.items.push({ id: randomUUID().slice(0, 8), text, about: '', aboutName: '', tags: ['经历'], importance: 0.3, source: 'turn', chatId: cid, board, kind: 'event', scope: 'self', at: now, hits: 0 })
    // 兜底上限：日摘要合并是二期，这里先只留最近 800 条，避免声音流把记忆库顶满
    const turns = s.items.filter((m) => m.source === 'turn')
    if (turns.length > 800) {
      const drop = new Set(turns.sort((a, b) => a.at - b.at).slice(0, turns.length - 800).map((m) => m.id))
      s.items = s.items.filter((m) => !drop.has(m.id))
    }
    if (s.items.length > MEMORY_MAX_ITEMS) s.items = capItems(s.items)
    save(s)
    return { ok: true, text }
  }

  /** 最近 hours 小时里她做过的事（经历 + 空间日记），新的在前。传 scope 就只看这一块。 */
  function recentEvents(hours = 24, limit = 4, scope = '', people = []) {
    const since = Date.now() - hours * 3600_000
    return load().items
      .filter((m) => (m.source === 'event' || m.source === 'diary' || m.source === 'turn') && m.at >= since && (scope ? scopeVisible(m, scope) : visibleForAdmin(m)))
      .sort((a, b) => b.at - a.at).slice(0, limit)
  }

  function update(id, patch) {
    const s = load()
    const m = s.items.find((x) => x.id === id)
    if (!m) return { ok: false, message: '没有这条' }
    for (const k of ['text', 'about', 'aboutName', 'tags', 'importance', 'scope', 'kind']) if (patch[k] !== undefined) m[k] = patch[k]
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true, item: m }
  }

  /** 补充或改正一条旧记忆：换成新说法，旧说法留进 history。 */
  function revise(id, text, importance) {
    const s = load()
    const m = s.items.find((x) => x.id === id)
    const t = String(text || '').trim().slice(0, 200)
    if (!m || !t) return false
    m.history = [...(m.history || []), { text: m.text, at: m.at }].slice(-3)
    m.text = t
    m.at = Date.now()
    m.importance = Math.max(Number(m.importance) || 0, Number(importance) || 0)
    s.rev = (s.rev || 0) + 1
    save(s)
    return true
  }

  /** 标成过时：不再被想起，但不删（面板里能看到被哪条取代、能恢复）。 */
  function invalidate(id, byId = '') {
    const s = load()
    const m = s.items.find((x) => x.id === id)
    if (!m) return false
    m.invalidAt = Date.now()
    if (byId) m.supersededBy = byId
    s.rev = (s.rev || 0) + 1
    save(s)
    return true
  }

  function restore(id) {
    const s = load()
    const m = s.items.find((x) => x.id === id)
    if (!m) return { ok: false, message: '没有这条' }
    delete m.invalidAt
    delete m.supersededBy
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true }
  }

  function remove(id) {
    const s = load()
    s.items = s.items.filter((m) => m.id !== id)
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true }
  }

  const recallLog = [] // 最近几次想起了什么（给面板看）
  function recall(query, { about, limit, where = '', context = '', board = '', people = [], route: givenRoute = null } = {}) {
    const max = limit ?? getConfig().memory.recallCount
    // 不知道在哪个场合（board 为空）就一条都不给：未知 board 必须 fail-closed（Codex P1-6）。
    // 管理视图（面板列表/日报）走 list()/overview()，不要复用聊天可见性入口。
    const allow = (it) => scopeVisible(it, board)
    const speaker = Array.isArray(about) ? about[0] : about
    const route = givenRoute || routeFor(query, people, speaker)
    const hits = search(index(), query, { about, limit: max, allow, eventHalfLifeDays: decayOpts().eventHalfLifeDays, route })
    // 这一句没想起几条（「嗯嗯」「然后呢」）：用上一句再找找，分数打折
    if (context && hits.length < max) {
      const have = new Set(hits.map((h) => h.it.id))
      const ctxRoute = routeFor(context, people, speaker)
      for (const h of search(index(), context, { about, limit: max, minScore: 0.5, allow, eventHalfLifeDays: decayOpts().eventHalfLifeDays, route: ctxRoute })) {
        if (hits.length >= max) break
        if (!have.has(h.it.id)) hits.push({ ...h, score: h.score * 0.6, why: [...(h.why || []), '（上一句）'] })
      }
    }
    // 记忆图谱（T-040）：顺着命中的记忆走 1 跳，补 1–2 条相关的事（不跨板块）
    const graphCfg = getConfig().memory.graph || {}
    let graphAdded = 0
    const rawMax = Number(graphCfg.maxNeighbors)
    const maxNeighbors = Number.isFinite(rawMax) ? Math.max(0, Math.trunc(rawMax)) : 2
    if (graphCfg.enabled !== false && maxNeighbors > 0 && hits.length) {
      const extra = expandNeighbors(hits, graphIndex(), { maxNeighbors, allow: (item) => scopeVisible(item, board) })
      for (const x of extra) {
        if (!x?.item || hits.some((h) => h.it.id === x.item.id)) continue
        // 插在来源命中后面，别永远排在末尾（v2 只注入前 3 条）
        const idx = hits.findIndex((h) => h.it.id === x.via)
        hits.splice(idx >= 0 ? idx + 1 : hits.length, 0, { it: x.item, score: Number(x.score) || 0.3, why: ['（关联）'] })
        graphAdded++
      }
    }
    recallLog.unshift({ at: Date.now(), where, query: String(query).slice(0, 120), route: route ? { slots: route.slots, topics: route.topics, who: route.who, dayKeys: route.dayKeys } : null, graphAdded, hits: hits.map((h) => ({ id: h.it.id, text: h.it.text, score: Number(h.score.toFixed(2)), why: h.why || [] })) })
    recallLog.length = Math.min(recallLog.length, 20)
    if (hits.length) {
      const s = load()
      for (const h of hits) {
        const m = s.items.find((x) => x.id === h.it.id)
        if (!m) continue
        // 强度按「被想起过几天」算，同一天想起多次只算一次；图补的弱关联不攒 hitDays（防自我强化）
        const related = Array.isArray(h.why) && h.why.includes('（关联）')
        if (!related && (!m.lastHit || new Date(m.lastHit).toDateString() !== new Date().toDateString())) m.hitDays = (m.hitDays || 0) + 1
        m.hits = (m.hits || 0) + 1
        m.lastHit = Date.now()
      }
      writeJson(file(), s) // 只改命中计数，不动索引
    }
    return hits
  }

  // ---------- 相处经验：按人（私聊按 QQ 号，群按群）归类的、概括性的「怎么和 TA 相处」，越聊越懂 ----------
  const personKey = (chat) => (chat.kind === 'group' ? `group:${chat.groupId}` : chat.userId ? `qq:${chat.userId}` : '')
  function insightsOf(key) {
    return (load().insights || {})[key] || []
  }
  function setInsights(key, list, name) {
    const s = load()
    s.insights = s.insights || {}
    s.insightNames = s.insightNames || {}
    s.insights[key] = list.slice(0, 8)
    if (name) s.insightNames[key] = name
    s.rev = (s.rev || 0) + 1
    save(s)
  }

  // ---------- 说话方式：聊久了潜移默化学到的（对方的说话习惯 + 她自己慢慢养成的说法） ----------
  function styleOf(key) {
    return (load().styles || {})[key] || []
  }
  function setStyle(key, list) {
    const s = load()
    s.styles = s.styles || {}
    s.styles[key] = list.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, key === 'self' ? 6 : 5)
    s.rev = (s.rev || 0) + 1
    save(s)
  }

  // ---------- 人物小档案：每个人一小段印象（是谁、什么关系、喜好、近况），聊天时常驻 ----------
  // 按「板块 + QQ」存（owner|QQ、group:123456|QQ、friend:QQ|QQ）：群里的档案只用群里的记忆写，
  // 不会在群里把私聊里知道的事说出来（P1-5）。旧数据只有 QQ 键，读的时候按 owner 兜底。
  const profileKey = (scope, qq) => `${String(scope || 'owner')}|${String(qq)}`
  function profileFrom(store, qq, scope = 'owner') {
    const s = store || {}
    const hit = s[profileKey(scope, qq)]
    if (hit) return hit
    return scope === 'owner' ? s[String(qq)] || null : null
  }
  function profileOf(qq, scope = 'owner') {
    return profileFrom(load().profiles, qq, scope)
  }
  function setProfile(qq, text, name = '', scope = 'owner') {
    const s = load()
    s.profiles = s.profiles || {}
    const k = profileKey(scope, qq)
    const t = String(text || '').trim().slice(0, 200)
    if (t) {
      const prev = s.profiles[k] || (scope === 'owner' ? s.profiles[String(qq)] : null)
      s.profiles[k] = { text: t, name: name || prev?.name || '', at: Date.now(), scope }
      // 旧口径的纯 QQ 键一起清掉，否则面板里同一个人两份（Codex 复核 P1）
      if (scope === 'owner' && k !== String(qq)) delete s.profiles[String(qq)]
    } else {
      delete s.profiles[k]
      if (scope === 'owner') delete s.profiles[String(qq)] // 旧口径的全局键一起清掉，免得面板里两份
    }
    s.rev = (s.rev || 0) + 1
    save(s)
  }

  /** 按这个人在这个板块里的记忆重写小档案（少于 3 条不写）。 */
  async function buildProfile(qq, scope = 'owner') {
    const cfg = getConfig()
    const mine = load().items.filter((m) => !m.invalidAt && String(m.about) === String(qq) && scopeVisible(m, scope)).sort((a, b) => a.at - b.at)
    if (mine.length < 3) return false
    const name = mine.filter((m) => m.aboutName).at(-1)?.aboutName || ''
    const old = profileFrom(load().profiles, qq, scope)?.text || ''
    const out = await askModel(dsh, {
      cfg,
      system: '你是「大肥鱼」。根据你记得的关于一个人的事，写一张给自己看的人物小档案：TA 是谁、怎么称呼、和你什么关系、性格和喜好、最近在忙什么。只写记忆里明确有的，不要推测性格、不要编，也不要写「应该」「可能」这种猜的话；旧档案和新记忆矛盾时以新记忆为准。用第三人称，一段话，100 字以内，不要标题和列表。',
      text: `${String(qq) === String(cfg.ownerQQ) ? `这是你的${cfg.ownerName || '主人'}。\n` : ''}旧档案：${old || '（还没有）'}\n\n记得的事（越往下越新）：\n${mine.slice(-40).map((m) => `- [${whenText(m.at)}] ${m.text}`).join('\n')}`,
      maxTokens: 1500,
      temperature: 0.3,
    })
    const text = String(out || '').trim().replace(/^[「"]|[」"]$/g, '')
    if (!text) throw new Error('模型没写出东西，等会儿再试')
    setProfile(qq, text, name, scope)
    return true
  }

  /**
   * 常驻上下文（system prompt）：人物小档案 + 相处经验 + 说话方式。
   * 这三样一天只变几次，不会把整份 runtime context 拖着每轮重抄。
   * 每轮都在变的内容（按这句话检索到的记忆、最近做过的事）走 volatileFor。
   */
  function contextFor(chat, sessionId) {
    const cfg = getConfig().memory
    if (!cfg.enabled) return ''
    const parts = []
    // 对这个人（群里是正在说话的几个人）的印象，不用等关键词碰上
    const people = chat.kind === 'group' ? (hub?.speakersOf?.(sessionId) || []).slice(0, 3) : chat.userId ? [chat.userId] : []
    // 档案按板块注入：只用本板块的档案（群里的那份由群里的记忆写成），换场合就换一份，不串私事
    const scope = scopeOfChat(chat, getConfig().ownerQQ)
    const store = scope ? load().profiles : null
    const profs = scope ? people.map((qq) => profileFrom(store, qq, scope)).filter(Boolean) : []
    if (profs.length) parts.push('（你对' + (chat.kind === 'group' ? '正在说话的人' : '对方') + '的印象：' + profs.map((p) => (chat.kind === 'group' && p.name ? p.name + '——' : '') + p.text).join('；') + '）')
    const ins = insightsOf(personKey(chat))
    if (ins.length) parts.push('（和' + (chat.kind === 'group' ? '这个群' : '对方') + '相处的经验，照着做就好，不用说出来：' + ins.map((x) => x.text).join('；') + '）')
    const sty = styleOf(personKey(chat))
    const self = styleOf('self')
    if (sty.length || self.length) {
      parts.push('（说话方式：' + [sty.length ? '和' + (chat.kind === 'group' ? '这个群' : '对方') + '聊久了，' + sty.join('；') : '', self.length ? '你平时不知不觉会用的说法：' + self.join('、') : ''].filter(Boolean).join('。') + '。自然带一点就好，别刻意模仿，也别变成另一个人。）')
    }
    return parts.join('\n')
  }

  const v2Turns = new Map()
  const v2Cards = new Map()

  function volatileInputs(chat, sessionId) {
    const scope = scopeOfChat(chat, getConfig().ownerQQ)
    // 不知道是哪个场合就不给：recentEvents 在没有 scope 时走的是管理视图，不能拿来做聊天注入（Codex P1-6）
    if (!scope) return { recent: [], q: hub?.lastTextOf?.(sessionId) || '', hits: [] }
    const people = chat.kind === 'group' ? (hub?.speakersOf?.(sessionId) || []) : chat.userId ? [chat.userId] : []
    const recent = recentEvents(24, 4, scope, people)
    const q = hub?.lastTextOf?.(sessionId) || ''
    const route = q ? routeFor(q, people, chat.kind === 'group' ? (hub?.speakersOf?.(sessionId) || [])[0] : chat.userId) : null
    let hits = []
    if (q) {
      const about = chat.kind === 'group' ? hub?.speakersOf?.(sessionId) || [] : chat.userId
      const shown = new Set(recent.map((m) => m.id))
      hits = recall(q, { about, where: chat.chatId || '', board: scope, people, route, context: q.length < 12 ? hub?.prevTextOf?.(sessionId) || '' : '' })
        .filter((h) => !shown.has(h.it.id) && scopeVisible(h.it, scope))
    }
    return { recent, q, hits, route }
  }

  function legacyVolatile(chat, inputs = volatileInputs(chat)) {
    const parts = []
    if (inputs.recent.length) parts.push('（你最近做过的事：' + inputs.recent.map((m) => `${agoText(m.at)}${m.text}`).join('；') + '。聊到了可以自然提起。）')
    if (inputs.hits.length) parts.push('（你记得这些事，方括号里是什么时候的事，聊到相关的就自然用上，别把老事当新事说，也别说「根据记忆」：' + inputs.hits.map((h) => memoryLine(h.it)).join('；') + '）')
    return parts.join('\n')
  }

  function recentChatRecords(chatId, now = Date.now()) {
    if (!chatId) return []
    const cutoff = now - RECENT_LOOKBACK_DAYS * 86400_000
    const rows = []
    for (const day of hub?.chatLogDays?.() || []) {
      const at = Date.parse(`${day}T00:00:00`)
      if (Number.isFinite(at) && at < cutoff) continue
      for (const row of hub?.chatLogOf?.(day) || []) {
        if (!chatId || String(row?.chatId || '') === String(chatId)) rows.push(row)
      }
    }
    return rows
  }

  function matchedMemoryText(hits) {
    if (!hits.length) return ''
    return '（你记得这些事，方括号里是什么时候的事，聊到相关的就自然用上，别把老事当新事说，也别说「根据记忆」：'
      + hits.slice(0, 3).map((h) => memoryLine(h.it)).join('；') + '）'
  }

  /** 事实卡分组用的人名表：uid → 称呼。相处记录里的名字优先，其次 owner 配置。 */
  function personNamesOf(s) {
    const names = {}
    for (const [k, n] of Object.entries(s.insightNames || {})) {
      const uid = String(k).replace(/^qq:/, '').trim()
      if (uid && n) names[uid] = String(n)
    }
    for (const [uid, p] of profilesByQQ(s.profiles)) {
      const n = p && (p.name || '')
      if (uid && n && !names[uid]) names[uid] = String(n)
    }
    const c = typeof getConfig === 'function' ? getConfig() : null
    const ownerUid = String(c?.ownerQQ || '').trim()
    if (ownerUid) names[ownerUid] = String(c?.ownerName || '主人') // 主人永远用主人称呼，别被 insightNames 里的 QQ 昵称拆成两组
    return names
  }

  function v2Volatile(chat, sessionId, v2, inputs, legacy, now = Date.now()) {
    const key = String(sessionId || chat.chatId)
    const turn = (v2Turns.get(key) || 0) + 1
    v2Turns.set(key, turn)
    const cardDue = turn === 1 || (turn - 1) % CARD_REFRESH_TURNS === 0
    let card = v2Cards.get(key) || null
    let cardGenerated = false
    const s = load()
    const items = Array.isArray(s.items) ? s.items : []
    const scope = scopeOfChat(chat, getConfig().ownerQQ)
    const people = chat.kind === 'group' ? (hub?.speakersOf?.(sessionId) || []) : chat.userId ? [chat.userId] : []
    // 抖音（system）走轻量版：卡小一点、经历少一点，只带抖音/朋友/自己
    const light = chat.kind === 'system'
    if (cardDue) {
      // 事实卡只吃事实，且只看这一块（主人私聊 / 某个群 / 抖音），不串味
      const facts = items.filter((m) => m && !m.invalidAt && !isEventMemory(m) && m.source !== 'diary' && m.scope !== 'identity' && !isIdentityFact(m) && scopeVisible(m, scope))
      card = buildFactCard(facts, { maxChars: light ? 500 : v2.cardMaxChars, topics: Array.isArray(s.topics) ? s.topics : [], now, personNames: personNamesOf(s) })
      v2Cards.set(key, card)
      cardGenerated = true
    }

    // 经历流：本场合 4 条 + 其他场合 2 条（T-031）；字数预算与原来一样（600 / 抖音 400）
    const eventSlice = formatEventSliceMixed(items.filter((m) => scopeVisible(m, scope)), { chatId: chat.chatId, board: scope, hours: 24, maxItems: 4, otherMaxItems: 2, maxChars: light ? 400 : 600, now })

    const recentSlice = formatRecentSlice({
      records: recentChatRecords(chat.chatId, now),
      chatId: chat.chatId,
      hours: 24,
      maxChars: v2.recentMaxChars,
      perTurn: 600,
      fallbackTurns: 6,
      now,
    })
    const parts = []
    // T-037 全局身份卡：每个场合都带一小段「你是谁、主人是谁、你的资料」，不含私事
    const idCfg = getConfig().memory.identity || {}
    const identity = idCfg.enabled === false
      ? { text: '', chars: 0, included: [] }
      : buildIdentityCard({ items, ownerName: getConfig().ownerName || '主人', botName: idCfg.botName || '大肥鱼', maxChars: idCfg.maxChars || 500 })
    if (identity.text) parts.push(identity.text)
    const cardInjected = Boolean(cardDue && card?.text)
    if (cardInjected) parts.push(card.text)
    if (eventSlice.text) parts.push(eventSlice.text)
    if (recentSlice.text) parts.push(recentSlice.text)
    if (!cardInjected) {
      const matched = matchedMemoryText(inputs.hits)
      if (matched) parts.push(matched)
    }
    const text = parts.join('\n\n')
    return {
      text,
      turn,
      cardDue,
      cardGenerated,
      card: card || { text: '', chars: 0, included: [] },
      recent: recentSlice,
      event: eventSlice,
      legacy,
      route: inputs.route || null,
      identity,
    }
  }

  function writeMemoryShadow(chat, sessionId, result, now = Date.now()) {
    try {
      const hitIds = result.inputs.hits.map((h) => h.it.id)
      const cardIds = new Set((result.card.included || []).map((f) => f.id).filter(Boolean))
      const overlap = hitIds.length ? hitIds.filter((id) => cardIds.has(id)).length / hitIds.length : 0
      appendFileSync(dataDir('memory-shadow.jsonl'), JSON.stringify({
        at: now,
        chatId: chat.chatId || '',
        sessionId: sessionId || '',
        turn: result.turn,
        cardGenerated: result.cardGenerated,
        cardChars: result.card.chars || 0,
        eventChars: result.event?.chars || 0,
        eventCount: result.event?.count || 0,
        recentChars: result.recent.chars || 0,
        legacyChars: result.legacy.length,
        identityChars: result.identity?.chars || 0,
        route: result.route ? { slots: result.route.slots, topics: result.route.topics, who: result.route.who, dayKeys: result.route.dayKeys } : null,
        newChars: result.text.length,
        hitIds,
        cardFactIds: [...cardIds],
        overlapRate: Number(overlap.toFixed(3)),
        fallback: Boolean(result.recent.fallback),
        cardText: result.card.text || '',
        eventText: result.event?.text || '',
        recentText: result.recent.text || '',
        newText: result.text,
        legacyText: result.legacy,
      }) + '\n', 'utf8')
    } catch (error) {
      log.debug('写记忆影子日志失败：', error.message)
    }
  }

  /**
   * 每轮都在变的上下文。期 1 的 A+B：
   * - v2 开启且非影子：每轮带最近原话；事实卡每 8 轮重建并缓存，其余轮只补 BM25 命中 1–3 条。
   * - 没有可靠的 DSH 压缩/轮转事件，所以按任务书 B 的兜底走每 N 轮，不伪装成“压缩后触发”。
   * - shadow=true 时返回旧逻辑文本；两种模式都写 memory-shadow.jsonl（关掉影子后靠它观察）。
   */
  function volatileFor(chat, sessionId) {
    const cfg = getConfig().memory
    if (!cfg.enabled) return ''
    backfillSelfProfile()
    const inputs = volatileInputs(chat, sessionId)
    const legacy = legacyVolatile(chat, inputs)
    if (!cfg.v2?.enabled) return legacy
    const result = v2Volatile(chat, sessionId, cfg.v2, inputs, legacy)
    result.inputs = inputs
    // 影子日志始终写：关掉 shadow 后，这里就是唯一能看到「她这轮实际拿到什么」的地方（2026-11-12）
    writeMemoryShadow(chat, sessionId, result)
    return cfg.v2.shadow ? legacy : result.text
  }

  /** 回顾：结合最近聊天和已有经验，更新这个人的相处经验（合并、提炼、最多 8 条，概括不琐碎）。 */
  async function reflect(chat, transcript) {
    const key = personKey(chat)
    if (!key) return 0
    const old = insightsOf(key)
    const oldStyle = styleOf(key)
    const who = chat.kind === 'group' ? '这个群' : '对方'
    const out = await askModel(dsh, {
      cfg: getConfig(),
      system: '你是「大肥鱼」，在回顾自己和' + who + '的相处。输出一个 JSON 对象 {"insights":[...],"style":[...]}。\n'
        + 'insights：「怎么相处更好」的经验。概括性的、可复用的相处之道（比如「他累的时候不想多聊，简单安慰就好」「喜欢被吐槽，不喜欢太正经」），不要记具体事件和事实细节；和已有经验重复的合并，过时或被证伪的删掉，不超过 8 条，每条不超过 30 字。\n'
        + 'style：' + who + '的说话方式，以及你和' + who + '聊天时可以自然贴近的地方（比如「消息很短，常一句话分几条发」「爱用“hhh”和“草”」「不爱用标点」「喜欢叠字」），只写说话的形式和习惯，不写内容；不超过 5 条，每条不超过 30 字。\n'
        + '只输出这个 JSON 对象。',
      text: `已有经验：\n${old.map((x) => '- ' + x.text).join('\n') || '（还没有）'}\n\n已记下的说话方式：\n${oldStyle.map((x) => '- ' + x).join('\n') || '（还没有）'}\n\n最近的聊天：\n${transcript}`,
      maxTokens: 1500,
      temperature: 0.3,
    })
    const { insights: rawIns, style: rawStyle } = parseReflection(out)
    if (rawStyle.length) setStyle(key, rawStyle)
    const arr = rawIns.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 8)
    if (!arr.length) return 0
    const now = Date.now()
    setInsights(key, arr.map((text) => old.find((x) => x.text === text) || { id: randomUUID().slice(0, 8), text, at: now }), chat.nickname || chat.groupId || '')
    log.info(`更新了和 ${key} 相处的经验（${arr.length} 条）`)
    return arr.length
  }

  // ---------- 每日整理：临时记忆（各会话的聊天流水）→ 长期记忆 + 相处经验，整理完清空 ----------
  // 各个 DSH 会话自己的对话上下文不动；这里只处理插件记下的聊天流水。

  /** 从一段聊天里提炼长期记忆，并回顾相处经验。lines：[{who, text}] */
  async function extractLines(chatId, lines) {
    const talk = lines.filter((l) => l.text && !String(l.text).startsWith('【系统'))
    const isQzone = chatId === 'qzone'
    const isGroup = String(chatId).startsWith('group:')
    // 空间动态一条就可能有料；聊天至少要几句
    if (talk.filter((l) => l.who !== 'bot').length < (isQzone ? 1 : 3)) return { ok: false, message: '内容太少', added: 0, events: 0, insights: 0 }
    const pad = (n) => String(n).padStart(2, '0')
    const hm = (t) => { const d = new Date(Number(t) || Date.now()); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
    // 带上时间和 QQ 号：模型才能写引文、把事记到人头上（群聊、空间里说话的人很多）
    const line = (l) => `${l.t ? `[${hm(l.t)}] ` : ''}${l.who === 'bot' ? '我' : l.uid ? `${l.who}(${l.uid})` : l.who}：${l.text}`
    try {
      // 按情境段切，最多处理最后 3 段；每段单独提炼（一段一个话题，抽得准）
      const segments = segmentLines(talk).slice(-3)
      let added = 0
      let events = 0
      let dropped = 0
      for (const seg of segments) {
        const r = await extractFacts(chatId, seg.map(line).join('\n'), { haystack: seg.map((l) => l.text).join('\n') })
        added += r.added
        events += r.events
        dropped += r.dropped
      }
      log.info(`从 ${chatId} 的${isQzone ? '空间动态' : '聊天'}里提炼了 ${added} 条记忆（事件 ${events} 条${dropped ? `，引文对不上丢弃 ${dropped} 条` : ''}），共 ${segments.length} 段`)
      if (isQzone) return { ok: true, added, events, insights: 0 }
      // 顺便回顾一次相处经验（用全天的聊天，最多最近 120 行）
      let ins = 0
      try {
        const [kind, id] = chatId.split(':')
        const chat = kind === 'group' ? { kind, groupId: id, nickname: '' } : { kind: 'private', userId: id, nickname: talk.filter((l) => l.who !== 'bot').at(-1)?.who || '' }
        ins = await reflect(chat, talk.slice(-120).map((l) => `${l.who === 'bot' ? '我' : l.who}：${l.text}`).join('\n'))
      } catch (error) {
        log.warn('回顾相处经验失败：', error.message)
      }
      return { ok: true, added, events, insights: ins }
    } catch (error) {
      log.warn('提炼记忆失败：', error.message)
      return { ok: false, message: error.message, added: 0, events: 0, insights: 0 }
    }
  }

  /** 这段聊天相关的旧记忆：关于在场的人的 + 和内容相关的，最多 15 条，给模型比对用。 */
  function relatedTo(chatId, transcript, board = '') {
    const ppl = new Set([...String(transcript).matchAll(/\((\d{5,})\)/g)].map((m) => m[1]))
    if (chatId.startsWith('private:')) ppl.add(chatId.slice(8))
    const items = load().items.filter((m) => !m.invalidAt && !isEventMemory(m) && m.source !== 'diary' && scopeVisible(m, board))
    const out = items.filter((m) => m.about && ppl.has(String(m.about))).sort((a, b) => b.at - a.at).slice(0, 10)
    for (const h of search(index(), String(transcript).slice(-1500), { limit: 8, minScore: 0.5, allow: (it) => scopeVisible(it, board), eventHalfLifeDays: decayOpts().eventHalfLifeDays })) {
      if (out.length >= 15) break
      if (!out.some((m) => m.id === h.it.id) && !isEventMemory(h.it) && h.it.source !== 'diary') out.push(h.it)
    }
    return out
  }

  async function extractFacts(chatId, transcript, { haystack = '' } = {}) {
    const cfg = getConfig()
    const isGroup = String(chatId).startsWith('group:')
    const source = chatId === 'qzone' ? '下面是 QQ 空间里的动态（好友发的说说、别人给你的评论、你的回复）' : isGroup ? '下面是一个群里的聊天（说话人很多，括号里是 QQ 号）' : '下面是一段聊天'
    const board = boardFromChatId(chatId, cfg.ownerQQ)
    const related = relatedTo(chatId, transcript, board)
    // 本板块可改 + 主人私聊里她自己的朋友（friend:* 本来就对主人可见；改写只改正文，不动 scope，不会漂到别的板块）
    const editable = related.filter((m) => String(m.scope || '') === String(board)
      || (String(board) === 'owner' && String(m.scope || '').startsWith('friend:')))
    const known = new Map(editable.map((m) => [m.id, m]))
    const groupRules = isGroup ? `

群聊专用口径：
- fact 必须是「这条三个月后还成立吗？」为「是」的稳定事实：谁常玩什么、谁是谁的谁、群里的规矩或梗、谁长期在做什么。
- event 只写这次发生了什么：谁今天说了什么、谁赢了什么、临时约了什么。
- 主语用群里显示的昵称，不要用 QQ 号；一条只写一件事，不超过 40 字。
- 群聊流水里出现的主人私事、别人的私聊内容、联系方式（QQ/微信/电话/邮箱）一律不许写成 fact。
- 拿不准是 fact 还是 event 时，写 event，不许猜。` : ''
    const out = await askModel(dsh, {
      cfg,
      system: `你帮一个叫「大肥鱼」的聊天角色整理长期记忆。${source}，每行前面的方括号是时间，说话人后面括号里是 QQ 号。QQ 号是 ${cfg.ownerQQ} 的人是她的${cfg.ownerName || '主人'}。

请抽两类条目：
- kind="fact"：关于别人的稳定事实（称呼/名字、喜好/讨厌、身份、住处、工作学校、约定、规矩、禁忌、关系定位）；
- kind="event"：发生过的事（当时聊了什么、她做了什么、学到什么教训、情绪转折、没聊完的话题）。
判断：能长期成立的是 fact，只在那一刻成立的是 event。${groupRules}

要记：${isGroup ? '群里稳定成立、以后还用得上的事（谁常玩什么、谁是谁的谁、群规/群梗、谁长期在做什么）' : '主人明确说的规矩/偏好/禁忌、约定、她的失误与教训、家里/工作/身体状态、关系变化、没聊完的话题'}。
不要记：纯语气词、表情、重复确认（嗯/好的/在吗）、大肥鱼自己的人设和喜好。

每条必须带 quote：从原文里逐字复制一句（不要改写、不要加时间戳）；程序会逐字校验，找不到就丢弃。
宁可多记一条低 importance 的，也别漏掉关系转折；拿不准 importance 就给 0.4。
除非整段几乎全是表情/单字回应，否则**不要输出空数组**；实在拿不准，就记一条 kind="event"、importance=0.4 的经过。

输出 JSON 数组，例如：
${isGroup ? '[{"op":"add","kind":"fact","text":"阿青常玩狼人杀","about":"阿青","quote":"我常玩狼人杀","importance":0.7},{"op":"add","kind":"event","text":"阿青今晚赢了狼人杀","about":"阿青","quote":"今晚又赢了","importance":0.4}]' : '[{"op":"add","kind":"fact","text":"主人不吃香菜","about":"主人","about_qq":"12345","quote":"我不吃香菜","importance":0.7},{"op":"add","kind":"event","text":"他答应以后回评论前先想语气","about":"主人","quote":"下次先想语气","importance":0.5}]'}
（about_qq 写这件事是关于谁的 QQ 号，不知道就不写）` +
        (editable.length ? '\n每条新条目先和「已经记得的事」比一比：全新的写 "op":"add"；是对某条旧记忆的补充或更准确的说法，写 "op":"update"、"id" 填那条的编号、"text" 写合并后的完整说法；和某条旧记忆矛盾、说明那条已经过时（以前喜欢现在不喜欢了、换了工作、搬家了、分手了），写 "op":"outdated"、"id" 填旧的编号、"text" 写现在的新事实。拿不准是不是矛盾就当 add；已经记得、没有新信息的不要输出。' : '') +
        '\n只输出 JSON 数组；没有值得记的就输出 []。',
      text: (editable.length ? `已经记得的事：\n${editable.map((m) => `#${m.id} [${whenText(m.at)}] ${m.aboutName ? '[' + m.aboutName + '] ' : ''}${m.text}`).join('\n')}\n\n` : '') + transcript,
      maxTokens: 12000,
      temperature: 0.2,
    })
    const arr = parseItemsJson(out)
    if (!arr.length) log.warn(`记忆抽取没返回条目（${chatId}，${transcript.length} 字）：${String(out).replace(/\s+/g, ' ').slice(0, 200) || '(空字符串)'}`)
    const hay = haystack || transcript
    const strictQuote = Boolean(cfg.memory.v2?.enabled)
    let added = 0
    let events = 0
    let dropped = 0
    let skippedAbout = 0
    let skippedTarget = 0
    for (const x of arr.slice(0, 12)) {
      if (!x || !x.text) continue
      const kind = String(x.kind || x.type || '').toLowerCase() === 'event' ? 'event' : 'fact'
      // 关于她自己的事实：不再整条丢掉，落到 self 板、只给主人私聊看；事件仍不进（她的话由 noteSaid 管）
      const selfAbout = /^(我|大肥鱼)/.test(String(x.about || '')) || String(x.about || '') === '大肥鱼'
      if (selfAbout && kind === 'event') { skippedAbout++; continue }
      // 引文校验：v2 下必须给引文，且必须能在净对话里逐字找到（防幻觉）
      const quote = String(x.quote || '').trim()
      if (strictQuote && !quote) { dropped++; continue }
      if (quote && !quoteInTranscript(quote, hay)) { dropped++; continue }
      if (selfAbout) {
        const r = add({ text: x.text, aboutName: '我', about: '', importance: x.importance ?? 0.6, source: 'auto', chatId, kind: 'fact', scope: 'self', board: 'owner', tags: ['她自己'] })
        if (r.ok && (r.id || r.updated)) added++
        continue
      }
      // 群 fact 在入库前再做硬约束：一条只留一句话；太长或带联系方式就丢弃，宁可退回 event 也别串隐私。
      if (isGroup && kind === 'fact') {
        const factText = String(x.text).trim()
        const numericSubject = /^\d{5,}$/.test(String(x.about || '').trim())
        if (numericSubject || factText.length > 40 || /(?:\d{5,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:QQ|微信|VX|V信)\s*[:：]?\s*[A-Z0-9_-]{4,})/i.test(factText)) {
          dropped++
          continue
        }
        x.text = factText
      }
      // 关于谁：模型给了 QQ 号就用（群聊、空间里也能记到人头上），只给名字时见 pickAboutForFact
      const about = pickAboutForFact({ qq: x.about_qq, about: x.about, chatId, botQQ: cfg.botQQ, ownerQQ: cfg.ownerQQ, ownerName: cfg.ownerName })
      const op = String(x.op || 'add')
      const target = known.get(String(x.id || '').replace(/^#/, ''))
      // 想改一条不在本板块可改范围的旧记录：既不能改，也别把那句当成新事实塞进本板块（Codex P1-4）
      if ((op === 'update' || op === 'outdated') && !target) { skippedTarget++; continue }
      // 目标必须真的是 x.about 说的那个人：朋友板块按 QQ/名字比对（Codex P1-2）
      if ((op === 'update' || op === 'outdated') && target
        && !subjectMatchesScope({ scope: target.scope, about, aboutName: x.about, ownerQQ: cfg.ownerQQ, ownerName: cfg.ownerName, profiles: load().profiles })) { skippedTarget++; continue }
      // 补充旧的（你在面板里亲手写的不改写）
      if (op === 'update' && target && target.source !== 'panel') {
        if (revise(target.id, x.text, x.importance)) added++
        continue
      }
      // 旧的过时了：先标过时（这样新的不会被当成重复合并进去），再记新的
      if (op === 'outdated' && target) {
        invalidate(target.id)
        const r = add({ text: x.text, aboutName: x.about || target.aboutName || '', about: about || target.about || '', importance: x.importance ?? target.importance ?? 0.5, source: 'auto', chatId, kind, scope: target.scope })
        if (r.id || r.updated) {
          invalidate(target.id, r.id || r.updated)
          log.info(`记忆更新：「${target.text}」过时了 → 「${String(x.text).slice(0, 60)}」`)
          added++
        }
        continue
      }
      // 事件是一次性的，进候选池永远等不到「再被提一次」，所以直接入库；只有事实走宽进严出
      if (kind === 'event') {
        const r = add({ text: x.text, aboutName: x.about || '', about, importance: x.importance ?? 0.5, source: 'auto', chatId, kind: 'event' })
        if (r.ok && r.id) { added++; events++ }
      } else if (isGroup) {
        // 群事实是群卡的主要原料；已经过引文/长度/联系方式校验，直接落本群板，不再等候选池三次确认。
        const r = add({ text: x.text, aboutName: x.about || '', about, importance: x.importance ?? 0.55, source: 'auto', chatId, kind: 'fact', scope: board })
        if (r.ok && (r.id || r.updated)) added++
      } else if (cfg.memory.v2?.enabled && op !== 'update' && op !== 'outdated') {
        const r = addCandidate({ text: x.text, aboutName: x.about || '', about, importance: x.importance ?? 0.45, confidence: x.confidence ?? 0.45, source: 'auto', chatId, key: x.key || '', kind: 'fact' })
        if (r.ok) added++
      } else {
        const r = add({ text: x.text, aboutName: x.about || '', about, importance: x.importance ?? 0.5, source: 'auto', chatId, kind: 'fact' })
        if (r.ok && r.id) added++
      }
    }
    if (skippedAbout || dropped || skippedTarget) log.info(`记忆抽取：跳过 ${skippedAbout} 条（关于她自己）、引文对不上 ${dropped} 条、越板块改写 ${skippedTarget} 条、入库 ${added} 条（事件 ${events}）`)
    return { added, events, dropped }
  }

  /** 面板「记忆总览」：她现在手上有什么（卡、最近经历、候选、最近新增）。 */
  function overview({ now = Date.now() } = {}) {
    const cfg = getConfig()
    const s = load()
    const items = (Array.isArray(s.items) ? s.items : []).filter((m) => m && !m.invalidAt)
    const isEvent = (m) => isEventMemory(m)
    const facts = items.filter((m) => !isEvent(m) && m.source !== 'diary')
    const card = buildFactCard(facts, {
      maxChars: cfg.memory?.v2?.cardMaxChars || 1500,
      topics: Array.isArray(s.topics) ? s.topics : [],
      now,
      personNames: personNamesOf(s),
    })
    const events = formatEventSlice(items, { hours: 24, maxItems: 6, maxChars: 600, now })
    const candidates = (s.memoryCandidates || []).filter((c) => c.status === 'candidate')
    return {
      card: { text: card.text, chars: card.chars, facts: card.included.length, groups: card.groups },
      events,
      stats: {
        total: items.length,
        facts: facts.length,
        events: items.filter(isEvent).length,
        candidates: candidates.length,
      },
      recent: items.slice().sort((a, b) => b.at - a.at).slice(0, 8)
        .map((m) => ({ id: m.id, text: m.text, kind: isEvent(m) ? 'event' : 'fact', source: m.source, scope: m.scope || '', at: m.at, importance: m.importance })),
      candidates: candidates.slice(0, 8).map((c) => ({ id: c.id, text: c.text, mentions: c.mentions || 1, importance: c.importance })),
      lastConsolidate: s.lastConsolidate || null,
    }
  }

  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  let busy = false

  /**
   * 整理临时记忆。
   * @param {{includeToday?:boolean}} o includeToday：连今天的也提炼（手动整理时），但今天的流水不删（写日记还要用）
   */
  async function consolidate(o = {}) {
    if (busy) return { ok: false, message: '正在整理中' }
    busy = true
    const today = dayKey()
    const startedAt = Date.now()
    let added = 0
    let events = 0
    let insights = 0
    let days = 0
    let profiles = 0
    try {
      for (const day of hub.chatLogDays()) {
        if (day > today || (day === today && !o.includeToday)) continue
        // 同一天整理过一部分的（比如下午那次），只处理之后新增的聊天
        const done = (load().processed || {})[day] || 0
        const all = hub.chatLogOf(day)
        const byChat = new Map()
        for (const l of all.slice(done)) {
          if (String(l.chatId).startsWith('system:')) continue
          if (!byChat.has(l.chatId)) byChat.set(l.chatId, [])
          byChat.get(l.chatId).push(l)
        }
        let dayEvents = 0
        let dayLines = 0
        for (const [chatId, lines] of byChat) {
          dayLines += lines.length
          const r = await extractLines(chatId, lines)
          added += r.added || 0
          events += r.events || 0
          dayEvents += r.events || 0
          insights += r.insights ? 1 : 0
        }
        if (dayLines >= 6 && !dayEvents) log.warn(`整理 ${day} 没抽出任何事件（${dayLines} 行聊天），抽取口径可能还偏严`)
        const s = load()
        s.processed = s.processed || {}
        if (day < today) {
          hub.deleteChatLog(day) // 整理完清空（今天的留着，写日记还要用）
          delete s.processed[day]
        } else {
          s.processed[day] = all.length
        }
        save(s)
        days++
      }
      if (days) await learnSelfStyle()
      // 这次记忆有变化的人，重写人物小档案（每次最多 8 个人）；按「板块 + 人」算，群里的档案只用群里的记忆
      const living = load()
      // 旧纯 QQ 档案键迁到 owner|QQ：面板、profilesByQQ、contextFor 从此只有一套口径（Codex P2）
      let migrated = false
      for (const k of Object.keys(living.profiles || {})) {
        if (String(k).includes('|')) continue
        const qq = String(k)
        const p = living.profiles[qq] || {}
        const nk = profileKey('owner', qq)
        const cur = living.profiles[nk]
        if (cur) {
          // 新键已经在：只补缺失字段，别把旧键里唯一的名字/正文弄丢
          if (!cur.text && p.text) cur.text = String(p.text)
          if (!cur.name && p.name) cur.name = String(p.name)
          if (!Number(cur.at) && Number(p.at)) cur.at = Number(p.at)
        } else {
          living.profiles[nk] = { text: String(p.text || ''), name: String(p.name || ''), at: Number(p.at || 0), scope: 'owner' }
        }
        delete living.profiles[qq]
        migrated = true
      }
      if (migrated) save(living)
      const SELL = '\u0000'
      const profPair = (m) => (m.scope === 'owner' || String(m.scope || '').startsWith('group:') || String(m.scope || '').startsWith('friend:')) ? `${m.scope}${SELL}${m.about}` : ''
      const touched = [...new Set(living.items.filter((m) => m.about && profPair(m) && (m.at >= startedAt || (m.invalidAt || 0) >= startedAt)).map(profPair))]
      // 还没有小档案、但已经记了不少事的人也补上（刚升级时一次补几个，按记得的多少排）
      const count = new Map()
      for (const m of living.items) {
        const k = m.about && !m.invalidAt ? profPair(m) : ''
        if (k) count.set(k, (count.get(k) || 0) + 1)
      }
      const missing = [...count].filter(([k, n]) => {
        const [scope, qq] = k.split(SELL)
        return n >= 3 && !profileFrom(living.profiles, qq, scope) && !touched.includes(k)
      }).sort((x, y) => y[1] - x[1]).map(([k]) => k)
      for (const k of [...touched, ...missing].slice(0, 8)) {
        const [scope, qq] = k.split(SELL)
        try { if (await buildProfile(qq, scope)) profiles++ } catch (error) { log.warn('写人物小档案失败：', error.message) }
      }
      const candidateResult = getConfig().memory.v2?.enabled ? judgeCandidates({ now: Date.now() }) : null
      const s = load()
      // 遗忘：事件淡出/过时回收。先写进「冷档案」再删，误删可从 memories-forgotten.jsonl 找回。
      const forgotten = s.items.filter((m) => shouldForget(m, Date.now(), decayOpts()))
      let forgot = 0
      if (forgotten.length) {
        try {
          appendFileSync(dataDir('memories-forgotten.jsonl'), forgotten.map((m) => JSON.stringify({ at: Date.now(), reason: m.invalidAt ? 'superseded' : 'event-tide', item: m })).join('\n') + '\n', 'utf8')
          const drop = new Set(forgotten.map((m) => m.id))
          s.items = s.items.filter((m) => !drop.has(m.id))
          forgot = forgotten.length
        } catch (error) {
          // 冷档案写不进去就不删，宁可库大一点也不能丢
          log.warn('遗忘冷档案写入失败，本次不删除：', error.message)
        }
      }
      s.lastConsolidate = { day: today, at: Date.now(), added, events, insights, days, forgot, profiles, candidates: candidateResult }
      save(s)
      log.info(`整理临时记忆：处理了 ${days} 天，新增或更新 ${added} 条长期记忆（其中事件 ${events} 条），更新了 ${insights} 份相处经验、${profiles} 份人物小档案${forgot ? `，忘掉 ${forgot} 条不重要的旧记忆` : ''}`)
      return { ok: true, added, events, insights, days, forgot, profiles, candidates: candidateResult, message: `整理好了：新增或更新 ${added} 条记忆（事件 ${events} 条），更新 ${insights} 份相处经验、${profiles} 份人物小档案${forgot ? `，忘掉 ${forgot} 条旧的` : ''}` }
    } catch (error) {
      log.warn('整理临时记忆失败：', error.message)
      return { ok: false, message: error.message }
    } finally {
      busy = false
    }
  }

  /** 从各人的说话方式里，沉淀出几条她自己不知不觉学会的说法（很少、很淡）。 */
  async function learnSelfStyle() {
    const s = load()
    const pool = Object.entries(s.styles || {}).filter(([k]) => k !== 'self').flatMap(([, v]) => v)
    if (pool.length < 3) return
    try {
      const out = await askModel(dsh, {
        cfg: getConfig(),
        system: '你是「大肥鱼」。下面是你和不同的人聊天时注意到的说话习惯，以及你自己已经养成的说法。挑出你和大家聊久了、自然会被带上的说话方式（口头禅、语气词、发消息的节奏），保持你原本的性格，不超过 6 条，每条不超过 20 字。只输出 JSON 数组。',
        text: `已经养成的：\n${styleOf('self').map((x) => '- ' + x).join('\n') || '（还没有）'}\n\n大家的说话习惯：\n${pool.map((x) => '- ' + x).join('\n')}`,
        maxTokens: 800,
        temperature: 0.3,
      })
      const m = out.match(/\[[\s\S]*\]/)
      const arr = m ? JSON.parse(m[0]).map((t) => String(typeof t === 'string' ? t : t?.text || '')) : []
      if (arr.length) setStyle('self', arr)
    } catch (error) {
      log.warn('沉淀说话方式失败：', error.message)
    }
  }

  /** 每分钟调一次：一天几个整理时间点（默认 04:00 / 16:00），到点且这个点今天还没跑过就整理。 */
  async function tick() {
    const cfg = getConfig().memory
    if (!cfg.enabled || !cfg.dailyConsolidate) {
      const cutoff = dayKey(new Date(Date.now() - 14 * 86400_000))
      for (const day of hub.chatLogDays?.() || []) if (day < cutoff) hub.deleteChatLog(day)
      return
    }
    const s = load()
    const today = dayKey()
    const now = new Date()
    const mins = now.getHours() * 60 + now.getMinutes()
    const runs = s.runs || {}
    const due = (cfg.consolidateTimes || []).filter((t) => {
      const [hh, mm] = String(t).split(':').map(Number)
      return mins >= hh * 60 + mm && runs[t] !== today
    })
    // T-045 每日待确认提醒：到点在 QQ 私聊里说一句，一天只发一次；reviewRemindAt 置空或 off 就关。
    const remindAt = String(cfg.reviewRemindAt || '').trim()
    if (remindAt && remindAt !== 'off') {
      const [rh, rm] = remindAt.split(':').map(Number)
      const q = reviewQueue()
      if (Number.isFinite(rh) && Number.isFinite(rm) && mins >= rh * 60 + rm && s.reviewRemind?.day !== today && q.today.length > 0) {
        const tail = q.backlogCount ? `，另外还有 ${q.backlogCount} 条早先积压的` : ''
        try {
          const sent = await hub?.sendText?.(`private:${getConfig().ownerQQ}`, `主人，今天有 ${q.today.length} 条不确定的记忆${tail}，点开面板过一下。`)
          if (sent !== false) {
            const s3 = load()
            s3.reviewRemind = { day: today, at: Date.now() }
            save(s3)
          }
        } catch (error) {
          log?.warn?.('待确认提醒发送失败：', error.message)
        }
      }
    }
    if (!due.length) return
    // 连今天到目前为止的聊天一起提炼；记着整理到第几行，下一次只处理新的
    const r = await consolidate({ includeToday: true })
    if (r.ok) {
      const s2 = load()
      s2.runs = { ...(s2.runs || {}) }
      for (const t of due) s2.runs[t] = today
      save(s2)
    }
  }

  // 按板块建索引并缓存：BM25 的文档数/DF/平均长度也必须只算本板块，
  // 否则私聊和别的群的记录会悄悄改变当前群的 IDF（Codex P1-2）
  const boardIdx = new Map()
  function indexForBoard(board) {
    const s = load()
    const stamp = s.items.length + ':' + (s.items.at(-1)?.id || '') + ':' + (s.rev || 0)
    const hit = boardIdx.get(board)
    if (hit && hit.stamp === stamp) return hit.idx
    const idx = buildIndex(s.items.filter((m) => m && !m.invalidAt && scopeVisible(m, board)))
    boardIdx.set(board, { stamp, idx })
    return idx
  }

  /** 群聊话题和记忆库有多相关（0~1），给插话判断用。只看这个群的板块（Codex P1）。 */
  function topicScore(text, board = '') {
    if (!board) return 0 // 拿不到板块就不给分（fail-closed）
    const hits = search(indexForBoard(board), text, { limit: 1, minScore: 0.01, eventHalfLifeDays: decayOpts().eventHalfLifeDays })
    return hits.length ? Math.min(1, hits[0].score / 3) : 0
  }

  return {
    add, addEvent, recentEvents, noteSaid, update, invalidate, remove, restore, recall, contextFor, volatileFor, consolidate, tick, topicScore, importCandidates, importCommit, addCandidate, judgeCandidates, candidates: candidateList, candidateStats, reviewQueue, decideReview, decideReviewMany, overview, graph: (board = '') => {
      const g = graphIndex()
      const byId = {}
      for (const [id, m] of Object.entries(g.byId || {})) {
        if (board ? scopeVisible(m, board) : visibleForAdmin(m)) byId[id] = m
      }
      const ids = new Set(Object.keys(byId))
      return { ...g, byId, edges: (g.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to)) }
    }, graphVersion: GRAPH_VERSION, boardOfChat: (chat) => scopeOfChat(chat, getConfig().ownerQQ),
    profiles: () => {
      const s = load()
      // 键有两种：新口径「板块|QQ」和旧的「QQ」（按主人私聊算）。同一个人同一板块只留一份，新键优先。
      const byKey = new Map()
      for (const [k, p] of Object.entries(s.profiles || {})) {
        const i = String(k).indexOf('|')
        const scope = i > 0 ? String(k).slice(0, i) : 'owner'
        const qq = i > 0 ? String(k).slice(i + 1) : String(k)
        const key = `${scope}|${qq}`
        const picked = betterProfile(byKey.get(key), p, i > 0)
        byKey.set(key, { key, qq, scope, ...picked.p })
      }
      return [...byKey.values()].sort((a, b) => b.at - a.at)
    },
    // 面板「具体板块」下拉用：从全量记忆统计出现过的群/朋友，不再只取最近 300 条（Delta3）
    scopes: () => {
      const s = load()
      const groups = new Set()
      const friends = new Set()
      for (const m of s.items || []) {
        for (const sc of [String(m?.scope || ''), String(m?.board || '')]) {
          if (sc.startsWith('group:')) groups.add(sc)
          else if (sc.startsWith('friend:')) friends.add(sc)
        }
      }
      for (const k of Object.keys(s.profiles || {})) {
        const i = String(k).indexOf('|')
        const sc = i > 0 ? String(k).slice(0, i) : ''
        if (sc.startsWith('friend:')) friends.add(sc)
        else if (sc.startsWith('group:')) groups.add(sc)
      }
      return { groups: [...groups].sort(), friends: [...friends].sort() }
    },
    setProfile, buildProfile,
    recalls: () => recallLog.slice(),
    styles: () => load().styles || {},
    setStyle: (key, list) => setStyle(key, (list || []).map(String)),
    lastConsolidate: () => load().lastConsolidate || null,
    insights: () => {
      const s = load()
      return Object.entries(s.insights || {}).map(([key, list]) => ({ key, name: (s.insightNames || {})[key] || '', list }))
    },
    setInsights: (key, list) => setInsights(key, list.map((x) => (typeof x === 'string' ? { id: randomUUID().slice(0, 8), text: x, at: Date.now() } : x))),
    list: (q) => {
      const items = load().items
      // 面板里过时的也列出来（排在后面），能看到被哪条取代、能恢复
      const textOf = new Map(items.map((m) => [m.id, m.text]))
      const withBy = (m) => (m.supersededBy ? { ...m, supersededText: textOf.get(m.supersededBy) || '' } : m)
      if (!q) return items.slice().sort((a, b) => (Boolean(a.invalidAt) - Boolean(b.invalidAt)) || b.at - a.at).map(withBy)
      return search(index(), q, { limit: 100, minScore: 0.01, includeInvalid: true, eventHalfLifeDays: decayOpts().eventHalfLifeDays }).map((h) => withBy({ ...h.it, score: Number(h.score.toFixed(2)) }))
    },
    stats: () => {
      const items = load().items
      const live = items.filter((m) => !m.invalidAt)
      return { count: live.length, auto: live.filter((m) => m.source === 'auto').length, events: live.filter((m) => isEventMemory(m)).length, outdated: items.length - live.length }
    },
  }
}

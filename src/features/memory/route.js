// 问法路由（T-039）：把「她怎么问」变成结构条件，再给检索加结构分。
// 纯函数、无 IO；不依赖向量/模型，断网可用。
// 借鉴 Ido1um/DeepSeek-memory-Ido1um（MIT）的 routeQuery/routeScore 思路，
// 但本项目没有 slot/topicId 字段，所以槽位/主题从正文、tags、scope 现推，零迁移。

const DAY_MS = 86400_000

/** 问法 → 槽位。 */
const SLOT_HINTS = [
  [/生日|出生|寿辰|几号生|哪天生/, ['birthday']],
  [/称呼|怎么叫|叫啥|小名|昵称|名字/, ['nickname', 'profile']],
  [/学校|大学|学院|哪个系|专业/, ['school', 'job']],
  [/工作|职业|干什么的|上班|公司/, ['job']],
  [/住哪|住在|老家|哪里人|籍贯|哪个城市/, ['residence']],
  [/喜欢|爱吃|讨厌|偏好|口味|最爱/, ['pref']],
  [/计划|打算|准备|目标|要做什么/, ['plan']],
  [/约定|说好|答应|承诺/, ['promise']],
  [/宠物|养了|猫|狗/, ['pet']],
  [/身体|生病|吃药|医院|健康|不舒服/, ['health']],
  [/头像|背景|签名|资料|改名|换名/, ['profile']],
  [/游戏|下棋|五子棋|mc|我的世界/i, ['game']],
  [/吃|饭|外卖|奶茶|白米饭|火锅/, ['food']],
  [/作息|睡觉|起床|熬夜|几点睡/, ['routine']]
]

/** 问法 → 主题。命中只加分，不改变「能不能查到」。 */
const TOPIC_HINTS = [
  [/抖音/, ['douyin']],
  [/b站|bilibili|哔哩/i, ['bili']],
  [/群聊|群里|群友|这个群/, ['group']],
  [/朋友|好友|哥们|姐妹/, ['friend']],
  [/工作|学习|考研|考试|项目|代码|开发|写文章/, ['work']],
  [/心情|难过|开心|生气|累|委屈/, ['mood']],
  [/吃|饭|奶茶|白米饭|火锅/, ['food']],
  [/游戏|下棋|五子棋|mc|我的世界/i, ['game']],
  [/生日|称呼|名字|身份|资料|头像|签名|改名/, ['identity']],
  [/她自己|助手|你自己|大肥鱼自己/, ['self']]
]

/** 单条正文 → 槽位（与问法同一套词，但只看正文；槽位要求「关键词+值形态」，避免闲聊里出现一个词就命中）。 */
const SLOT_TEXT = [
  [/生日[^。；，]{0,12}\d{1,2}\s*[月日号]|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|出生[^。；，]{0,12}\d{1,2}\s*[月日号]|\d{4}\s*年\s*\d{1,2}\s*月/, 'birthday'],
  [/昵称是|昵称叫|名字是|名字叫|小名是|称呼是|我叫|喊我/, 'nickname'],
  [/学校|大学|学院|专业|哪个系/, 'school'],
  [/工作|职业|上班|公司|干什么的/, 'job'],
  [/住|老家|籍贯|城市|省份/, 'residence'],
  [/喜欢|爱吃|讨厌|偏好|口味|最爱/, 'pref'],
  [/计划|打算|准备|目标/, 'plan'],
  [/约定|说好|答应|承诺/, 'promise'],
  [/宠物|猫|狗|养了/, 'pet'],
  [/身体|生病|吃药|医院|健康|不舒服/, 'health'],
  [/头像|背景|签名|资料|改名|换名/, 'profile'],
  [/游戏|下棋|五子棋|mc|我的世界/i, 'game'],
  [/吃|饭|外卖|奶茶|白米饭|火锅/, 'food'],
  [/作息|睡觉|起床|熬夜|几点睡/, 'routine']
]

const DAY_WORDS = [
  [/前天/, -2],
  [/昨天|昨晚/, -1],
  [/今天|今早|今晚|现在/, 0],
  [/明天|明早/, 1],
  [/后天/, 2]
]

const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }

/** 中文二元组 + 英文/数字整词（与 memory.js 的 tokenize 同源，避免循环依赖）。 */
export function queryTokens(query = '') {
  const out = new Set()
  const s = String(query || '').toLowerCase()
  for (const m of s.matchAll(/[a-z0-9_]{2,}|[一-鿿]+/g)) {
    const w = m[0]
    if (/^[a-z0-9_]+$/.test(w)) { out.add(w); continue }
    if (w.length === 1) { out.add(w); continue }
    for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2))
  }
  return [...out]
}

export function dayKeyOf(ms) {
  const d = new Date(Number(ms) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function addDay(set, now, offset) {
  set.add(dayKeyOf(Number(now) + offset * DAY_MS))
}

function weekdayKey(key) {
  const d = new Date(key + 'T00:00:00')
  return d.getDay() || 7
}

export function inferSlot(text = '') {
  const s = String(text || '')
  for (const [re, slot] of SLOT_TEXT) if (re.test(s)) return slot
  return ''
}

export function inferTopic(item = {}) {
  const tags = Array.isArray(item.tags) ? item.tags.map(String) : []
  const text = String(item.text || '')
  if (tags.includes('抖音') || item.scope === 'douyin') return 'douyin'
  if (tags.includes('B站') || item.scope === 'public:bili') return 'bili'
  if (item.scope === 'self' || tags.includes('她自己')) return 'self'
  if (String(item.scope || '').startsWith('group')) return 'group'
  if (String(item.scope || '').startsWith('friend')) return 'friend'
  for (const [re, list] of TOPIC_HINTS) if (re.test(text)) return list[0]
  return ''
}

/**
 * 问句 → 结构条件。
 * @param {string} query
 * @param {{now?:number, people?:Array<{qq?:string,name?:string}>, ownerQQ?:string, ownerName?:string}} [opts]
 * @returns {{query:string,tokens:string[],slots:string[],topics:string[],who:string,qq:string,ownerQQ:string,dayKeys:string[],date:'',firstPerson:boolean}}
 */
export function routeQuery(query = '', { now = Date.now(), people = [], ownerQQ = '', ownerName = '主人', speaker = '' } = {}) {
  const q = String(query || '').trim()
  const slots = new Set()
  const topics = new Set()
  for (const [re, list] of SLOT_HINTS) if (re.test(q)) list.forEach((x) => slots.add(x))
  for (const [re, list] of TOPIC_HINTS) if (re.test(q)) list.forEach((x) => topics.add(x))

  // 主体：
  // - 明确人名/QQ（最长优先）；名字是主人 → owner
  // - 「你/你自己/助手」在这个项目里指她（主人对她说「你」）→ bot
  // - 「我」在主人私聊 → owner；群/朋友私聊 → 当前说话人（speaker）
  let who = ''
  let qq = ''
  const candidates = (Array.isArray(people) ? people : [])
    .map((p) => ({ qq: String(p?.qq || ''), name: String(p?.name || '').trim() }))
    .filter((p) => p.name.length >= 2 && q.includes(p.name))
    .sort((a, b) => b.name.length - a.name.length)
  if (candidates.length) {
    const hit = candidates[0]
    if ((ownerQQ && hit.qq === String(ownerQQ)) || hit.name === String(ownerName || '主人')) {
      who = 'owner'
      qq = String(ownerQQ || hit.qq)
    } else {
      who = hit.name
      qq = hit.qq
    }
  }
  if (!who && /你主人|你的主人/.test(q)) who = 'owner'
  if (!who && /你自己|助手|大肥鱼自己/.test(q)) who = 'bot'
  if (!who && /你(?!们)/.test(q)) who = 'bot'
  if (!who && /主人|咱|俺|本人/.test(q)) who = 'owner'
  if (!who && /我(?!们)/.test(q)) {
    const sp = String(speaker || '')
    if (sp && ownerQQ && sp !== String(ownerQQ)) { who = sp; qq = sp }
    else who = 'owner'
  }

  // 日期：今天/昨天/…、显式日期、周几
  const dayKeys = new Set()
  let explicit = ''
  const ymd = q.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/)
  const md = q.match(/(\d{1,2})月(\d{1,2})[日号]/)
  if (ymd) explicit = `${ymd[1]}-${String(ymd[2]).padStart(2, '0')}-${String(ymd[3]).padStart(2, '0')}`
  else if (md) explicit = `${new Date(now).getFullYear()}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`
  if (explicit) dayKeys.add(explicit)
  else {
    for (const [re, off] of DAY_WORDS) if (re.test(q)) { addDay(dayKeys, now, off); break }
  }
  const wd = q.match(/周([一二三四五六日天])/)
  if (wd && !explicit) {
    // 本周对应周几；「上周五/下周五」按 ±7 天偏移
    const want = WEEKDAY[wd[1]]
    const base = new Date(now)
    const cur = base.getDay() || 7
    let off = want - cur
    if (/上周/.test(q)) off -= 7
    else if (/下周/.test(q)) off += 7
    addDay(dayKeys, now, off)
  }

  return {
    query: q,
    tokens: queryTokens(q),
    slots: [...slots],
    topics: [...topics],
    who,
    qq,
    ownerQQ: String(ownerQQ || ''),
    ownerName: String(ownerName || '主人'),
    dayKeys: [...dayKeys],
    firstPerson: /^我|我记得|我当时|我说过/.test(q)
  }
}

/**
 * 单条记忆的结构命中。
 * @returns {{slotHit:boolean,topicHit:boolean,subjectHit:boolean,dateHit:boolean,expired:boolean,slot:string,topic:string}}
 */
export function routeScore(item = {}, route = {}) {
  const text = String(item.text || '')
  const slot = inferSlot(text)
  const topic = inferTopic(item)
  const slots = Array.isArray(route.slots) ? route.slots : []
  const topics = Array.isArray(route.topics) ? route.topics : []
  const slotHit = slots.length > 0 && slots.includes(slot)
  const topicHit = topics.length > 0 && topics.includes(topic)
  let subjectHit = false
  const who = String(route.who || '')
  const about = String(item.about || '')
  const aboutName = String(item.aboutName || '')
  if (who === 'owner') subjectHit = Boolean(route.ownerQQ && about === String(route.ownerQQ)) || aboutName === String(route.ownerName || '主人')
  else if (who === 'bot') subjectHit = item.scope === 'self' || aboutName === '我'
  else if (who && route.qq) subjectHit = about === String(route.qq) || aboutName === who
  else if (who) subjectHit = aboutName === who
  const dateHit = Array.isArray(route.dayKeys) && route.dayKeys.length > 0 && route.dayKeys.includes(dayKeyOf(item.at))
  return { slotHit, topicHit, subjectHit, dateHit, expired: Boolean(item.invalidAt), slot, topic }
}

// 结构分权重：槽位 > 主体 > 主题 > 日期；远高于 BM25 词法分（常态 0–5）
export const ROUTE_WEIGHTS = Object.freeze({ slot: 120, subject: 100, topic: 60, date: 40, expired: -30 })

export function routeBonus(score) {
  const s = score || {}
  return (s.subjectHit ? ROUTE_WEIGHTS.subject : 0)
    + (s.slotHit ? ROUTE_WEIGHTS.slot : 0)
    + (s.topicHit ? ROUTE_WEIGHTS.topic : 0)
    + (s.dateHit ? ROUTE_WEIGHTS.date : 0)
    + (s.expired ? ROUTE_WEIGHTS.expired : 0)
}

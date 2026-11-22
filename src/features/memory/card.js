// 记忆期 1 的事实卡投影。规则借鉴 Ido1um 的 card-tree：
// 先按主题分组，再按槽位取舍；单值槽只留最完整的一条，多值槽去重封顶，
// 过期事实不删除，只在卡底收成一行「旧事」。最终正文硬限制在 maxChars 内。

export const CARD_HEADER = '【长期记忆（事实卡）】'

const SLOT_LABEL = {
  identity: '身份', nickname: '称呼', birthday: '生日', residence: '住处', job: '工作', school: '学校',
  relation: '关系', pref: '喜好', dislike: '不喜欢', note: '记得', event: '经历', plan: '计划',
  gear: '设备', game: '游戏', edition: '版本', skill: '技能', material: '材料',
}
const SINGLE_VALUE_SLOTS = new Set(['identity', 'nickname', 'birthday', 'residence', 'job', 'school', 'relation'])
const ENTITY_SLOTS = new Set(['gear', 'game', 'edition', 'skill', 'material'])
const SLOT_CAPS = { pref: 3, dislike: 3, note: 3, event: 2, plan: 2, gear: 2, game: 2, edition: 2, skill: 2, material: 2 }
// 槽位封顶后用来「补」进卡的剩余事实，重要度低于这个值的不补：
// 真实数据里 293 条有 237 条是 0.2–0.4 的对话流水，补进来只会淹没真正的长期事实。
const REST_MIN_IMPORTANCE = 0.5
const TAG_ALIASES = new Map([
  ['身份', 'identity'], ['称呼', 'nickname'], ['小名', 'nickname'], ['生日', 'birthday'], ['住处', 'residence'],
  ['工作', 'job'], ['职业', 'job'], ['学校', 'school'], ['关系', 'relation'], ['喜好', 'pref'], ['偏好', 'pref'],
  ['讨厌', 'dislike'], ['经历', 'event'], ['计划', 'plan'], ['设备', 'gear'], ['游戏', 'game'], ['版本', 'edition'],
  ['技能', 'skill'], ['材料', 'material'],
])

const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const normOf = (v) => textOf(v).toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】[\]-]+/g, '')

function clip(text, max) {
  const t = textOf(text)
  if (!t || !(max > 0) || t.length <= max) return t
  return `${t.slice(0, Math.max(0, max - 1))}…`
}

function factValue(f) {
  return textOf(f?.value ?? f?.text ?? '')
}

function isExpiredFact(f, now) {
  if (!f) return false
  if (f.expired === true || f.status === 'expired' || f.invalidAt) return true
  const until = Number(f.validUntil) || Date.parse(f.validUntil || '')
  return Number.isFinite(until) && until > 0 && until <= now
}

function isActiveFact(f, now) {
  if (!f || f.invalidAt) return false
  // 事实卡只放事实；「发生过什么」走事件通道（memory/events.js），带日期注入
  if (f.kind === 'event') return false
  if (['invalidated', 'expired', 'merged', 'deleted'].includes(String(f.status || ''))) return false
  return !isExpiredFact(f, now)
}

function topicSpecsOf(topics) {
  return (Array.isArray(topics) ? topics : []).map((t) => {
    if (typeof t === 'string') return { id: t, name: t, keys: [t] }
    const id = textOf(t?.id || t?.topicId || t?.name)
    const name = textOf(t?.name || t?.label || id)
    const keys = [id, name, ...(Array.isArray(t?.keys) ? t.keys : [])].map(textOf).filter(Boolean)
    return { id, name, keys: [...new Set(keys)] }
  }).filter((t) => t.id || t.name)
}

/**
 * 同一个人可能有两种写法：about=uid（记得，但没写名字）和 about=uid + aboutName=昵称。
 * 这里统一成「uid 为键」；如果 aboutName 与 uid 解析出来的名字明确不是同一个人，
 * 说明这条事实讲的是第三方（例如 about 误挂到主人 uid 上的「朋友A」），单独成组。
 */
function personOf(f, personNames) {
  const uid = textOf(f?.about)
  const named = textOf(f?.aboutName)
  const resolved = uid ? textOf(personNames?.[uid]) : ''
  // about 挂着别人名字：按名字单独成组（例如误挂到主人 uid 上的「朋友A」）
  if (named && resolved && named !== resolved) return { id: `about:name:${named}`, name: named }
  // 卡是显示层：同一个人换了号（阿青 2 个 QQ）或只写了名字没写 QQ，都按「显示名」合成一组；
  // uid 仍然留在条目里，检索/权限不受影响（2026-11-12）
  const display = resolved || named
  if (display) return { id: `about:name:${display}`, name: display }
  if (uid) return { id: `about:uid:${uid}`, name: uid }
  return null
}

function topicFor(f, specs, personNames) {
  const explicit = textOf(f?.topicId || f?.topic)
  if (explicit) {
    const hit = specs.find((t) => t.id === explicit || t.name === explicit || t.keys.includes(explicit))
    return hit ? { id: hit.id || hit.name, name: hit.name || hit.id } : { id: explicit, name: explicit }
  }
  const value = factValue(f)
  let best = null
  for (const t of specs) {
    for (const key of t.keys) {
      if (key.length >= 2 && value.includes(key) && (!best || key.length > best.key.length)) best = { topic: t, key }
    }
  }
  if (best) return { id: best.topic.id || best.topic.name, name: best.topic.name || best.topic.id }
  const person = personOf(f, personNames)
  if (person) {
    const known = specs.find((t) => t.keys.includes(person.name) || t.name === person.name)
    return known ? { id: known.id || known.name, name: known.name || known.id } : person
  }
  return { id: 'other', name: '其他' }
}

function slotFor(f) {
  const explicit = textOf(f?.slot)
  if (explicit) return explicit
  for (const tag of Array.isArray(f?.tags) ? f.tags : []) {
    const slot = TAG_ALIASES.get(textOf(tag))
    if (slot) return slot
  }
  const value = factValue(f)
  if (/生日/.test(value)) return 'birthday'
  if (/(住在|住处|家住|搬到)/.test(value)) return 'residence'
  if (/(工作|上班|职业|公司)/.test(value)) return 'job'
  if (/(学校|上学|大学|专业)/.test(value)) return 'school'
  if (/(讨厌|不喜欢)/.test(value)) return 'dislike'
  if (/(喜欢|爱吃|爱喝|偏好|最爱)/.test(value)) return 'pref'
  if (/(叫|名字|称呼)/.test(value)) return 'nickname'
  return 'note'
}

function slotRank(slot) {
  const keys = Object.keys(SLOT_LABEL)
  const i = keys.indexOf(slot)
  return i < 0 ? 99 : i
}

function importanceOf(f) {
  return Math.max(0, Math.min(1, Number(f?.importance ?? f?.I ?? 0.5) || 0.5))
}

function timeOf(f) {
  const n = Number(f?.saidAt || f?.lastAt || f?.at || 0)
  return Number.isFinite(n) ? n : 0
}

function nearDuplicate(a, b) {
  const x = normOf(a)
  const y = normOf(b)
  if (!x || !y) return false
  if (x === y) return true
  return x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x))
}

function betterFact(a, b) {
  const al = factValue(a).length
  const bl = factValue(b).length
  return al - bl || importanceOf(a) - importanceOf(b) || timeOf(a) - timeOf(b)
}

function selectEntries(facts) {
  const sorted = facts.slice().sort((a, b) => betterFact(b, a))
  const out = []
  for (const fact of sorted) {
    const value = factValue(fact)
    if (!value) continue
    if (out.some((e) => nearDuplicate(e.value, value))) continue
    out.push({ value, fact })
  }
  return out
}

function entriesForTopic(facts) {
  const bySlot = new Map()
  for (const f of facts) {
    const slot = slotFor(f)
    if (!bySlot.has(slot)) bySlot.set(slot, [])
    bySlot.get(slot).push(f)
  }
  const result = []
  for (const [slot, list] of bySlot) {
    let entries = selectEntries(list)
    if (SINGLE_VALUE_SLOTS.has(slot)) entries = entries.slice(0, 1)
    else entries = entries.slice(0, SLOT_CAPS[slot] || 3)
    result.push({ slot, entries })
  }
  result.sort((a, b) => slotRank(a.slot) - slotRank(b.slot) || a.slot.localeCompare(b.slot))

  // 设备/游戏/版本等实体槽是事实的“主副本”；别的槽只复述同一个值时丢掉。
  const entities = new Set(result.filter((r) => ENTITY_SLOTS.has(r.slot)).flatMap((r) => r.entries.map((e) => normOf(e.value))).filter(Boolean))
  const seen = new Set()
  return result.map(({ slot, entries }) => ({
    slot,
    entries: entries.filter((e) => {
      const n = normOf(e.value)
      if (!n || (entities.has(n) && !ENTITY_SLOTS.has(slot))) return false
      if (seen.has(n)) return false
      seen.add(n)
      return true
    }),
  })).filter((r) => r.entries.length)
}

function oldLine(expired, now, max = 220) {
  const values = []
  for (const f of expired.slice().sort((a, b) => timeOf(b) - timeOf(a))) {
    const value = factValue(f)
    if (!value || values.some((v) => nearDuplicate(v.value, value))) continue
    const at = timeOf(f)
    const date = at ? new Date(at).toISOString().slice(5, 10) : ''
    values.push({ value: clip(value, 40), date })
    if (values.length >= 3) break
  }
  if (!values.length) return ''
  return clip('旧事：' + values.map((v) => `${v.date ? `${v.date} ` : ''}${v.value}`).join('；'), max)
}

/**
 * @returns {{text:string, body:string, included:Array, dropped:Array, chars:number, groups:Array}}
 */
export function buildFactCard(facts = [], { maxChars = 1500, topics = [], now = Date.now(), personNames = {} } = {}) {
  const budget = Math.max(1, Math.floor(Number(maxChars) || 1500))
  const all = (Array.isArray(facts) ? facts : []).filter(Boolean)
  const active = all.filter((f) => isActiveFact(f, now))
  const expired = all.filter((f) => !f.invalidAt && !['invalidated', 'merged', 'deleted'].includes(String(f.status || '')) && isExpiredFact(f, now))

  const specs = topicSpecsOf(topics)
  const grouped = new Map()
  for (const fact of active) {
    const topic = topicFor(fact, specs, personNames)
    if (!grouped.has(topic.id)) grouped.set(topic.id, { topic, facts: [] })
    grouped.get(topic.id).facts.push(fact)
  }

  const groups = [...grouped.values()].map((g) => {
    const slots = entriesForTopic(g.facts)
    // 每行记住自己是哪几条事实，进卡时才能按行填预算、按行记 included
    const lines = slots.map(({ slot, entries }) => ({
      text: `${SLOT_LABEL[slot] || clip(slot, 16)}：${entries.map((e) => clip(e.value, 96)).join('、')}`,
      facts: entries.map((e) => e.fact),
    }))
    const chosen = new Set(slots.flatMap((s) => s.entries.map((e) => e.fact)))
    const chosenVals = slots.flatMap((s) => s.entries.map((e) => e.value))
    // 槽位封顶之后还有一堆事没进卡：按重要程度/时间排好，
    // 预算还有余量时用「补充」行装进去（真实数据里 293 条只进 9 条，剩 2/3 预算空着）。
    const rest = []
    for (const f of g.facts) {
      if (chosen.has(f)) continue
      if (importanceOf(f) < REST_MIN_IMPORTANCE) continue
      const text = clip(factValue(f), 96)
      if (!text) continue
      if (chosenVals.some((v) => nearDuplicate(v, text)) || rest.some((e) => nearDuplicate(e.text, text))) continue
      rest.push({ text, fact: f })
    }
    rest.sort((a, b) => importanceOf(b.fact) - importanceOf(a.fact) || timeOf(b.fact) - timeOf(a.fact)
      || factValue(b.fact).length - factValue(a.fact).length)
    return {
      id: g.topic.id,
      name: g.topic.name,
      lines,
      rest,
      facts: slots.flatMap((s) => s.entries.map((e) => e.fact)),
      score: Math.max(0, ...g.facts.map((f) => importanceOf(f) * 100 + Math.min(99, Number(f.hits) || 0))),
    }
  }).filter((g) => g.lines.length).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

  if (!groups.length && !expired.length) return { text: '', body: '', included: [], dropped: [], chars: 0, groups: [] }

  const old = oldLine(expired, now)
  const reserve = old ? old.length + 1 : 0
  const included = new Set()
  const accepted = []
  let body = ''
  const fits = (next) => `${CARD_HEADER}\n${next}`.length + reserve <= budget
  // 按「行」填预算，而不是整组进/整组丢：组太大时保留能装下的前面几行，
  // 后面的组继续尝试，避免 1500 字只用一半。
  for (const g of groups) {
    const header = `【${clip(g.name, 24)}】`
    const taken = []
    for (const line of g.lines) {
      const candidate = taken.length
        ? `${header}\n${[...taken, line.text].join('\n')}`
        : `${header}\n${line.text}`
      if (!fits(body ? `${body}\n${candidate}` : candidate)) break
      taken.push(line.text)
      for (const f of line.facts) included.add(f)
    }
    if (!taken.length) continue
    for (let i = 0; i < g.rest.length; i += 3) {
      const line = `补充：${g.rest.slice(i, i + 3).map((e) => e.text).join('、')}`
      const candidate = `${header}\n${[...taken, line].join('\n')}`
      if (!fits(body ? `${body}\n${candidate}` : candidate)) break
      taken.push(line)
      for (const e of g.rest.slice(i, i + 3)) included.add(e.fact)
    }
    const block = `${header}\n${taken.join('\n')}`
    body = body ? `${body}\n${block}` : block
    accepted.push({ id: g.id, name: g.name, facts: g.facts.filter((f) => included.has(f)).length })
  }
  if (old && `${CARD_HEADER}\n${body}${body ? '\n' : ''}${old}`.length <= budget) body += `${body ? '\n' : ''}${old}`
  else if (old && !body) body = clip(old, Math.max(0, budget - CARD_HEADER.length - 1))

  let text = body ? `${CARD_HEADER}\n${body}` : ''
  if (text.length > budget) text = `${text.slice(0, Math.max(0, budget - 1))}…`
  const includedList = active.filter((f) => included.has(f))
  return {
    text,
    body,
    included: includedList,
    dropped: active.filter((f) => !included.has(f)),
    chars: text.length,
    groups: accepted,
  }
}

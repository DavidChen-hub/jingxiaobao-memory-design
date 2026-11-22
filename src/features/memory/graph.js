// 记忆图谱（T-040）：从已有记忆里推「时序 / 同一个人 / 同一主题 / 因果」边。
// 纯函数、无 IO；不改 memories.json，图谱是投影，随时可重建。
// 借鉴 YeStarOne/feiyuos-memory-graph（MIT）的「事件→关系边→沿边扩展」思路；
// 本项目没有实体表/向量，先用时间、人物、主题和因果词做轻量图。

import { inferTopic } from './route.js'

export const GRAPH_VERSION = 1
export const GRAPH_EDGE_TYPES = Object.freeze(['next', 'same_person', 'same_topic', 'cause'])

const HOUR = 3600_000
const DAY = 86400_000

const textOf = (m) => String(m?.text || '')
const atOf = (m) => Number(m?.at) || 0
const scopeOf = (m) => String(m?.scope || '')
const aboutOf = (m) => String(m?.about || '')

/**
 * 从记忆条目建图。
 * @returns {{version:number, builtAt:number, edges:Array<{from:string,to:string,type:string,weight:number,at:number}>, byId:Object}}
 */
export function buildGraph(items = [], { now = Date.now(), maxEdges = 8000 } = {}) {
  const live = (Array.isArray(items) ? items : []).filter((m) => m && m.id && !m.invalidAt)
  const byId = Object.fromEntries(live.map((m) => [m.id, m]))
  const byPair = new Map()
  const TYPE_PRIORITY = { cause: 4, next: 3, same_topic: 2, same_person: 1 }
  const add = (from, to, type, weight, at) => {
    if (!from || !to || from === to) return
    const key = `${from}|${to}`
    const prev = byPair.get(key)
    // 同一对只留最强的一条边；同权重时因果 > 时序 > 主题 > 同人，避免 next 把 cause 顶掉
    if (!prev || weight > prev.weight || (weight === prev.weight && (TYPE_PRIORITY[type] || 0) > (TYPE_PRIORITY[prev.type] || 0))) {
      byPair.set(key, { from, to, type, weight, at: Number(at) || 0 })
    }
  }

  // 1) 时序：同一个聊天里相邻两条，2 小时内 → next（self 原话也按 chatId 和同会话记忆连）
  const byFlow = new Map()
  for (const m of live) {
    const key = m.chatId ? `chat:${m.chatId}` : `scope:${scopeOf(m)}`
    if (!byFlow.has(key)) byFlow.set(key, [])
    byFlow.get(key).push(m)
  }
  for (const rows of byFlow.values()) {
    rows.sort((a, b) => atOf(a) - atOf(b))
    for (let i = 1; i < rows.length; i++) {
      const gap = atOf(rows[i]) - atOf(rows[i - 1])
      if (gap >= 0 && gap <= 2 * HOUR) add(rows[i - 1].id, rows[i].id, 'next', 0.5, atOf(rows[i]))
    }
  }

  // 2) 同一个人：同一 about，30 天内相邻 → same_person（权重低于主题，防压过内容）
  const byPerson = new Map()
  for (const m of live) {
    const a = aboutOf(m)
    if (!a) continue
    if (!byPerson.has(a)) byPerson.set(a, [])
    byPerson.get(a).push(m)
  }
  for (const rows of byPerson.values()) {
    rows.sort((a, b) => atOf(a) - atOf(b))
    for (let i = 1; i < rows.length; i++) {
      const gap = atOf(rows[i]) - atOf(rows[i - 1])
      if (gap >= 0 && gap <= 30 * DAY) add(rows[i - 1].id, rows[i].id, 'same_person', 0.3, atOf(rows[i]))
    }
  }

  // 3) 同一主题 + 同一板块 + 同一 board：7 天内相邻 → same_topic
  const byTopic = new Map()
  for (const m of live) {
    const topic = inferTopic(m)
    if (!topic) continue
    const key = `${scopeOf(m)}|${String(m.board || '')}|${topic}`
    if (!byTopic.has(key)) byTopic.set(key, [])
    byTopic.get(key).push(m)
  }
  for (const rows of byTopic.values()) {
    rows.sort((a, b) => atOf(a) - atOf(b))
    for (let i = 1; i < rows.length; i++) {
      const gap = atOf(rows[i]) - atOf(rows[i - 1])
      if (gap >= 0 && gap <= 7 * DAY) add(rows[i - 1].id, rows[i].id, 'same_topic', 0.4, atOf(rows[i]))
    }
  }

  // 4) 因果词：因为/所以/于是/难怪 前后 2 小时 → cause（去掉「结果/后来」这类叙述词）
  const CAUSE_RE = /因为|所以|于是|难怪/
  for (const rows of byFlow.values()) {
    rows.sort((a, b) => atOf(a) - atOf(b))
    for (let i = 1; i < rows.length; i++) {
      const gap = atOf(rows[i]) - atOf(rows[i - 1])
      if (gap < 0 || gap > 2 * HOUR) continue
      if (CAUSE_RE.test(textOf(rows[i])) || CAUSE_RE.test(textOf(rows[i - 1]))) {
        add(rows[i - 1].id, rows[i].id, 'cause', 0.5, atOf(rows[i]))
      }
    }
  }

  // 限制边数：按权重/时间留最重要的，防极端库把图撑爆
  const edges = [...byPair.values()].sort((a, b) => (b.weight - a.weight) || (b.at - a.at))
  return { version: GRAPH_VERSION, builtAt: now, edges: edges.slice(0, Math.max(1, Number(maxEdges) || 8000)), byId }
}

/** 邻接表（无向使用）：id → [{to,type,weight}]。 */
export function adjacency(edges = []) {
  const map = new Map()
  const push = (a, b, e) => {
    if (!map.has(a)) map.set(a, [])
    map.get(a).push({ to: b, type: e.type, weight: e.weight })
  }
  for (const e of edges) {
    push(e.from, e.to, e)
    push(e.to, e.from, e)
  }
  return map
}

/**
 * 从命中条目沿边扩展（默认 1 跳、最多 maxNeighbors 条），返回 { item, via, weight }。
 * 不在这里判断板块，调用方自己 filter（避免图谱层依赖 memory.js）。
 */
export function expandNeighbors(hits = [], graph = null, { hops = 1, maxNeighbors = 2, allow = null } = {}) {
  const cap = Number(maxNeighbors)
  if (!(cap > 0)) return []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const byId = graph?.byId || {}
  const adj = adjacency(edges)
  const have = new Set(hits.map((h) => h?.it?.id).filter(Boolean))
  const out = []
  let frontier = hits.map((h) => ({ id: h?.it?.id, score: Number(h?.score) || 0 })).filter((x) => x.id)
  for (let hop = 0; hop < Math.max(1, Number(hops) || 1); hop++) {
    const next = []
    for (const node of frontier) {
      for (const e of adj.get(node.id) || []) {
        if (have.has(e.to)) continue
        const item = byId[e.to]
        if (!item) continue
        if (typeof allow === 'function' && !allow(item)) continue
        have.add(e.to)
        const score = node.score * (e.weight || 0.3) * (hop === 0 ? 1 : 0.6)
        out.push({ item, via: node.id, weight: e.weight || 0.3, score })
        next.push({ id: e.to, score })
        if (out.length >= cap) return out
      }
    }
    frontier = next
    if (!frontier.length) break
  }
  return out
}

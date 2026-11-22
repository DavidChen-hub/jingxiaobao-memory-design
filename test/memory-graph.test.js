// 记忆图谱（T-040）：只测纯函数：建边、扩展、排除过期。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, expandNeighbors, adjacency, GRAPH_EDGE_TYPES } from '../src/features/memory/graph.js'

const NOW = Date.parse('2026-11-16T18:00:00+08:00')
const H = 3600_000
const D = 86400_000

function items() {
  return [
    { id: 'a', text: '他说因为下雨，今天不出门', kind: 'event', scope: 'owner', chatId: 'private:1', about: 'u1', at: NOW - 3 * H },
    { id: 'b', text: '所以我们在家煮了面', kind: 'event', scope: 'owner', chatId: 'private:1', about: 'u1', at: NOW - 2 * H },
    { id: 'c', text: '结果他忘了买葱', kind: 'event', scope: 'owner', chatId: 'private:1', about: 'u1', at: NOW - 1 * H },
    { id: 'd', text: '朋友A喜欢钓鱼', kind: 'fact', scope: 'owner', about: 'u2', at: NOW - 2 * D },
    { id: 'e', text: '朋友A周末去钓鱼了', kind: 'event', scope: 'owner', about: 'u2', at: NOW - 1 * D },
    { id: 'h', text: '阿强在收拾房间', kind: 'event', scope: 'owner', about: 'u3', at: NOW - 5 * H },
    { id: 'i', text: '阿强把钥匙放在桌上', kind: 'event', scope: 'owner', about: 'u3', at: NOW - 2 * H },
    { id: 'f', text: '在抖音看了手工视频', kind: 'event', scope: 'douyin', about: '', tags: ['抖音'], at: NOW - 5 * H },
    { id: 'g', text: '在抖音评论了手工视频', kind: 'event', scope: 'douyin', about: '', tags: ['抖音'], at: NOW - 4 * H },
    { id: 'x', text: '过时的旧事', kind: 'event', scope: 'owner', invalidAt: NOW - 1 * D, at: NOW - 10 * D },
  ]
}

test('建图：时序 / 同一个人 / 因果 / 同一主题边都能出来', () => {
  const g = buildGraph(items(), { now: NOW })
  const types = new Set(g.edges.map((e) => e.type))
  assert.ok(types.has('next'), '相邻事件有时序边')
  assert.ok(types.has('cause'), '有因为/所以/结果的相邻事件有因果边')
  assert.ok(types.has('same_person'), '同一个人有 same_person 边')
  assert.ok(types.has('same_topic'), '同板块同主题有 same_topic 边')
  assert.ok(g.edges.every((e) => GRAPH_EDGE_TYPES.includes(e.type)))
})

test('建图：过期条目不进图', () => {
  const g = buildGraph(items(), { now: NOW })
  assert.equal(g.byId.x, undefined)
  assert.ok(!g.edges.some((e) => e.from === 'x' || e.to === 'x'))
})

test('扩展：从命中条目沿边走一跳，拿到相关的事', () => {
  const list = items()
  const g = buildGraph(list, { now: NOW })
  const hits = [{ it: list[0], score: 10 }]
  const out = expandNeighbors(hits, g, { maxNeighbors: 2 })
  assert.ok(out.length >= 1)
  assert.ok(out.every((x) => x.item && x.via === 'a'))
  assert.ok(out.some((x) => x.item.id === 'b'))
})

test('邻接表：边无向，两边都能走', () => {
  const g = buildGraph(items(), { now: NOW })
  const adj = adjacency(g.edges)
  const a = adj.get('a') || []
  const b = adj.get('b') || []
  assert.ok(a.some((e) => e.to === 'b'))
  assert.ok(b.some((e) => e.to === 'a'))
})

test('上限：maxEdges 生效', () => {
  const g = buildGraph(items(), { now: NOW, maxEdges: 2 })
  assert.ok(g.edges.length <= 2)
})

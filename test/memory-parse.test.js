import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseItemsJson } from '../src/features/memory.js'

test('抽取结果解析：正常 JSON 原样返回', () => {
  const arr = parseItemsJson('[{"op":"add","text":"阿青常玩狼人杀"},{"op":"add","text":"阿青写了五子棋"}]')
  assert.equal(arr.length, 2)
  assert.equal(arr[0].text, '阿青常玩狼人杀')
})

test('抽取结果解析：被 maxTokens 截断时，救回已经完整的条目', () => {
  const truncated = '[{"op":"add","text":"第一条完整"},{"op":"add","text":"第二条完整"},{"op":"add","text":"第三条被截断'
  const arr = parseItemsJson(truncated)
  assert.equal(arr.length, 2, '应该救回前两条：' + JSON.stringify(arr))
  assert.equal(arr[1].text, '第二条完整')
})

test('抽取结果解析：尾逗号也能吃下', () => {
  const arr = parseItemsJson('[{"op":"add","text":"甲"},{"op":"add","text":"乙"},]')
  assert.equal(arr.length, 2)
})

test('抽取结果解析：模型没给数组 / 空输出 → 空数组，不抛错', () => {
  assert.deepEqual(parseItemsJson(''), [])
  assert.deepEqual(parseItemsJson('这次没什么值得记的'), [])
  assert.deepEqual(parseItemsJson('[]'), [])
})

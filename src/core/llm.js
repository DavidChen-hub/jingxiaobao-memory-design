// 最小 LLM 适配器：只依赖宿主提供的 llm.stream，不绑定任何 provider。
// 约定：stream(params) 逐块产出 { type: 'text-delta', text }，结束时产出 { type: 'finish', ... }。

import { randomUUID } from 'node:crypto'

export async function askModel(dsh, o = {}) {
  const llm = dsh?.llm || dsh?.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
  const t = o.cfg?.model?.provider && o.cfg?.model?.model
    ? o.cfg.model
    : (dsh?.get?.('agentDefaultModel')?.currentSelection?.() || null)
  const content = [{ type: 'text', text: String(o.text || '') }]
  for (const img of o.images || []) content.push({ type: 'image', data: img.data, mediaType: img.mediaType, name: img.name || 'memory-image' })
  const messages = [{ role: 'user', id: randomUUID(), content, source: { kind: 'plugin', plugin: 'memory-design' } }]
  const params = {
    ...(t?.provider ? { provider: t.provider } : {}),
    ...(t?.model ? { model: t.model } : {}),
    system: o.system || '',
    messages,
    maxTokens: o.maxTokens || 600,
    temperature: o.temperature ?? 0.3,
  }
  let text = ''
  for await (const chunk of llm.stream(params)) {
    if (chunk?.type === 'text-delta' && chunk.text) text += chunk.text
  }
  return text
}

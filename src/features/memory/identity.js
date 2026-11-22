// 全局身份卡（T-037）：非敏感身份/关系投影，每个场合都注入。
// 纯函数、无 IO；不改 memories.json，卡是投影。

export const DEFAULT_BOT_NAME = '大肥鱼'
export const DEFAULT_OWNER_NAME = '主人'
export const DEFAULT_MAX_CHARS = 500

// 这些词一旦出现就不进全局卡：宁可少认人，也不把私事带进群/抖音。
const SENSITIVE_RE = /密码|验证码|住址|地址|住在|家庭住址|学校|班级|年级|电话|手机号|身份证|银行卡|账号|帐号|微信|QQ号|邮箱|生日|几号生|宿舍|公司地址/i

/** 一条事实能不能进全局身份卡。 */
export function isIdentityFact(item) {
  if (!item || item.invalidAt) return false
  // 事件/经历不是身份：她要的是「我是谁」，不是「我刚刚说了什么」
  if (item.kind === 'event' || item.source === 'event' || item.source === 'turn') return false
  const text = String(item.text || '')
  if (!text || SENSITIVE_RE.test(text)) return false
  if (String(item.scope || '') === 'identity') return true
  const tags = Array.isArray(item.tags) ? item.tags.map(String) : []
  if (tags.includes('身份') || tags.includes('关系')) return true
  // T-035 的自述资料：只说「我的昵称/名字/叫/是」，不是私事
  if (String(item.scope || '') === 'self' && /我的.{0,6}(昵称|名字|叫|是)/.test(text)) return true
  return false
}

/**
 * 生成全局身份卡。没有身份事实时也返回「你是谁、主人是谁」两行。
 * @returns {{text:string, chars:number, included:Array}}
 */
export function buildIdentityCard({ items = [], ownerName = DEFAULT_OWNER_NAME, botName = DEFAULT_BOT_NAME, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const bot = String(botName || DEFAULT_BOT_NAME).trim() || DEFAULT_BOT_NAME
  const owner = String(ownerName || DEFAULT_OWNER_NAME).trim() || DEFAULT_OWNER_NAME
  const head = `【你自己和身边的人（每个场合都通用）】\n你是${bot}；主人是${owner}。`
  const seen = new Set()
  const lines = []
  for (const m of Array.isArray(items) ? items : []) {
    if (!isIdentityFact(m)) continue
    const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!text || seen.has(text)) continue
    seen.add(text)
    lines.push(`- ${text}`)
  }
  let text = head + (lines.length ? '\n' + lines.join('\n') : '')
  if (text.length > Math.max(80, Number(maxChars) || DEFAULT_MAX_CHARS)) {
    text = [...text].slice(0, Math.max(80, Number(maxChars) || DEFAULT_MAX_CHARS) - 1).join('') + '…'
  }
  return { text, chars: text.length, included: lines.map((x) => x.slice(2)) }
}

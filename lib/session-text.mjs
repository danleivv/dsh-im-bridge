/**
 * 从会话事件里取出文字。
 *
 * 这里踩过一次坑：**用户消息和助手回复的结构不一样**——
 *   用户：{ data: { content: [...], source, role, id } }
 *   助手：{ data: { message: { content: [...] }, turn, ... } }
 * 按助手的路径去读用户消息，永远拿到空字符串，于是所有桌面输入都被当成"没有文字"丢掉。
 *
 * 单独抽成模块就是为了能单测这两种形状。
 */

/** 把 content 块数组压成纯文本（只取 text 块）。 */
export function blocksToText(blocks) {
  const parts = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** 用户消息：内容在 data.content。 */
export function userMessageText(data) {
  if (!data) return ''
  return blocksToText(data.content ?? data.message?.content)
}

/** 助手回复：内容在 data.message.content。 */
export function assistantMessageText(data) {
  if (!data) return ''
  return blocksToText(data.message?.content ?? data.content)
}

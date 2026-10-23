/**
 * feishu-transport — the only part of the gateway that touches Feishu.
 *
 * Long-connection (WebSocket) mode: no public IP, no webhook, no tunnel — the
 * long-connection event mode. Everything above this layer is transport-agnostic
 * and tested with a fake (see test/gateway-core.test.mjs).
 *
 * Deliberately thin: normalize an event into
 *   { eventId, messageId, chatId, userId, text, fromBot }
 * and expose send/reply. Policy lives in gateway-core.
 *
 * Requires `@larksuiteoapi/node-sdk` (installed in this repo).
 */
import * as Lark from '@larksuiteoapi/node-sdk'
import { buildMessagePayload, hasMarkdownSyntax } from './feishu-payload.mjs'
import { markdownToText } from './markdown.mjs'

const REACTION_TIMEOUT_MS = 5000

/**
 * 从消息里取出附件描述。
 *
 * 飞书的文件类消息结构：{ file_key, file_name, duration? }（image 只有 image_key）。
 * 文本类消息返回空数组，走原来的文本路径。
 */
export function extractAttachments(messageType, content) {
  const type = String(messageType ?? '')
  const ATTACHMENT_TYPES = new Set(['file', 'image', 'audio', 'media', 'sticker'])
  if (!ATTACHMENT_TYPES.has(type)) return []
  let body = {}
  try {
    body = content ? JSON.parse(content) : {}
  } catch {
    return []
  }
  // 「获取消息资源」接口的 type 只认 image / file
  const resourceType = type === 'image' || type === 'sticker' ? 'image' : 'file'
  const fileKey = body.image_key ?? body.file_key ?? body.fileKey
  if (!fileKey) return []
  return [
    {
      kind: resourceType,
      messageType: type,
      fileKey,
      fileName: body.file_name ?? body.fileName ?? (resourceType === 'image' ? 'image.png' : 'file'),
      durationMs: Number(body.duration ?? 0) || 0,
    },
  ]
}

/** Pull plain text out of Feishu's JSON-encoded message content. */
export function extractText(messageType, content) {
  if (!content) return ''
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    return ''
  }
  if (messageType === 'text') {
    // Feishu renders @mentions as @_user_1 placeholders.
    return String(parsed.text ?? '')
      .replace(/@_user_\d+/g, '')
      .replace(/@_all/g, '')
      .trim()
  }
  if (messageType === 'post') {
    // Feishu rich text: { zh_cn: { title, content: [ [ {tag,text}, … ], … ] } }
    const lines = []
    for (const lang of Object.keys(parsed)) {
      const body = parsed[lang]
      const blocks = Array.isArray(body?.content) ? body.content : Array.isArray(body) ? body : []
      if (body?.title) lines.push(String(body.title))
      for (const line of blocks) {
        const text = (Array.isArray(line) ? line : [])
          .map((node) => (node?.tag === 'text' ? node.text ?? '' : node?.tag === 'a' ? node.text ?? '' : ''))
          .join('')
        if (text) lines.push(text)
      }
    }
    return lines.join('\n').trim()
  }
  return ''
}

export function createFeishuTransport({ appId, appSecret, log = () => {}, domain = 'feishu', replyFormat = 'text', cardVersion = '2.0', cardTitle = null }) {
  if (!appId || !appSecret) throw new Error('feishu transport needs appId and appSecret')

  /**
   * Build the outbound payload.
   *
   * `text` renders NO markdown in Feishu (symbols show literally), so formatting
   * requires a card. `card` uses the CARD 2.0 `markdown` element, which handles
   * headings, tables, lists and code blocks — the shapes an agent reply actually
   * contains. If the tenant rejects card 2.0 the send falls back to plain text
   * (see below), so a reply is never lost to a formatting attempt.
   */
  function buildPayload(text) {
    // Short acknowledgements stay plain text: a one-line card is mostly padding.
    const format = replyFormat === 'card' && hasMarkdownSyntax(text) ? 'card' : 'text'
    return buildMessagePayload(text, { format, cardVersion, title: cardTitle || null })
  }

  /**
   * Send `text`, degrading a card to plain text only when the SEND itself fails.
   *
   * Deliberately no read-back verification: `im.message.get` returns a generic
   * "please upgrade your client" preview for card payloads even when every client
   * renders them correctly, so treating that preview as a failure signal silently
   * downgrades working cards. Verified on both phone and desktop clients.
   */
  async function sendWithFallback(deliver, text) {
    const payload = buildPayload(text)
    if (payload.msg_type !== 'interactive') return deliver(payload)
    try {
      return await deliver(payload)
    } catch (error) {
      log('card send failed, retrying as plain text:', error?.message ?? error)
      return deliver(buildMessagePayload(markdownToText(text), { format: 'text' }))
    }
  }

  const baseConfig = {
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
  }
  const client = new Lark.Client(baseConfig)

  /** Send a fresh message to a chat. */
  async function sendText({ chatId, text }) {
    const response = await sendWithFallback(
      (payload) => client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, ...payload } }),
      text,
    )
    if (response?.code && response.code !== 0) throw new Error('feishu send failed: ' + response.msg + ' (' + response.code + ')')
    return response
  }

  /** Reply in-thread to a specific message; falls back to a plain send. */
  async function replyMessage({ messageId, chatId, text }) {
    try {
      const response = await sendWithFallback(
        (payload) => client.im.message.reply({ path: { message_id: messageId }, data: payload }),
        text,
      )
      if (response?.code && response.code !== 0) throw new Error('feishu reply failed: ' + response.msg + ' (' + response.code + ')')
      return response
    } catch (error) {
      log('reply failed, falling back to send:', error?.message ?? error)
      if (!chatId) throw error
      return sendText({ chatId, text })
    }
  }

  /** Best-effort emoji reaction; failures are never fatal. */
  /** 发一张卡片，返回 message_id（进度卡要拿它做原地更新）。 */
  async function createCard({ chatId, card }) {
    const response = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    })
    if (response?.code && response.code !== 0) {
      throw new Error('createCard failed code=' + response.code + ' msg=' + response.msg)
    }
    return response?.data?.message_id ?? ''
  }

  /** 原地更新已发送的卡片（长任务进度用，避免刷屏）。 */
  async function updateCard({ messageId, card }) {
    if (!messageId) return null
    return client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    })
  }

  async function addReaction({ messageId, emoji }) {
    if (!messageId || !emoji) return
    const timer = AbortSignal.timeout ? AbortSignal.timeout(REACTION_TIMEOUT_MS) : undefined
    try {
      await client.im.messageReaction.create(
        { path: { message_id: messageId }, data: { reaction_type: { emoji_type: emoji } } },
        timer ? { signal: timer } : undefined,
      )
    } catch (error) {
      // 400 的成因不少（重复表情、消息类型不支持、权限），把服务端的原话记下来，
      // 否则只剩一句 "status code 400" 无从判断。
      const detail = error?.response?.data
      log(
        'reaction failed (ignored):',
        error?.message ?? error,
        detail ? 'code=' + detail.code + ' msg=' + detail.msg : '',
      )
    }
  }

  /**
   * 下载消息里的资源文件。
   *
   * 官方限制：单文件 ≤ 100 MB；机器人必须还在这个会话里；卡片里的资源取不到。
   */
  async function downloadAttachment({ messageId, fileKey, kind = 'file' }) {
    const response = await client.im.messageResource.get({
      params: { type: kind === 'image' ? 'image' : 'file' },
      path: { message_id: messageId, file_key: fileKey },
    })
    const chunks = []
    await new Promise((resolve, reject) => {
      const stream = response.getReadableStream()
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      stream.on('end', resolve)
      stream.on('error', reject)
    })
    return Buffer.concat(chunks)
  }

  /** Start the long connection; onMessage receives normalized messages. */
  async function start({ onMessage, onCardAction }) {
    const dispatcher = new Lark.EventDispatcher({}).register({
      'card.action.trigger': async (data) => {
        const value = data?.action?.value
        const context = data?.context ?? {}
        try {
          if (typeof onCardAction !== 'function') return {}
          const result = await onCardAction({
            value: value && typeof value === 'object' ? value : {},
            messageId: context.open_message_id,
            chatId: context.open_chat_id,
            userId: data?.operator?.open_id ?? '',
            option: data?.action?.option ?? null,
          })
          // 回调里返回 card 可以让飞书直接替换卡片内容，省一次 PATCH。
          return result ?? {}
        } catch (error) {
          log('card action failed:', error?.message ?? error)
          return { toast: { type: 'error', content: String(error?.message ?? error) } }
        }
      },
      'im.message.receive_v1': async (data) => {
        const message = data?.message ?? {}
        const sender = data?.sender ?? {}
        const normalized = {
          eventId: data?.header?.event_id ?? data?.event_id ?? message.message_id,
          messageId: message.message_id,
          chatId: message.chat_id,
          userId: sender?.sender_id?.open_id ?? '',
          text: extractText(message.message_type, message.content),
          attachments: extractAttachments(message.message_type, message.content),
          fromBot: sender?.sender_type === 'app' || sender?.sender_type === 'bot',
          raw: message,
        }
        try {
          await onMessage(normalized)
        } catch (error) {
          log('onMessage failed:', error?.message ?? error)
        }
      },
    })
    const wsClient = new Lark.WSClient({ ...baseConfig, loggerLevel: Lark.LoggerLevel.warn })
    await wsClient.start({ eventDispatcher: dispatcher })
    log('feishu long connection started (appId=' + String(appId).slice(0, 8) + '…)')
    return {
      close: async () => {
        try {
          await wsClient.close?.()
        } catch {}
      },
    }
  }

  return { start, sendText, replyMessage, addReaction, createCard, updateCard, downloadAttachment }
}

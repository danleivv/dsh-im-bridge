/**
 * 把“发文件到飞书”做成 DSH 的**原生工具**，而不是一个要记路径的命令行。
 *
 * 工具声明遵循 DSH 的工具形状：
 *
 *   { name, description, parameters(JSON Schema), output: { schema, render }, execute(args, exec) }
 *
 * 注册后 agent 直接调用，不受当前目录、PATH、引号转义影响。
 *
 * 目标聊天解析优先级：chat 参数 > session 参数 > 调用方会话 > gateway.json 的 defaultChat。
 * 会话到聊天的映射来自 config.json 的 sessionKeys（`feishu:<chat_id>:<open_id>` → 会话 id），
 * 每次调用重读，改完即时生效。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import * as Lark from '@larksuiteoapi/node-sdk'
import { createMediaSender } from './feishu-media.mjs'
import { readGatewayFile, readLastChat, writeLastChat, DEFAULT_ROOT } from './gateway-config.mjs'

export const TOOL_NAME = 'feishu_send_file'

/**
 * 从 sessionKeys 里找出会话对应的聊天 id。
 *
 * @param {string} sessionId
 * @param {Record<string, string>} sessionKeys
 * @returns {string | null}
 */
export function chatIdForSession(sessionId, sessionKeys) {
  if (!sessionId) return null
  for (const [key, value] of Object.entries(sessionKeys ?? {})) {
    if (value !== sessionId) continue
    const parts = String(key).split(':')
    if (parts[0] === 'feishu' && parts[1]) return parts[1]
  }
  return null
}

/**
 * 解析目标聊天。
 *
 * @param {{chat?: string, session?: string, sessionKeys?: Record<string,string>, defaultChat?: string}} input
 * @returns {{chatId: string, source: string}}
 */
export function resolveTargetChat(input) {
  if (input.chat) return { chatId: input.chat, source: 'chat 参数' }
  if (input.session) {
    const chatId = chatIdForSession(input.session, input.sessionKeys)
    if (!chatId) throw new Error('会话 ' + input.session + ' 在 config.json 的 sessionKeys 里没有对应的飞书聊天')
    return { chatId, source: 'session 参数' }
  }
  if (input.defaultChat) return { chatId: input.defaultChat, source: 'gateway.json 的 defaultChat' }
  // 最后兜底：本机器人最近收到过消息的那个会话。chat_id 按应用隔离，这个值一定可达。
  if (input.lastChat?.chatId) return { chatId: input.lastChat.chatId, source: '最近收到消息的聊天' }
  throw new Error(
    '无法确定目标聊天：给出 chat 或 session；或在 gateway.json 设置 defaultChat；' +
      '或先让机器人收到一条消息（它会记下「最近收到消息的聊天」，之后自动兜底）',
  )
}

/** 每个进程只建一个飞书客户端。 */
let cachedClient = null
let cachedKey = ''

function clientFor(credentials) {
  const key = credentials.appId + ':' + (credentials.appSecret ?? '').slice(-4)
  if (cachedClient && cachedKey === key) return cachedClient
  cachedClient = new Lark.Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: credentials.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
  })
  cachedKey = key
  return cachedClient
}

/**
 * 构造工具定义。
 *
 * @param {{root?: string, log?: Function, senderFactory?: Function}} [options]
 */
export function createSendFileTool(options = {}) {
  const root = options.root ?? DEFAULT_ROOT
  const log = options.log ?? (() => {})
  const senderFactory = options.senderFactory ?? ((client) => createMediaSender({ client, log }))

  function loadState() {
    let sessionKeys = {}
    try {
      const runtime = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
      sessionKeys = runtime.sessionKeys ?? {}
    } catch (error) {
      if (error?.code !== 'ENOENT') log('config.json unreadable:', error?.message ?? error)
    }
    const gateway = readGatewayFile(join(root, 'gateway.json'))
    return { sessionKeys, gateway }
  }

  return {
    name: TOOL_NAME,
    description:
      '把本机文件发送到飞书聊天：图片、视频、音频、文档都可以，按扩展名自动选择发送方式。' +
      '图片上限 10 MB，其他 30 MB。默认发到调用它的那个会话所绑定的飞书聊天。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '要发送的文件路径，可多个。相对路径按当前工作目录解析。',
        },
        chat: { type: 'string', description: '目标飞书 chat_id；留空则按会话解析。' },
        session: { type: 'string', description: '目标会话 id；留空则用调用方自己的会话。' },
        cover: { type: 'string', description: '视频封面图片路径（仅发视频时有效）。' },
      },
      required: ['files'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chatId: { type: 'string' },
          sent: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                kind: { type: 'string' },
                bytes: { type: 'number' },
                messageId: { type: 'string' },
              },
              required: ['path', 'kind', 'bytes'],
            },
          },
          failed: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                error: { type: 'string' },
              },
              required: ['path', 'error'],
            },
          },
        },
        required: ['chatId', 'sent'],
      },
      render: (_args, value) => {
        const lines = []
        for (const item of value.sent ?? []) {
          lines.push('已发送 ' + item.kind + '：' + item.path + '（' + (item.bytes / 1024).toFixed(0) + ' KB）')
        }
        for (const item of value.failed ?? []) {
          lines.push('发送失败：' + item.path + ' — ' + item.error)
        }
        lines.push('聊天：' + value.chatId)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const files = Array.isArray(args.files) ? args.files.filter(Boolean) : []
      if (files.length === 0) throw new Error('files 不能为空')

      const { sessionKeys, gateway } = loadState()
      const appId = process.env.FEISHU_APP_ID || gateway.appId
      const appSecret = process.env.FEISHU_APP_SECRET || gateway.appSecret
      if (!appId || !appSecret) {
        throw new Error('缺少飞书应用凭据：先运行 dsh-feishu-setup（或 tools/setup-feishu.mjs）')
      }

      const sessionId = args.session ?? exec?.agent?.session?.id
      const { chatId, source } = resolveTargetChat({
        chat: args.chat,
        // 显式参数优先；否则用调用方自己的会话。
        session: args.session ?? sessionId,
        sessionKeys,
        defaultChat: gateway.defaultChat,
        lastChat: readLastChat(root),
      })
      if (!args.chat && !args.session && !sessionId) {
        log('falling back to defaultChat (' + source + ')')
      }

      const sender = senderFactory(clientFor({ appId, appSecret, domain: gateway.domain }))
      const sent = []
      const failed = []
      for (const file of files) {
        try {
          const result = await sender.send({ chatId, filePath: file, coverPath: args.cover })
          sent.push({ path: file, kind: result.kind, bytes: result.bytes, messageId: result.messageId })
        } catch (error) {
          failed.push({ path: file, error: String(error?.message ?? error) })
        }
      }
      if (sent.length === 0 && failed.length > 0) {
        throw new Error('全部发送失败：' + failed.map((item) => item.path + ' — ' + item.error).join('；'))
      }
      return { chatId, sent, ...(failed.length > 0 ? { failed } : {}) }
    },
  }
}

#!/usr/bin/env node
/**
 * chat-log.mjs — 查看飞书会话里最近的消息，用来确认“消息到底发出去了没有”。
 *
 * 插件日志只能证明“我们调用了发送接口”；消息是否真的出现在会话里，要看飞书侧。
 * 这个工具直接读飞书的消息列表，并给出类型、长度与时间。
 *
 * 用法：
 *   node tools/chat-log.mjs --chat oc_xxx
 *   node tools/chat-log.mjs --chat oc_xxx --limit 20
 *   node tools/chat-log.mjs --chat oc_xxx --full        # 打印完整内容
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import * as Lark from '@larksuiteoapi/node-sdk'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined
}

const chatId = flag('chat')
if (!chatId) {
  console.error('用法: node tools/chat-log.mjs --chat <chat_id> [--limit N] [--full]')
  process.exit(1)
}
const limit = Number(flag('limit') ?? 10)
const full = args.includes('--full')

const config = JSON.parse(readFileSync(join(homedir(), '.cc-dsh-bridge', 'gateway.json'), 'utf8'))
const client = new Lark.Client({
  appId: config.appId ?? process.env.FEISHU_APP_ID,
  appSecret: config.appSecret ?? process.env.FEISHU_APP_SECRET,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
})

const response = await client.im.message.list({
  params: { container_id_type: 'chat', container_id: chatId, sort_type: 'ByCreateTimeDesc', page_size: limit },
})
if (response?.code && response.code !== 0) {
  console.error('查询失败 code=' + response.code + ' msg=' + response.msg)
  process.exit(1)
}

const items = response?.data?.items ?? []
console.log('会话 ' + chatId + '，最近 ' + items.length + ' 条：\n')
for (const message of items) {
  const time = new Date(Number(message.create_time)).toLocaleString('zh-CN', { hour12: false })
  const body = String(message.body?.content ?? '')
  console.log('  ' + time + '  ' + message.msg_type + '  ' + body.length + ' 字符  ' + message.message_id)
  const shown = full ? body : body.slice(0, 200)
  console.log('    ' + shown.replace(/\n/g, '\n    '))
  console.log('')
}

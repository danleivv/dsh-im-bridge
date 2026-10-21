#!/usr/bin/env node
/**
 * send-media.mjs — 用当前飞书机器人把文件 / 图片 / 视频发到聊天里。
 *
 * agent 与人都可以用：它是独立命令，不经过模型上下文。
 *
 * 用法：
 *   node tools/send-media.mjs --file 产物.md                 # 发到配置里的默认聊天
 *   node tools/send-media.mjs --file a.png --file b.mp4      # 一次多个
 *   node tools/send-media.mjs --file a.mp4 --cover a.jpg     # 视频封面
 *   node tools/send-media.mjs --session session-<uuid> --file x.md
 *   node tools/send-media.mjs --chat oc_xxx --file x.pdf
 *
 * 目标聊天按优先级解析：--chat > --session（从 config.json 的 sessionKeys 反查）> defaultChat。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import * as Lark from '@larksuiteoapi/node-sdk'
import { createMediaSender } from '../lib/feishu-media.mjs'

const ROOT = join(homedir(), '.dsh-im-bridge')
const args = process.argv.slice(2)

function flag(name) {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined
}
function flagAll(name) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--' + name && args[i + 1] && !args[i + 1].startsWith('--')) out.push(args[i + 1])
  }
  return out
}

const files = flagAll('file')
if (files.length === 0) {
  console.error('用法: node tools/send-media.mjs --file <路径> [--file ...] [--chat oc_xxx | --session session-xxx | 默认聊天]')
  process.exit(1)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

const gateway = readJson(join(ROOT, 'gateway.json'))
const runtime = readJson(join(ROOT, 'config.json'))
const appId = process.env.FEISHU_APP_ID || gateway.appId
const appSecret = process.env.FEISHU_APP_SECRET || gateway.appSecret
if (!appId || !appSecret) {
  console.error('缺少凭据：请先运行 node tools/feishu-setup-qr.mjs 或 tools/setup-feishu.mjs')
  process.exit(1)
}

/** 聊天 id 解析：--chat > --session > defaultChat。 */
function resolveChatId() {
  const explicit = flag('chat')
  if (explicit) return explicit
  const session = flag('session')
  if (session) {
    const mapping = runtime.sessionKeys ?? {}
    for (const [key, value] of Object.entries(mapping)) {
      if (value !== session) continue
      const parts = String(key).split(':')
      if (parts[0] === 'feishu' && parts[1]) return parts[1]
    }
    console.error('在 config.json 的 sessionKeys 里找不到该会话对应的聊天: ' + session)
    process.exit(1)
  }
  if (gateway.defaultChat) return gateway.defaultChat
  console.error('未指定目标聊天：加 --chat，或 --session，或在 gateway.json 里设置 defaultChat')
  process.exit(1)
}

const chatId = resolveChatId()
const client = new Lark.Client({
  appId,
  appSecret,
  appType: Lark.AppType.SelfBuild,
  domain: (gateway.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu),
})
const sender = createMediaSender({ client, log: (line) => console.error('  ' + line) })

let failed = 0
for (const file of files) {
  try {
    const result = await sender.send({ chatId, filePath: file, coverPath: flag('cover') })
    console.log('✅ ' + file + ' → ' + chatId + '  (' + result.kind + ', ' + (result.bytes / 1024).toFixed(0) + ' KB, ' + result.messageId + ')')
  } catch (error) {
    failed += 1
    console.error('❌ ' + file + ': ' + (error?.message ?? error))
  }
}
process.exit(failed === 0 ? 0 : 1)

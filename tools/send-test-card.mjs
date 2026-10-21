#!/usr/bin/env node
/**
 * send-test-card.mjs — send one demo message to a Feishu chat so a human can judge
 * how it RENDERS.
 *
 * Rendering cannot be verified from the outside: only the person looking at the phone
 * knows whether cards work, whether tables fit, whether bold is bold. So this sends a
 * side-by-side pair (card vs plain text) and prints the API responses.
 *
 * Usage:
 *   node tools/send-test-card.mjs --chat oc_xxx            # both card and text
 *   node tools/send-test-card.mjs --chat oc_xxx --only card
 *   node tools/send-test-card.mjs --chat oc_xxx --card-version 1.0
 *
 * Credentials come from ~/.dsh-im-bridge/gateway.json (never printed).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import * as Lark from '@larksuiteoapi/node-sdk'
import { buildMessagePayload } from '../lib/feishu-payload.mjs'
import { markdownToText } from '../lib/markdown.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const chatId = flag('chat')
if (!chatId) {
  console.error('用法: node tools/send-test-card.mjs --chat <chat_id> [--only card|text] [--card-version 2.0]')
  process.exit(1)
}
const only = flag('only', null)
const replyTo = flag('reply-to', null)
// 默认跟随 gateway.json 的实际配置：否则测的不是线上那条路径。
const configured = (() => {
  try { return JSON.parse(readFileSync(join(homedir(), '.dsh-im-bridge', 'gateway.json'), 'utf8')) } catch { return {} }
})()
const cardVersion = flag('card-version', configured.cardVersion ?? '1.0')

const config = JSON.parse(readFileSync(join(homedir(), '.dsh-im-bridge', 'gateway.json'), 'utf8'))
const client = new Lark.Client({
  appId: config.appId,
  appSecret: config.appSecret,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
})

const markdown = [
  '## 格式测试',
  '',
  '这里有 **粗体**、*斜体*、~~删除线~~ 和 `行内代码`，还有链接 [示例](https://example.com)。',
  '',
  '| 工具 | 次数 | 说明 |',
  '|---|---|---|',
  '| pwsh | 3 | 长任务 |',
  '| read | 5 | 读文件 |',
  '',
  '```powershell',
  'Start-Sleep -Seconds 5; Get-Date',
  '```',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '> 引用块',
].join('\n')

async function send(label, text, options) {
  const payload = buildMessagePayload(text, options)
  process.stdout.write('  ' + label + (replyTo ? ' [reply] ' : ' [create] ') + '发送中… ')
  try {
    const response = replyTo
      ? await client.im.message.reply({ path: { message_id: replyTo }, data: payload })
      : await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, ...payload },
        })
    if (response?.code && response.code !== 0) {
      console.log('❌ code=' + response.code + ' msg=' + response.msg)
      return false
    }
    console.log('✅ message_id=' + (response?.data?.message_id ?? '?'))
    return true
  } catch (error) {
    console.log('❌ ' + (error?.message ?? error))
    return false
  }
}

console.log('目标会话: ' + chatId)
let ok = true
if (only !== 'text') ok = (await send('卡片 ' + cardVersion + '（原始 markdown）', markdown, { format: 'card', cardVersion })) && ok
if (only !== 'card') ok = (await send('纯文本（已去符号）', markdownToText(markdown), { format: 'text' })) && ok

console.log('\n对比两条的显示效果：')
console.log('  - 卡片：粗体/表格/代码块是否真的渲染')
console.log('  - 纯文本：符号是否消失（应该没有 # * | ` 这些）')
process.exit(ok ? 0 : 1)

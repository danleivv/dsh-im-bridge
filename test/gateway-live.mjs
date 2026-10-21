/**
 * gateway-live — integration test of the NEW gateway against the REAL plugin.
 *
 * Feishu itself is faked (no credentials needed), but the plugin IPC, the session
 * mapping, the injection and the turn/watermark bookkeeping are all real. It runs
 * against the PILOT session only — never the production one.
 *
 * Requires in ~/.cc-dsh-bridge/config.json:
 *   allowSessions: [ ...includes the pilot session... ]
 *   sessionKeys:   { "feishu:oc_gateway_test:ou_gateway_test": "<pilot session id>" }
 *
 * Run: node test/gateway-live.mjs
 */
import { createPluginIpc } from '../lib/plugin-ipc.mjs'
import { createGateway } from '../lib/gateway-core.mjs'

const CHAT = 'oc_gateway_test'
const USER = 'ou_gateway_test'
const KEY = 'feishu:' + CHAT + ':' + USER
const REPLY_TIMEOUT_MS = 240000

const logs = []
const log = (...args) => {
  const line = args.join(' ')
  logs.push(line)
  console.log('  [gateway] ' + line)
}

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function fakeTransport() {
  const sent = []
  return {
    sent,
    sendText: async ({ chatId, text }) => {
      sent.push({ kind: 'send', chatId, text })
      console.log('  ← sendText: ' + JSON.stringify(text.slice(0, 80)))
    },
    replyMessage: async ({ messageId, text }) => {
      sent.push({ kind: 'reply', messageId, text })
      console.log('  ← reply: ' + JSON.stringify(text.slice(0, 80)))
    },
    addReaction: async () => {},
  }
}

async function main() {
  const plugin = createPluginIpc({ port: 9811, log })
  await plugin.whenConnected()
  const hello = await plugin.hello()
  console.log('\n插件 pid=' + hello.pid + ' ipcBound=' + hello.ipcBound)
  check('插件已连接且 IPC 在监听', hello.ipcBound === true, String(hello.ipcBound))
  check('测试 key 已映射', (hello.sessionKeys ?? []).includes(KEY), JSON.stringify(hello.sessionKeys))

  const attached = await plugin.attach({ key: KEY })
  const session = attached.sessionId
  console.log('测试会话 = ' + session + '\n')
  check('测试会话在 allowSessions 里', (hello.allowSessions ?? []).includes(session), JSON.stringify(hello.allowSessions))
  const list = await plugin.list()
  console.log('该会话是否 live: ' + list.sessions.includes(session))

  const transport = fakeTransport()
  const gateway = createGateway({ plugin, transport, log, config: { ackEmoji: '' } })

  console.log('\n[1] ?status（真插件）')
  await gateway.handleIncoming({ eventId: 'ev-live-status', messageId: 'om-live-status', chatId: CHAT, userId: USER, text: '?status' })
  const status = transport.sent.at(-1)?.text ?? ''
  check('回了自检', /自检/.test(status), JSON.stringify(status.slice(0, 60)))
  check('自检里带真实 pid', status.includes(String(hello.pid)), JSON.stringify(status.match(/pid `\d+`/)?.[0]))

  console.log('\n[2] 发一句真话，等真实 agent 回复')
  const before = transport.sent.length
  await gateway.handleIncoming({
    eventId: 'ev-live-1',
    messageId: 'om-live-1',
    chatId: CHAT,
    userId: USER,
    text: '只回复：gateway-ok',
  })
  const deadline = Date.now() + REPLY_TIMEOUT_MS
  while (Date.now() < deadline && transport.sent.length === before) await wait(1000)
  const reply = transport.sent.at(-1)
  check('收到了回复（不是超时）', transport.sent.length > before, JSON.stringify(reply?.text?.slice(0, 60)))
  check('回复来自真实 agent（含 gateway-ok）', /gateway-ok/i.test(reply?.text ?? ''), JSON.stringify(reply?.text))
  check('回复是线程内 reply', reply?.kind === 'reply' && reply?.messageId === 'om-live-1', JSON.stringify(reply?.kind))

  console.log('\n[3] 去重：同一 eventId 再投一次不重复注入')
  const promptCountBefore = logs.filter((l) => l.includes('prompt ->')).length
  await gateway.handleIncoming({ eventId: 'ev-live-1', messageId: 'om-live-1', chatId: CHAT, userId: USER, text: '只回复：gateway-ok' })
  await wait(300)
  const promptCountAfter = logs.filter((l) => l.includes('prompt ->')).length
  check('没有再次注入', promptCountAfter === promptCountBefore, promptCountBefore + ' -> ' + promptCountAfter)

  plugin.close()
  console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('测试崩溃:', error)
  process.exit(1)
})

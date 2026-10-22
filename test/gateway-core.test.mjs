/**
 * Gateway core tests — no Feishu, no DSH, no network.
 *
 * Run: node test/gateway-core.test.mjs
 *
 * What is covered (each item maps to a way this bridge can silently fail):
 *   - duplicate event delivery (Feishu retries) must not inject twice
 *   - `?status` must answer without running a turn
 *   - a normal message runs a turn and its reply is sent once, in full
 *   - the turn watermark: another client's turn must never be reported as ours
 *   - mid-turn input: while busy, a message becomes `steer`, not a queued turn
 *   - a long reply is split into transport-sized pieces
 *   - a plugin failure produces a visible error reply, never silence
 *   - two chats keep independent state
 */
import { hasOpenFence, createGateway, splitMessage } from '../lib/gateway-core.mjs'
import { normalizeFenceLanguages, buildMarkdownCard } from '../lib/feishu-payload.mjs'

const SESSION = 'session-test-target'
const CHAT = 'oc_chat_a'
const USER = 'ou_user_a'
const CHAT_B = 'oc_chat_b'
const USER_B = 'ou_user_b'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Fake plugin port: records calls and lets the test push events. */
function fakePlugin() {
  const calls = { prompt: [], steer: [], attach: [], cancel: [], setModel: [] }
  const listeners = []
  // Keys the plugin "knows" via its sessionKeys map.
  const knownKeys = new Set(['feishu:' + CHAT + ':' + USER, 'feishu:' + CHAT_B + ':' + USER_B])
  let failNext = null
  return {
    calls,
    fail: (error) => {
      failNext = error
    },
    emit: (event) => {
      for (const fn of listeners) fn(event)
    },
    port: {
      hello: async () => ({
        pid: 111,
        allowSessions: [SESSION],
        sessionKeys: [],
        ipcBound: true,
        ipcClients: 1,
        lastTurns: {},
      }),
      list: async () => ({ sessions: [SESSION] }),
      attach: async (target) => {
        calls.attach.push(target)
        // Mirror the plugin: a key with no sessionKeys entry is an error, unless a
        // sessionId was given explicitly (which is the gateway's fallback path).
        if (target?.key && !knownKeys.has(target.key)) {
          if (!target.sessionId) throw new Error('no sessionKeys entry for key ' + target.key)
          return { sessionId: target.sessionId }
        }
        if (target?.sessionId) return { sessionId: target.sessionId }
        return { sessionId: SESSION }
      },
      prompt: async (args) => {
        if (failNext) {
          const error = failNext
          failNext = null
          throw error
        }
        calls.prompt.push(args)
        return { afterTurn: 10 }
      },
      steer: async (args) => {
        calls.steer.push(args)
        return { injected: true }
      },
      chats: async () => ({ [SESSION]: CHAT }),
      cancel: async (request) => {
        calls.cancel.push(request)
        return { ok: true }
      },
      models: async () => ({
        groups: [{ provider: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] }],
        current: { provider: 'p1', model: 'm1' },
      }),
      setModel: async (request) => {
        calls.setModel.push(request)
        return { ok: true }
      },
      activity: async () => ({
        sessionId: SESSION,
        jobs: [{ kind: 'pwsh', label: 'Start-Sleep -Seconds 60', elapsed: '2m10s', elapsedMs: 130000 }],
        subagents: [{ name: 'subagent', label: '调研回调机制', elapsed: '45s', elapsedMs: 45000 }],
      }),
      onEvent: (fn) => listeners.push(fn),
    },
  }
}

/** Fake transport: records what would have been sent to Feishu. */
function fakeTransport() {
  const sent = []
  const reactions = []
  const cards = []
  const cardUpdates = []
  return {
    sent,
    reactions,
    cards,
    cardUpdates,
    port: {
      sendText: async ({ chatId, text }) => {
        sent.push({ kind: 'send', chatId, text })
      },
      replyMessage: async ({ messageId, text }) => {
        sent.push({ kind: 'reply', messageId, text })
      },
      addReaction: async ({ messageId, emoji }) => {
        reactions.push({ messageId, emoji })
      },
      createCard: async ({ chatId, card }) => {
        cards.push({ chatId, card })
        return 'om_progress_' + cards.length
      },
      updateCard: async ({ messageId, card }) => {
        cardUpdates.push({ messageId, content: card?.body?.elements?.[0]?.content ?? '' })
        return { code: 0 }
      },
    },
  }
}

function makeGateway(overrides = {}) {
  const plugin = fakePlugin()
  const transport = fakeTransport()
  const logs = []
  const gateway = createGateway({
    plugin: plugin.port,
    transport: transport.port,
    log: (...args) => logs.push(args.join(' ')),
    config: overrides,
  })
  return { plugin, transport, logs, gateway }
}

async function main() {
  console.log('\n[1] 去重：飞书重投同一事件不会注入两次')
  {
    const { plugin, gateway } = makeGateway()
    const message = { eventId: 'ev-1', messageId: 'om-1', chatId: CHAT, userId: USER, text: '你好' }
    await gateway.handleIncoming(message)
    await gateway.handleIncoming(message) // Feishu retry
    check('只注入一次', plugin.calls.prompt.length === 1, String(plugin.calls.prompt.length))
    check('注入内容正确', plugin.calls.prompt[0]?.text === '你好', JSON.stringify(plugin.calls.prompt[0]?.text))
  }

  console.log('\n[2] ?status 不跑 turn')
  {
    const { plugin, transport, gateway } = makeGateway()
    await gateway.handleIncoming({ eventId: 'ev-2', messageId: 'om-2', chatId: CHAT, userId: USER, text: '?status' })
    check('没有 prompt', plugin.calls.prompt.length === 0, String(plugin.calls.prompt.length))
    check('回了一段自检', /自检/.test(transport.sent[0]?.text ?? ''), JSON.stringify((transport.sent[0]?.text ?? '').slice(0, 40)))
    check('自检里写了目标会话', new RegExp(SESSION).test(transport.sent[0]?.text ?? ''))
  }

  console.log('\n[3] buffered 模式：一轮结束后整段回复合并成一条')
  {
    const { plugin, transport, gateway } = makeGateway({ deliver: 'buffered' })
    await gateway.handleIncoming({ eventId: 'ev-3', messageId: 'om-3', chatId: CHAT, userId: USER, text: '跑个活' })
    check('prompt 带上了 sessionId', plugin.calls.prompt[0]?.sessionId === SESSION, JSON.stringify(plugin.calls.prompt[0]))
    // 第 11 轮才是我们的（afterTurn=10）
    plugin.emit({ event: 'assistant', sessionId: SESSION, turn: 11, text: '第一段' })
    plugin.emit({ event: 'assistant', sessionId: SESSION, turn: 11, text: '第二段' })
    await wait(10)
    check('turn 还没结束时没有发送', transport.sent.length === 0, String(transport.sent.length))
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 11, reason: 'completed' })
    await wait(10)
    check('只发了一条', transport.sent.length === 1, String(transport.sent.length))
    check('两段合并', transport.sent[0]?.text === '第一段\n\n第二段', JSON.stringify(transport.sent[0]?.text))
    check('是回复到原消息（线程内）', transport.sent[0]?.kind === 'reply' && transport.sent[0]?.messageId === 'om-3', JSON.stringify(transport.sent[0]))
  }

  console.log('\n[3b] live 模式：长任务期间也逐条送达（不用等这一轮结束）')
  {
    const { plugin, transport, gateway } = makeGateway()
    await gateway.handleIncoming({ eventId: 'ev-3b', messageId: 'om-3b', chatId: CHAT, userId: USER, text: '跑个长活' })
    plugin.emit({ event: 'assistant', sessionId: SESSION, turn: 11, text: '第一步好了' })
    await wait(10)
    check('第一条立刻发出', transport.sent.length === 1 && transport.sent[0].text === '第一步好了', JSON.stringify(transport.sent.map((s) => s.text)))
    plugin.emit({ event: 'assistant', sessionId: SESSION, turn: 11, text: '第二步也好了' })
    await wait(10)
    check('第二条也立刻发出', transport.sent.length === 2, String(transport.sent.length))
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 11, reason: 'completed' })
    await wait(10)
    check('turn 结束后不重复发送', transport.sent.length === 2, String(transport.sent.length))
    check('都回复到原消息（线程内）', transport.sent.every((s) => s.kind === 'reply' && s.messageId === 'om-3b'), JSON.stringify(transport.sent.map((s) => s.kind)))
  }
  console.log('\n[4] turn 水位线：别人的 turn 不能被当成本轮的回复')
  {
    const { plugin, transport, gateway } = makeGateway()
    await gateway.handleIncoming({ eventId: 'ev-4', messageId: 'om-4', chatId: CHAT, userId: USER, text: '跑个活' })
    // 桌面那一轮（turn 9 < afterTurn=10）结束：不能触发发送
    plugin.emit({ event: 'assistant', sessionId: SESSION, turn: 9, text: '这是桌面的输出' })
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 9, reason: 'completed' })
    await wait(10)
    check('陈旧 turn 不发送', transport.sent.length === 0, String(transport.sent.length))
    // 我们的第 11 轮
    plugin.emit({ event: 'assistant', sessionId: SESSION, turn: 11, text: '这才是我的' })
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 11, reason: 'completed' })
    await wait(10)
    check('只发我们那一轮', transport.sent.length === 1 && transport.sent[0]?.text === '这才是我的', JSON.stringify(transport.sent))
  }

  console.log('\n[5] 忙时自动 steer（排队式桥接做不到的）')
  {
    const { plugin, transport, gateway } = makeGateway()
    await gateway.handleIncoming({ eventId: 'ev-5a', messageId: 'om-5a', chatId: CHAT, userId: USER, text: '先跑个长任务' })
    // 通过 turn-start 让网关知道"正在跑"
    plugin.emit({ event: 'turn-start', sessionId: SESSION, turn: 11 })
    await wait(5)
    await gateway.handleIncoming({ eventId: 'ev-5b', messageId: 'om-5b', chatId: CHAT, userId: USER, text: '别改了，先停' })
    check('第二条走 steer，不是排队', plugin.calls.steer.length === 1, JSON.stringify(plugin.calls.steer))
    check('steer 内容正确', plugin.calls.steer[0]?.text === '别改了，先停', JSON.stringify(plugin.calls.steer[0]?.text))
    check('只跑了一轮', plugin.calls.prompt.length === 1, String(plugin.calls.prompt.length))
    check('回了"已接收消息…"（不是旧文案）', /已接收消息/.test(transport.sent.at(-1)?.text ?? '') && !/已插入/.test(transport.sent.at(-1)?.text ?? ''), JSON.stringify(transport.sent.at(-1)?.text))
  }

  console.log('\n[6] 前缀 #：忙时排队，不插入当前轮')
  {
    const { plugin, transport, gateway } = makeGateway()
    await gateway.handleIncoming({ eventId: 'ev-6a', messageId: 'om-6a', chatId: CHAT, userId: USER, text: '先跑个长任务' })
    plugin.emit({ event: 'turn-start', sessionId: SESSION, turn: 11 })
    await wait(5)
    await gateway.handleIncoming({ eventId: 'ev-6b', messageId: 'om-6b', chatId: CHAT, userId: USER, text: '#等这轮结束再处理' })
    check('没有 steer（不插队）', plugin.calls.steer.length === 0, JSON.stringify(plugin.calls.steer))
    check('也没有立即开新一轮', plugin.calls.prompt.length === 1, String(plugin.calls.prompt.length))
    check('回复了排队提示', /等当前这一轮结束后发送/.test(transport.sent.at(-1)?.text ?? ''), JSON.stringify(transport.sent.at(-1)?.text))
    // 这一轮结束后，排队的消息才发出
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 11, reason: 'completed' })
    await wait(20)
    check('轮次结束后才发出排队的消息', plugin.calls.prompt.length === 2 && plugin.calls.prompt[1]?.text === '等这轮结束再处理', JSON.stringify(plugin.calls.prompt.map((c) => c.text)))
  }

  console.log('\n[6b] 前缀 #：空闲时也要回执，然后立刻执行')
  {
    const { plugin, transport, gateway } = makeGateway()
    await gateway.handleIncoming({ eventId: 'ev-6c', messageId: 'om-6c', chatId: CHAT, userId: USER, text: '#空闲时发的话' })
    check('先回执（忙闲一致）', /等当前这一轮结束后发送/.test(transport.sent[0]?.text ?? ''), JSON.stringify(transport.sent[0]?.text))
    check('然后立刻开一轮', plugin.calls.prompt.length === 1 && plugin.calls.prompt[0]?.text === '空闲时发的话', JSON.stringify(plugin.calls.prompt.map((c) => c.text)))
    check('没有 steer', plugin.calls.steer.length === 0)
  }

  console.log('\n[7] 长回复分片')
  {
    const parts = splitMessage('a'.repeat(100) + '\n' + 'b'.repeat(100), 60)
    check('切成了多段', parts.length > 1, String(parts.length))
    check('每段都不超限', parts.every((p) => p.length <= 60), JSON.stringify(parts.map((p) => p.length)))
    check('内容没丢', parts.join('').replace(/\n/g, '').length === 200, String(parts.join('').replace(/\n/g, '').length))
  }

  console.log('\n[8] 插件失败时可见，而不是静默')
  {
    const { plugin, transport, gateway } = makeGateway()
    plugin.fail(new Error('session not in allowSessions: x'))
    await gateway.handleIncoming({ eventId: 'ev-8', messageId: 'om-8', chatId: CHAT, userId: USER, text: '会失败' })
    check('回了错误', /桥接失败/.test(transport.sent.at(-1)?.text ?? ''), JSON.stringify(transport.sent.at(-1)?.text))
    check('错误里带原因', /allowSessions/.test(transport.sent.at(-1)?.text ?? ''))
  }

  console.log('\n[9] 两个会话互不干扰（显式允许两个用户：自动认主默认只放一个人）')
  {
    const { plugin, transport, gateway } = makeGateway({ autoPinFirstUser: false, allowUsers: [USER, USER_B], deliver: 'buffered' })
    await gateway.handleIncoming({ eventId: 'ev-9a', messageId: 'om-9a', chatId: CHAT, userId: USER, text: 'A 的问题' })
    await gateway.handleIncoming({ eventId: 'ev-9b', messageId: 'om-9b', chatId: CHAT_B, userId: USER_B, text: 'B 的问题' })
    check('两个都注入了', plugin.calls.prompt.length === 2, String(plugin.calls.prompt.length))
    plugin.emit({ event: 'assistant', sessionId: SESSION, turn: 11, text: '输出' })
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 11, reason: 'completed' })
    await wait(10)
    check('两个会话各自收到一条', transport.sent.filter((s) => s.kind === 'reply').length === 2, JSON.stringify(transport.sent.map((s) => s.kind)))
  }

  console.log('\n[10] 未知聊天 → 落到 defaultSession，并提示怎么 pin')
  {
    const { plugin, logs, gateway } = makeGateway({ defaultSession: 'session-default' })
    await gateway.handleIncoming({ eventId: 'ev-10', messageId: 'om-10', chatId: 'oc_brand_new', userId: 'ou_brand_new', text: '第一次说话' })
    check('prompt 打到了 defaultSession', plugin.calls.prompt.at(-1)?.sessionId === 'session-default', JSON.stringify(plugin.calls.prompt.at(-1)))
    check('日志里给了 pin 的写法', logs.some((l) => /"sessionKeys": \{ "feishu:oc_brand_new:ou_brand_new"/.test(l)), JSON.stringify(logs.filter((l) => l.includes('pin it')).at(-1)))
  }
  {
    const { plugin, transport, gateway } = makeGateway() // 没配 defaultSession
    let threw = false
    try {
      await gateway.handleIncoming({ eventId: 'ev-10b', messageId: 'om-10b', chatId: 'oc_unknown2', userId: 'ou_unknown2', text: 'hi' })
    } catch {
      threw = true
    }
    // attach 会失败（key 没映射），网关必须把它变成一条可见的错误回复，而不是静默。
    check(
      '没配 defaultSession 时给出可见错误（不注入、也不吞掉）',
      threw === false && plugin.calls.prompt.length === 0 && /桥接失败/.test(transport.sent.at(-1)?.text ?? ''),
      JSON.stringify({ prompts: plugin.calls.prompt.length, reply: transport.sent.at(-1)?.text }),
    )
  }

  console.log('\n[11] 首次自动认主：第一条消息的用户成为唯一白名单')
  {
    const { plugin, transport, logs, gateway } = makeGateway()
    await gateway.handleIncoming({ eventId: 'ev-11a', messageId: 'om-11a', chatId: CHAT, userId: USER, text: '我是主人' })
    check('第一条被接受', plugin.calls.prompt.length === 1, String(plugin.calls.prompt.length))
    check('日志里 PINNED 了 open_id', logs.some((l) => /PINNED first sender/.test(l)), JSON.stringify(logs.find((l) => l.includes('PINNED'))))
    await gateway.handleIncoming({ eventId: 'ev-11b', messageId: 'om-11b', chatId: 'oc_other', userId: 'ou_stranger', text: '我也想用' })
    check('陌生人被拒（没有注入）', plugin.calls.prompt.length === 1, String(plugin.calls.prompt.length))
    check('陌生人没收到任何回复', transport.sent.filter((s) => s.chatId === 'oc_other').length === 0, String(transport.sent.length))
  }

  console.log('\n[12] 生命周期表情：Get（收到）→ OnIt（处理中）→ Done（完成）')
  {
    const { plugin, transport, gateway } = makeGateway()
    await gateway.handleIncoming({ eventId: 'ev-12', messageId: 'om-12', chatId: CHAT, userId: USER, text: '跑个活' })
    await wait(10)
    check('收到时打了 Get', transport.reactions.some((r) => r.emoji === 'Get' && r.messageId === 'om-12'), JSON.stringify(transport.reactions))
    check('受理后打了 OnIt', transport.reactions.some((r) => r.emoji === 'OnIt'), JSON.stringify(transport.reactions))
    plugin.emit({ event: 'assistant', sessionId: SESSION, turn: 11, text: '好了' })
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 11, reason: 'completed' })
    await wait(10)
    check('回复送达后打了 Done', transport.reactions.some((r) => r.emoji === 'Done'), JSON.stringify(transport.reactions))
    check('表情的 messageId 指向用户那条', transport.reactions.every((r) => r.messageId === 'om-12'), JSON.stringify(transport.reactions.map((r) => r.messageId)))
  }

  console.log('\n[13] markdown 不能原样露出符号（飞书纯文本不渲染）')
  {
    const { plugin, transport, gateway } = makeGateway()
    await gateway.handleIncoming({ eventId: 'ev-13', messageId: 'om-13', chatId: CHAT, userId: USER, text: '给我带格式的' })
    plugin.emit({
      event: 'assistant',
      sessionId: SESSION,
      turn: 11,
      text: '## 结论\n\n**重点**：用 `pwsh`\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    })
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 11, reason: 'completed' })
    await wait(10)
    const out = transport.sent.at(-1)?.text ?? ''
    check('没有井号标题', !out.includes('#'), JSON.stringify(out))
    check('没有星号加粗', !out.includes('**'), JSON.stringify(out))
    check('没有反引号', !out.includes('`'), JSON.stringify(out))
    check('没有表格竖线', !out.includes('|'), JSON.stringify(out))
    check('文字内容都还在', out.includes('结论') && out.includes('重点') && out.includes('pwsh') && out.includes('1') && out.includes('2'), JSON.stringify(out))
  }
  console.log('\n[14] ?status 报告正在运行的后台任务与子 agent')
  {
    const { transport, gateway } = makeGateway()
    await gateway.handleIncoming({ eventId: 'ev-14', messageId: 'om-14', chatId: CHAT, userId: USER, text: '?status' })
    const text = transport.sent.at(-1)?.text ?? ''
    check('列出后台任务', /正在运行的后台任务（1）/.test(text), JSON.stringify(text.slice(0, 120)))
    check('带任务内容', /Start-Sleep -Seconds 60/.test(text), '')
    check('带已运行时长', /已运行 2m10s/.test(text), '')
    check('列出子 agent', /正在运行的子 agent（1）/.test(text) && /调研回调机制/.test(text), '')
    check('子 agent 带时长', /已运行 45s/.test(text), '')
  }
  console.log('\n[15] 斜杠指令：/status /help /stop /model')
  {
    const { plugin, transport, gateway } = makeGateway()
    const send = (text) => gateway.handleIncoming({ eventId: 'ev-cmd-' + Math.random(), messageId: 'om-cmd', chatId: CHAT, userId: USER, text })
    const last = () => transport.sent.at(-1)?.text ?? ''

    await send('/help')
    check('/help 列出 /stop', /\/stop/.test(last()) && /\/model/.test(last()), JSON.stringify(last().slice(0, 80)))

    await send('/status')
    check('/status 回自检', /自检/.test(last()), JSON.stringify(last().slice(0, 60)))

    await send('?status')
    check('?status 旧写法仍然可用', /自检/.test(last()), JSON.stringify(last().slice(0, 60)))

    // 空闲时 /stop
    await send('/stop')
    check('空闲 /stop 提示无可停轮次', /没有在跑的轮次/.test(last()), JSON.stringify(last()))

    // 忙碌时 /stop：要真的调用 cancel
    plugin.emit({ event: 'turn-start', sessionId: SESSION, turn: 7 })
    await wait(5)
    await send('/stop')
    check('忙时 /stop 调用 cancel', plugin.calls.cancel.length === 1, JSON.stringify(plugin.calls.cancel))
    check('忙时 /stop 回复已停止', /已停止/.test(last()), JSON.stringify(last()))

    // /stop 之后这一轮的残余输出不再发
    const before = transport.sent.length
    plugin.emit({ event: 'assistant', sessionId: SESSION, turn: 7, text: '这段不该发出去' })
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 7, reason: 'cancelled' })
    await wait(10)
    check('停止后残余输出被丢弃', transport.sent.length === before, JSON.stringify(transport.sent.slice(before).map((s) => s.text)))

    // /model 列表
    await send('/model')
    check('/model 列出编号与当前', /1\)/.test(last()) && /2\)/.test(last()) && /当前/.test(last()), JSON.stringify(last().slice(0, 120)))

    // /model 2 切换
    await send('/model 2')
    check('/model 2 调用 setModel', plugin.calls.setModel.length === 1 && plugin.calls.setModel[0].model === 'm2', JSON.stringify(plugin.calls.setModel))
    check('/model 切换后说明下一轮生效', /下一轮生效/.test(last()), JSON.stringify(last()))

    // /model 按 id
    await send('/model p1/m1')
    check('/model provider/model 也可用', plugin.calls.setModel.length === 2 && plugin.calls.setModel[1].model === 'm1', JSON.stringify(plugin.calls.setModel.map((c) => c.model)))

    // 非法编号
    await send('/model 99')
    check('非法编号给出提示', /编号超出范围/.test(last()), JSON.stringify(last()))

    // 未知斜杠指令必须当普通文本
    const promptsBefore = plugin.calls.prompt.length
    await send('/etc/hosts')
    check('未知 /xxx 当普通文本发给 agent', plugin.calls.prompt.length === promptsBefore + 1 && plugin.calls.prompt.at(-1).text === '/etc/hosts', JSON.stringify(plugin.calls.prompt.at(-1)))
  }

    console.log('\n[16] 代码块：语言别名归一化 + 分片不破坏围栏')
  {
    const md = ['```js', 'const a = 1', '```', '', '```ts', 'let b = 2', '```', '', '```', 'plain', '```'].join('\n')
    const normalized = normalizeFenceLanguages(md)
    check('js → javascript', normalized.includes('```javascript'), JSON.stringify(normalized.split('\n')[0]))
    check('ts → typescript', normalized.includes('```typescript'), JSON.stringify(normalized.split('\n')[5]))
    check('无语言标记保持无标记', normalized.includes('\n```\nplain'), JSON.stringify(normalized.split('\n').slice(6, 9)))
    check('卡片里用的是归一化后的文本', buildMarkdownCard(md).body.elements[0].content.includes('```javascript'))

    // 分片：长代码块被切开后，每段围栏必须闭合
    const body = '```js\n' + Array.from({ length: 40 }, (_, i) => 'const v' + i + ' = ' + i).join('\n') + '\n```'
    const chunks = splitMessage(body, 200)
    check('长代码块被切成多片', chunks.length > 1, String(chunks.length))
    check('每一片围栏都闭合', chunks.every((chunk) => !hasOpenFence(chunk)), JSON.stringify(chunks.map((c) => hasOpenFence(c))))
    check('续接片重新打开代码块', chunks.slice(1).every((chunk) => chunk.startsWith('```')), JSON.stringify(chunks.map((c) => c.slice(0, 8))))
    check('普通文本分片不受影响', splitMessage('a\nb\nc', 2).length >= 1, JSON.stringify(splitMessage('a\nb\nc', 2)))
  }

  console.log('\n[17] 进度卡片接线：工具调用 → 建卡 → 更新 → 完成态')
  {
    const { plugin, transport, gateway } = makeGateway()
    await gateway.handleIncoming({ eventId: 'ev-prog-1', messageId: 'om-prog', chatId: CHAT, userId: USER, text: '跑个长任务' })
    await wait(5)

    // 轮次开始（插件会把 turn-start 转发过来）
    plugin.emit({ event: 'turn-start', sessionId: SESSION, turn: 500 })
    await wait(5)
    check('turn-start 只建状态、还没建卡', transport.cards.length === 0, String(transport.cards.length))

    plugin.emit({ event: 'tool-call', sessionId: SESSION, turn: 500, callId: 'call_1', name: 'pwsh', arguments: JSON.stringify({ command: 'Start-Sleep -Seconds 60' }) })
    await wait(30)
    check('工具调用后立刻建卡', transport.cards.length === 1, String(transport.cards.length))
    const first = transport.cards[0]?.card?.body?.elements?.[0]?.content ?? ''
    check('卡片里有工具名', first.includes('pwsh'), JSON.stringify(first.split('\n').slice(2, 4)))
    check('卡片里标"进行中"', first.includes('进行中'), JSON.stringify(first.split('\n').slice(2, 4)))
    check('卡片头部有轮次', /第 500 轮/.test(first), first.split('\n')[0])

    // 结果回来
    plugin.emit({ event: 'tool-result', sessionId: SESSION, turn: 500, callId: 'call_1' })
    await wait(1600)
    const updated = transport.cardUpdates.at(-1)
    check('结果回来后原地更新', transport.cardUpdates.length >= 1 && updated?.messageId === 'om_progress_1', JSON.stringify(transport.cardUpdates.map((u) => u.messageId)))
    check('更新后不再标"进行中"', !String(updated?.content).includes('进行中'), JSON.stringify(String(updated?.content).split('\n').slice(2, 4)))

    // 轮次结束
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 500, reason: 'done' })
    await wait(30)
    const final = transport.cardUpdates.at(-1)
    check('结束后卡片变完成态', /✅ 完成/.test(String(final?.content)), JSON.stringify(String(final?.content).split('\n')[0]))
    check('没有重复建卡', transport.cards.length === 1, String(transport.cards.length))
  }

  console.log('\n[18] 进度卡片不影响正式回复')
  {
    const { plugin, transport, gateway } = makeGateway()
    await gateway.handleIncoming({ eventId: 'ev-prog-2', messageId: 'om-prog2', chatId: CHAT, userId: USER, text: '跑' })
    await wait(5)
    plugin.emit({ event: 'turn-start', sessionId: SESSION, turn: 4 })
    plugin.emit({ event: 'tool-call', sessionId: SESSION, turn: 500, callId: 'c', name: 'pwsh', arguments: '{}' })
    await wait(30)
    plugin.emit({ event: 'assistant', sessionId: SESSION, turn: 500, text: '正式回复内容' })
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 4 })
    await wait(30)
    const replies = transport.sent.filter((item) => String(item.text ?? '').includes('正式回复内容'))
    check('正式回复照常发出', replies.length === 1, JSON.stringify(transport.sent.map((s) => s.text)))
  }

  console.log('\n[19] 桌面端发起的轮次也要推进度卡（同一会话）')
  {
    const { plugin, transport } = makeGateway()
    // 不调用 handleIncoming：模拟桌面端发起的轮次（state.inFlight 一直是 false）
    plugin.emit({ event: 'turn-start', sessionId: SESSION, turn: 600 })
    await wait(5)
    plugin.emit({ event: 'tool-call', sessionId: SESSION, turn: 600, callId: 'desk1', name: 'pwsh', description: 'Probe a four second 1080p video generation' })
    await wait(30)
    check('桌面端轮次也建卡', transport.cards.length === 1, String(transport.cards.length))
    const content = transport.cards[0]?.card?.body?.elements?.[0]?.content ?? ''
    check('卡片显示模型写的人话描述', content.includes('Probe a four second 1080p'), JSON.stringify(content.split('\n').slice(2, 4)))
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 600 })
    await wait(30)
    check('桌面端轮次结束也收尾', /✅ 完成/.test(String(transport.cardUpdates.at(-1)?.content)), JSON.stringify(String(transport.cardUpdates.at(-1)?.content).split('\n')[0]))
  }

  console.log('\n[19b] 关掉 progressAllTurns 就只管飞书发起的轮次')
  {
    const { plugin, transport } = makeGateway({ progressAllTurns: false })
    plugin.emit({ event: 'turn-start', sessionId: SESSION, turn: 601 })
    plugin.emit({ event: 'tool-call', sessionId: SESSION, turn: 601, callId: 'x', name: 'pwsh', arguments: '{}' })
    await wait(30)
    check('不建卡', transport.cards.length === 0, String(transport.cards.length))
  }

  
  console.log('\n[20] /progress on|off 开关')
  {
    const saved = []
    const { plugin, transport, gateway } = makeGateway({ saveProgressPrefs: (prefs) => saved.push({ ...prefs }) })
    const send = (text) => gateway.handleIncoming({ eventId: 'ev-tgl-' + Math.random(), messageId: 'om-tgl', chatId: CHAT, userId: USER, text })
    const last = () => transport.sent.at(-1)?.text ?? ''

    await send('/progress off')
    check('/progress off 回执', /已关闭/.test(last()), JSON.stringify(last()))
    check('off 落盘', saved.at(-1)?.[CHAT] === false, JSON.stringify(saved.at(-1)))

    // 关掉后跑一轮带工具调用的任务：不应建卡
    await send('跑个任务')
    await wait(5)
    plugin.emit({ event: 'turn-start', sessionId: SESSION, turn: 700 })
    plugin.emit({ event: 'tool-call', sessionId: SESSION, turn: 700, callId: 'off1', name: 'pwsh', description: 'should not appear' })
    await wait(40)
    check('off 后不建卡', transport.cards.length === 0, String(transport.cards.length))
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 700 })
    await wait(20)

    await send('/progress on')
    check('/progress on 回执', /已开启/.test(last()), JSON.stringify(last()))
    check('on 落盘', saved.at(-1)?.[CHAT] === true, JSON.stringify(saved.at(-1)))

    await send('再跑一个')
    await wait(5)
    plugin.emit({ event: 'turn-start', sessionId: SESSION, turn: 701 })
    plugin.emit({ event: 'tool-call', sessionId: SESSION, turn: 701, callId: 'on1', name: 'pwsh', description: 'visible now' })
    await wait(40)
    check('on 后恢复建卡', transport.cards.length === 1, String(transport.cards.length))
    check('卡片内容正确', String(transport.cards[0]?.card?.body?.elements?.[0]?.content).includes('visible now'))

    await send('/progress 瞎写')
    check('非法参数给用法', /用法/.test(last()), JSON.stringify(last()))

    await send('/progress')
    check('无参数拉取进度（有在跑的任务）', /完整事件|没有进行中/.test(last()), JSON.stringify(last().slice(0, 60)))
  }

  console.log('\n[21] 开关即时生效：进行中的这一轮也要响应')
  {
    const { plugin, transport, gateway } = makeGateway()
    const send = (text) => gateway.handleIncoming({ eventId: 'ev-live-' + Math.random(), messageId: 'om-live', chatId: CHAT, userId: USER, text })
    const last = () => transport.sent.at(-1)?.text ?? ''

    await send('/progress off')
    await send('跑')
    await wait(5)
    plugin.emit({ event: 'turn-start', sessionId: SESSION, turn: 800 })
    plugin.emit({ event: 'tool-call', sessionId: SESSION, turn: 800, callId: 'a', name: 'pwsh', description: 'first tool' })
    await wait(40)
    check('off 时这一轮不建卡', transport.cards.length === 0, String(transport.cards.length))

    // 轮次还在跑的时候打开：必须立刻补建
    await send('/progress on')
    await wait(40)
    check('on 后立刻补建卡片', transport.cards.length === 1, String(transport.cards.length))
    check('补建卡片带上轮次号', /第 800 轮/.test(String(transport.cards[0]?.card?.body?.elements?.[0]?.content)), String(transport.cards[0]?.card?.body?.elements?.[0]?.content).split('\n')[0])

    // 之后的新工具调用继续更新
    plugin.emit({ event: 'tool-call', sessionId: SESSION, turn: 800, callId: 'b', name: 'pwsh', description: 'second tool' })
    await wait(1700)
    check('后续调用继续滚动', transport.cardUpdates.length >= 1 && String(transport.cardUpdates.at(-1)?.content).includes('second tool'), JSON.stringify(String(transport.cardUpdates.at(-1)?.content).split('\n').slice(2, 4)))

    // 关掉：收尾并停止
    await send('/progress off')
    await wait(40)
    check('关闭时卡片收尾为完成态', /✅ 完成/.test(String(transport.cardUpdates.at(-1)?.content)), JSON.stringify(String(transport.cardUpdates.at(-1)?.content).split('\n')[0]))
    const updatesAfterOff = transport.cardUpdates.length
    plugin.emit({ event: 'tool-call', sessionId: SESSION, turn: 800, callId: 'c', name: 'pwsh', description: 'third tool' })
    await wait(1700)
    check('关闭后不再更新', transport.cardUpdates.length === updatesAfterOff, String(transport.cardUpdates.length - updatesAfterOff))
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 800 })
  }

  console.log('\n[22] 语言：英文输出')
  {
    const { plugin, transport, gateway } = makeGateway({ language: 'en' })
    const send = (text) => gateway.handleIncoming({ eventId: 'ev-en-' + Math.random(), messageId: 'om-en', chatId: CHAT, userId: USER, text })
    const last = () => transport.sent.at(-1)?.text ?? ''

    await send('/help')
    check('help 是英文', /Commands/.test(last()) && /stop the running turn/.test(last()), JSON.stringify(last().slice(0, 70)))

    await send('/status')
    check('status 是英文', /self-check/.test(last()) && /running a turn/.test(last()), JSON.stringify(last().slice(0, 80)))

    await send('/progress')
    check('progress 空态是英文', /Nothing is running/.test(last()), JSON.stringify(last()))

    await send('/progress on')
    check('开关提示是英文', /Progress messages on/.test(last()), JSON.stringify(last()))

    // 进度卡也要英文
    await send('跑')
    await wait(5)
    plugin.emit({ event: 'turn-start', sessionId: SESSION, turn: 900 })
    plugin.emit({ event: 'tool-call', sessionId: SESSION, turn: 900, callId: 'e1', name: 'pwsh', description: 'render the clip' })
    await wait(40)
    const card = String(transport.cards[0]?.card?.body?.elements?.[0]?.content ?? '')
    check('进度卡是英文', /working \(turn 900/.test(card) && /running/.test(card), JSON.stringify(card.split('\n').slice(0, 3)))
    plugin.emit({ event: 'turn-end', sessionId: SESSION, turn: 900 })
    await wait(30)
    check('完成态是英文', /✅ done \(turn 900/.test(String(transport.cardUpdates.at(-1)?.content)), JSON.stringify(String(transport.cardUpdates.at(-1)?.content).split('\n')[0]))
  }

  console.log('\n[23] 语言：默认中文，非法值回落中文')
  {
    const { plugin, transport, gateway } = makeGateway()
    await gateway.handleIncoming({ eventId: 'ev-zh-1', messageId: 'om-zh', chatId: CHAT, userId: USER, text: '/help' })
    check('默认中文', /可用指令/.test(transport.sent.at(-1)?.text ?? ''), JSON.stringify(String(transport.sent.at(-1)?.text).slice(0, 40)))

    const other = makeGateway({ language: 'fr' })
    await other.gateway.handleIncoming({ eventId: 'ev-fr-1', messageId: 'om-fr', chatId: CHAT, userId: USER, text: '/help' })
    check('未知语言回落中文', /可用指令/.test(other.transport.sent.at(-1)?.text ?? ''), JSON.stringify(String(other.transport.sent.at(-1)?.text).slice(0, 40)))
  }

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
  process.exit(failures === 0 ? 0 : 1)


}

main().catch((error) => {
  console.error('测试崩溃:', error)
  process.exit(1)
})

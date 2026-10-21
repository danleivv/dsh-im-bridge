/**
 * Live self-test of the real plugin inside the running DSH Host, over its IPC.
 * Read-mostly: hello / list / attach, then ONE prompt into the pilot session.
 *
 * Run: node tools/ipc-selftest.mjs [--no-prompt]
 */
import { connect } from 'node:net'

const PORT = Number(process.env.DSH_BRIDGE_PORT || 9811)
const KEY = process.env.DSH_BRIDGE_KEY ?? ''
const TEXT = '【桥接自检】这条消息由 cc-dsh-bridge 插件通过本地 IPC 注入。请只回复：bridge-ok'
const sendPrompt = !process.argv.includes('--no-prompt')

const socket = connect(PORT, '127.0.0.1')
let buffer = ''
let nextId = 1
const pending = new Map()
const events = []

socket.setEncoding('utf8')
socket.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const parsed = JSON.parse(line)
    if (parsed.event) {
      events.push(parsed)
      console.log('  ← 事件: ' + JSON.stringify(parsed).slice(0, 220))
      continue
    }
    const waiter = pending.get(parsed.id)
    if (waiter) {
      pending.delete(parsed.id)
      waiter(parsed)
    }
  }
})

function call(op, extra = {}, timeoutMs = 20000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('超时: ' + op))
    }, timeoutMs)
    pending.set(id, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
    socket.write(JSON.stringify({ id, op, ...extra }) + '\n')
  })
}

const ready = new Promise((resolve, reject) => {
  socket.on('connect', resolve)
  socket.on('error', reject)
})

try {
  await ready
  console.log('已连上插件 IPC 127.0.0.1:' + PORT + '\n')

  console.log('[1] hello —— 看有效白名单（这个值来自热旋钮，证明热读生效）')
  const hello = await call('hello')
  console.log('  ok=' + hello.ok + ' pid=' + hello.pid)
  console.log('  allowSessions = ' + JSON.stringify(hello.allowSessions))
  console.log('  sessionKeys   = ' + JSON.stringify(hello.sessionKeys))

  console.log('\n[2] list —— 当前 live 的会话')
  const list = await call('list')
  console.log('  sessions = ' + JSON.stringify(list.sessions))

  console.log('\n[3] attach —— 按飞书 session key 绑定')
  const attached = await call('attach', { key: KEY })
  console.log('  ' + JSON.stringify(attached))

  if (hello.allowSessions?.length !== 1) {
    console.log('\n⚠ 白名单不是恰好 1 个，停止后续注入以免误伤')
    process.exit(1)
  }
  if (sendPrompt) {
    console.log('\n[4] prompt —— 真正注入一条自检消息')
    const ack = await call('prompt', { key: KEY, text: TEXT })
    console.log('  ' + JSON.stringify(ack))
    console.log('  等待 agent 回复（最多 150 秒）...')
    const deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000))
      if (events.some((e) => e.event === 'turn-end')) break
    }
  }
} catch (error) {
  console.error('自检失败: ' + (error?.message ?? error))
} finally {
  console.log('\n=== 汇总 ===')
  const assistant = events.filter((e) => e.event === 'assistant')
  const turns = events.filter((e) => e.event === 'turn-end')
  console.log('  assistant 事件 ' + assistant.length + ' 条')
  for (const a of assistant) console.log('    正文: ' + JSON.stringify(String(a.text).slice(0, 300)))
  console.log('  turn-end 事件 ' + turns.length + ' 条: ' + JSON.stringify(turns.map((t) => t.reason)))
  console.log('  tool 事件 ' + events.filter((e) => e.event === 'tool').length + ' 条')
  socket.end()
  process.exit(0)
}

#!/usr/bin/env node
/**
 * steer-probe — does agent.steer() actually land INSIDE a running turn?
 *
 * The whole "own the Feishu side" plan rests on this: a queueing bridge can only queue,
 * and we claim `steer()` inserts into the running turn instead. That claim has
 * never been proven against a live turn (last time the steer arrived after the
 * turn had already ended, which proves nothing).
 *
 * This probe:
 *   1. starts a multi-step turn in the session (three slow shell steps),
 *   2. once a step is observed running, injects a steer,
 *   3. prints a timestamped timeline of turn/step/tool/assistant events,
 *   4. reports whether the steer's output appeared WITHIN that same turn.
 *
 * Reads nothing, writes nothing except the two injected messages.
 *
 * Usage: node tools/steer-probe.mjs [--session <id>]
 */
import { createPluginIpc } from '../lib/plugin-ipc.mjs'

const args = process.argv.slice(2)
const sessionArgIndex = args.indexOf('--session')
const CHAT = 'oc_gateway_test'
const USER = 'ou_gateway_test'

const start = Date.now()
const elapsed = () => String(Date.now() - start).padStart(6) + 'ms'
const log = (...parts) => console.log('[' + elapsed() + '] ' + parts.join(' '))

const plugin = createPluginIpc({ port: 9811, log: (m) => console.log('  [ipc] ' + m) })
await plugin.whenConnected()

const hello = await plugin.hello()
let session = sessionArgIndex >= 0 ? args[sessionArgIndex + 1] : null
if (!session) {
  const attached = await plugin.attach({ key: 'feishu:' + CHAT + ':' + USER })
  session = attached.sessionId
}
log('目标会话 ' + session)
log('白名单 ' + JSON.stringify(hello.allowSessions))

const timeline = []
plugin.onEvent((event) => {
  if (event.sessionId !== session) return
  const entry = { at: Date.now() - start, kind: event.event, turn: event.turn, text: event.text ?? event.name ?? '' }
  timeline.push(entry)
  const label =
    event.event === 'assistant'
      ? 'assistant(turn ' + event.turn + '): ' + JSON.stringify(String(event.text).slice(0, 60))
      : event.event === 'tool-call'
        ? 'tool-call(turn ' + event.turn + '): ' + event.name
        : event.event + (event.turn !== undefined ? '(turn ' + event.turn + ')' : '')
  log(label)
})

let turnEnded = null
plugin.onEvent((event) => {
  if (event.sessionId === session && event.event === 'turn-end') turnEnded = { at: Date.now(), turn: event.turn, reason: event.reason }
})

// A task with several slow steps, so there is a real window to steer into.
const TASK =
  '请用 pwsh 依次执行下面三步，每步单独一次工具调用，并把每次的输出原样带回来：' +
  '(1) Start-Sleep -Seconds 8; "step-1 done"; ' +
  '(2) Start-Sleep -Seconds 8; "step-2 done"; ' +
  '(3) Start-Sleep -Seconds 8; "step-3 done"。三步都做完后，用一句话总结。'

log('注入任务（约 24 秒的三步任务）')
let ack = await plugin.prompt({ sessionId: session, text: TASK })
log('任务已接受，afterTurn=' + ack.afterTurn)

// Wait for the first tool call: that proves a step is actually running.
const waitForTool = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (timeline.some((t) => t.kind === 'tool-call')) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}
const sawTool = await waitForTool(60000)
log(sawTool ? '观察到第一个工具调用 → 现在插入 steer' : '⚠ 60 秒内没看到工具调用，仍然插入 steer')

const steerText = '【插入测试】先不要继续后面的步骤，直接告诉我：你刚才执行到第几步、工具名是什么。'
const steerAt = Date.now() - start
log('插入 steer: ' + steerText)
try {
  const result = await plugin.steer({ sessionId: session, text: steerText })
  log('steer 返回: ' + JSON.stringify(result))
} catch (error) {
  log('steer 失败: ' + (error?.message ?? error))
}

// Wait for the turn to end (steer admitted mid-turn keeps the same turn; a queued
// message would instead start a NEW turn after this one ends).
const deadline = Date.now() + 180000
while (!turnEnded && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500))

if (!turnEnded) {
  log('⚠ 180 秒内没等到 turn-end')
} else {
  log('turn-end(turn ' + turnEnded.turn + ') reason=' + JSON.stringify(turnEnded.reason) + ' 距 steer ' + Math.round((turnEnded.at - start - steerAt) / 1000) + 's')
}

// Anything the agent said AFTER the steer, inside the same turn, is the proof.
const afterSteer = timeline.filter((t) => t.at >= steerAt)
log('---- steer 之后的事件 ----')
for (const item of afterSteer) log('  ' + item.kind + (item.turn !== undefined ? '(turn ' + item.turn + ')' : '') + ' ' + JSON.stringify(String(item.text).slice(0, 70)))

const sameTurnAssistant = afterSteer.filter((t) => t.kind === 'assistant')
const verdict =
  sameTurnAssistant.length > 0
    ? '✅ steer 之后同一轮内出现了 assistant 输出 → 插入生效（不是排队）'
    : '❌ steer 之后没有任何同一轮的 assistant 输出 → 可能被推迟到下一轮（或工具还没跑完）'
log('结论: ' + verdict)

plugin.close()
process.exit(0)

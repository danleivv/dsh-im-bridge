/**
 * Dry run for cc-dsh-bridge — no DSH required.
 *
 * Covers, with a fake `ctx`:
 *   1. downlink   : an outbox job file becomes a real injected user message
 *   2. guard      : a session outside `allowSessions` is refused
 *   3. uplink     : committed session events land in inbox/<sessionId>.jsonl
 *   4. ipc        : the shim protocol — hello / attach / prompt (incl. token + allowlist)
 *   5. ipc fan-out: assistant + turn-end events reach an attached client, others do not
 *   6. cancel     : the shim can abort the active turn
 *   7. status     : status.json reflects the live wiring
 *   8. defaults   : with default config the plugin subscribes to nothing and injects nothing
 *
 * Run: node test/dry-run.mjs
 */
import { createServer as createNetServer, connect } from 'node:net'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const ROOT = 'D:/cc-dsh-bridge/.test-root'
const SESSION = 'session-fake-live'
const OTHER = 'session-fake-other'
/** Allowlisted but NOT live: forces the plugin down its resume() path. */
const RESUMABLE = 'session-fake-resumable'
const KEY = 'feishu:oc_test_chat:ou_test_user'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createNetServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** Fake ctx: a live agent registry plus an event bus we can fire by hand. */
function fakeCtx(options = {}) {
  const services = options.services ?? {}
  const injected = []
  const listeners = new Map()
  const handle = {
    session: { id: SESSION, header: { id: SESSION } },
    followup: async (message) => injected.push(message),
    // mid-turn input: must be a DIFFERENT method from followup, and the test
    // asserts the plugin actually picked it (not the queued path).
    steer: async (message) => injected.push({ ...message, steer: true }),
    cancel: async () => injected.push({ cancelled: true }),
  }
  const other = {
    session: { id: OTHER, header: { id: OTHER } },
    followup: async (message) => injected.push({ ...message, to: OTHER }),
    steer: async (message) => injected.push({ ...message, to: OTHER, steer: true }),
    cancel: async () => injected.push({ cancelled: true, to: OTHER }),
  }
  const resumable = {
    session: { id: RESUMABLE, header: { id: RESUMABLE } },
    followup: async (message) => injected.push({ ...message, to: RESUMABLE }),
    steer: async (message) => injected.push({ ...message, to: RESUMABLE, steer: true }),
    cancel: async () => injected.push({ cancelled: true, to: RESUMABLE }),
  }
  const resumeCalls = []
  const disposed = []
  return {
    injected,
    resumeCalls,
    disposed,
    emit: (id, event) => {
      for (const fn of listeners.get('session/event') ?? []) fn({ header: { id } }, event)
    },
    ctx: {
      agents: {
        list: () => [handle],
        get: (id) => (id === SESSION ? handle : id === OTHER ? other : undefined),
        // Mirrors dsh-agent-loop.resumeWith(): it reads `resumeSessionId` and
        // nothing else. A call carrying only `sessionId` therefore resolves to
        // undefined here, exactly like the real persistence crash did.
        // The returned object is an AgentHandle: it exposes both `agent` and the
        // `dispose` capability the plugin must keep.
        resume: async (options) => {
          resumeCalls.push(options)
          const wrap = (agent, id) => ({ agent, dispose: async () => disposed.push(id) })
          if (options?.resumeSessionId === SESSION) return wrap(handle, SESSION)
          if (options?.resumeSessionId === RESUMABLE) return wrap(resumable, RESUMABLE)
          return undefined
        },
      },
      // Services the plugin resolves lazily. Default: none (no composition), which
      // is what makes the plugin fall back to the "refuse resume" path.
      get: (name) => services[name],
      on: (name, fn) => {
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name).add(fn)
      },
      off: (name) => listeners.delete(name),
      effect: (fn) => fn(),
    },
  }
}

/** Minimal newline-JSON client for the plugin's IPC. */
function ipcClient(port) {
  const socket = connect(port, '127.0.0.1')
  let buffer = ''
  const inbox = []
  const waiters = []
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const parsed = JSON.parse(line)
      const waiter = waiters.shift()
      if (waiter) waiter(parsed)
      else inbox.push(parsed)
    }
  })
  const next = (timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      if (inbox.length) return resolve(inbox.shift())
      const timer = setTimeout(() => reject(new Error('ipc timeout')), timeoutMs)
      waiters.push((value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
  return {
    ready: new Promise((resolve, reject) => {
      socket.on('connect', resolve)
      socket.on('error', reject)
    }),
    send: (obj) => socket.write(JSON.stringify(obj) + '\n'),
    next,
    /** skip past pushed events until a reply carrying this id shows up */
    async reply(id, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const value = await next(Math.max(50, deadline - Date.now()))
        if (value.id === id) return value
      }
    },
    close: () => socket.end(),
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, 'outbox'), { recursive: true })

  const port = await freePort()
  const fake = fakeCtx()
  apply(fake.ctx, {
    root: ROOT,
    allowSessions: [SESSION, RESUMABLE],
    captureReplies: true,
    sessionKeys: { [KEY]: SESSION },
    // A resumed agent MUST be given a route; without one the plugin now refuses
    // instead of creating an agent that fails every turn with "{{model}}".
    agentOptions: { provider: 'test-provider', model: 'test-model' },
    // Resuming is opt-in: a resumed agent ends up with an incomplete tool set
    // (measured: 2 tools instead of 32), so the default is to refuse.
    allowResume: true,
    ipc: { enabled: true, port, token: 'test-token' },
  })
  await wait(250)

  console.log('\n[1] 下行：outbox 作业 -> 注入')
  writeFileSync(join(ROOT, 'outbox', 'job-1.json'), JSON.stringify({ sessionId: SESSION, text: '来自 outbox 的消息' }))
  await wait(1500)
  const first = fake.injected[0]
  check('注入了 1 条', fake.injected.length === 1, String(fake.injected.length))
  check('source.kind === "user"', first?.source?.kind === 'user', JSON.stringify(first?.source))
  // Missing either of these poisons the session: DSH stores the payload verbatim
  // and never fills them in, so buildPayload() has to.
  check('带 role: "user"', first?.role === 'user', JSON.stringify(first?.role))
  check('带唯一 id', typeof first?.id === 'string' && first.id.length >= 8, String(first?.id))
  check('source 带 rpcId', typeof first?.source?.rpcId === 'string', JSON.stringify(first?.source?.rpcId))
  check('正文正确', first?.content?.[0]?.text === '来自 outbox 的消息')
  check('作业被移入 done/', existsSync(join(ROOT, 'done', 'job-1.json')))

  console.log('\n[2] 守卫：不在 allowSessions 的会话被拒')
  writeFileSync(join(ROOT, 'outbox', 'job-2.json'), JSON.stringify({ sessionId: OTHER, text: '不该被注入' }))
  await wait(1500)
  check('没有增加注入', fake.injected.length === 1, String(fake.injected.length))
  check('作业被移入 failed/', existsSync(join(ROOT, 'failed', 'job-2.json')))

  console.log('\n[3] 上行：会话事件 -> inbox 文件')
  fake.emit(SESSION, {
    type: 'assistant/message',
    data: {
      turn: 3,
      message: {
        id: 'msg-1',
        content: [
          { type: 'reasoning', text: '思考中' },
          { type: 'text', text: '你好，我是回复正文。' },
        ],
      },
    },
  })
  fake.emit(SESSION, { type: 'turn/end', data: { turn: 3, reason: 'completed' } })
  await wait(200)
  const inboxFile = join(ROOT, 'inbox', SESSION + '.jsonl')
  const lines = existsSync(inboxFile)
    ? readFileSync(inboxFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : []
  check('写入了 2 条', lines.length === 2, String(lines.length))
  check('只取 text 区块、跳过 reasoning', lines[0]?.text === '你好，我是回复正文。', JSON.stringify(lines[0]?.text))
  check('记录 turn/end', lines[1]?.kind === 'turn/end' && lines[1]?.reason === 'completed')

  console.log('\n[4] IPC：hello / attach / prompt')
  const client = ipcClient(port)
  await client.ready

  client.send({ id: 1, op: 'hello', token: 'wrong' })
  const badToken = await client.reply(1)
  check('错误 token 被拒', badToken.ok === false && /bad token/.test(badToken.error), JSON.stringify(badToken.error))

  client.send({ id: 2, op: 'hello', token: 'test-token' })
  const hello = await client.reply(2)
  check('hello 返回 pid + allowSessions', typeof hello.pid === 'number' && hello.allowSessions?.[0] === SESSION, JSON.stringify(hello))

  client.send({ id: 3, op: 'attach', key: KEY, token: 'test-token' })
  const attached = await client.reply(3)
  check('按键 attach 到映射会话', attached.ok === true && attached.sessionId === SESSION, JSON.stringify(attached))

  client.send({ id: 4, op: 'attach', key: 'unknown:key', token: 'test-token' })
  const noMapping = await client.reply(4)
  check('未映射的 key 被拒', noMapping.ok === false && /no sessionKeys/.test(noMapping.error), JSON.stringify(noMapping.error))

  client.send({ id: 5, op: 'prompt', key: KEY, text: '来自飞书的问候', token: 'test-token' })
  const prompted = await client.reply(5)
  check('prompt 被接受', prompted.ok === true && prompted.accepted === true, JSON.stringify(prompted))
  check('prompt 返回 afterTurn 水位线（并发时区分是谁的轮次）', typeof prompted.afterTurn === 'number', String(prompted.afterTurn))
  const second = fake.injected[1]
  check('IPC 注入同样带 source.kind="user"', second?.source?.kind === 'user')
  check('IPC 注入正文正确', second?.content?.[0]?.text === '来自飞书的问候')

  client.send({ id: 6, op: 'prompt', sessionId: OTHER, text: '越权', token: 'test-token' })
  const denied = await client.reply(6)
  check('非白名单会话的 prompt 被拒', denied.ok === false && /allowSessions/.test(denied.error), JSON.stringify(denied.error))

  console.log('\n[4b] IPC：steer（中途插入，走 next-step 而不是排队）')
  const beforeSteer = fake.injected.length
  client.send({ id: 11, op: 'steer', key: KEY, text: '先别改那个文件', token: 'test-token' })
  const steered = await client.reply(11)
  check('steer 被接受', steered.ok === true && steered.injected === true, JSON.stringify(steered))
  const steerMsg = fake.injected.at(-1)
  check('确实注入了 1 条', fake.injected.length === beforeSteer + 1, String(fake.injected.length))
  check('走的是 agent.steer()，不是 followup()', steerMsg?.steer === true, JSON.stringify({ steer: steerMsg?.steer }))
  check('steer 载荷同样带 role/id', steerMsg?.role === 'user' && typeof steerMsg?.id === 'string', JSON.stringify({ role: steerMsg?.role, id: steerMsg?.id }))
  check('steer 正文正确', steerMsg?.content?.[0]?.text === '先别改那个文件')

  client.send({ id: 12, op: 'steer', sessionId: OTHER, text: '越权插入', token: 'test-token' })
  const steerDenied = await client.reply(12)
  check('非白名单会话的 steer 被拒', steerDenied.ok === false && /allowSessions/.test(steerDenied.error), JSON.stringify(steerDenied.error))

  console.log('\n[4c] resume：不在 live 的会话要被拉起（关键：字段名是 resumeSessionId）')
  client.send({ id: 13, op: 'prompt', sessionId: RESUMABLE, text: '拉起之后注入', token: 'test-token' })
  const resumedPrompt = await client.reply(13)
  check('prompt 成功（说明走通了 resume）', resumedPrompt.ok === true && resumedPrompt.accepted === true, JSON.stringify(resumedPrompt))
  const resumeCall = fake.resumeCalls.at(-1)
  check('resume 用的是 resumeSessionId（不是 sessionId）', resumeCall?.resumeSessionId === RESUMABLE, JSON.stringify(resumeCall))
  check('没有误用 sessionId 字段', resumeCall?.sessionId === undefined, JSON.stringify(resumeCall?.sessionId))
  check('注入落在被拉起的会话上', fake.injected.at(-1)?.to === RESUMABLE, JSON.stringify(fake.injected.at(-1)?.to))
  check('resume 带上了 agentOptions（否则 {{model}} 没有值）', resumeCall?.agentOptions?.provider === 'test-provider', JSON.stringify(resumeCall?.agentOptions))

  console.log('\n[4d] dispose：插件能释放它自己 resume 出来的 agent')
  client.send({ id: 14, op: 'dispose', sessionId: RESUMABLE, token: 'test-token' })
  const disposedReply = await client.reply(14)
  check('dispose 成功', disposedReply.ok === true && disposedReply.disposed === true, JSON.stringify(disposedReply))
  check('确实调到了 handle.dispose()', fake.disposed.includes(RESUMABLE), JSON.stringify(fake.disposed))

  client.send({ id: 15, op: 'dispose', sessionId: SESSION, token: 'test-token' })
  const disposeMissing = await client.reply(15)
  check('没持有句柄时给出明确错误（而不是静默）', disposeMissing.ok === false && /no retained handle/.test(disposeMissing.error), JSON.stringify(disposeMissing.error))

  console.log('\n[4e] resume 默认被拒（因为 resume 出来的 agent 工具集不全）')
  {
    // 热旋钮里关掉 allowResume：这是默认行为
    writeFileSync(
      join(ROOT, 'config.json'),
      JSON.stringify({ allowSessions: [SESSION, RESUMABLE], allowResume: false, agentOptions: { provider: 'test-provider', model: 'test-model' } }),
    )
    const before = fake.resumeCalls.length
    client.send({ id: 16, op: 'prompt', sessionId: RESUMABLE, text: '不该被注入', token: 'test-token' })
    const refused = await client.reply(16)
    check('被拒绝', refused.ok === false, JSON.stringify(refused.error))
    check('错误里指明了原因（工具集不全）', /a proper resume is unavailable/.test(refused.error ?? ''), JSON.stringify((refused.error ?? '').slice(0, 90)))
    check('错误里给出了处置办法（在桌面打开）', /not open in the desktop/.test(refused.error ?? ''))
    check('没有偷偷调 resume', fake.resumeCalls.length === before, before + ' -> ' + fake.resumeCalls.length)
    rmSync(join(ROOT, 'config.json'), { force: true })
  }

  console.log('\n[4f] 有 composition 时 resume 必须带上 setup（32 个工具全靠它）')
  {
    const root2 = 'D:/cc-dsh-bridge/.test-root2'
    const mounted = []
    const fake2 = fakeCtx({
      services: {
        agentPresets: {
          resolve: async (id) => ({ id: id ?? 'standard' }),
          mount: async (agentCtx, id) => mounted.push(id),
        },
        sessionQuery: {
          // Preset 是 Session projection，不是 header 字段
          observeSession: async () => ({ projections: { values: { agentPreset: 'standard' } } }),
        },
        agentDefaultModel: {
          currentSelection: () => ({ provider: 'live-provider', model: 'live-model', reasoningEffort: 'high' }),
        },
      },
    })
    const port2 = await freePort()
    apply(fake2.ctx, {
      root: root2,
      allowSessions: [SESSION, RESUMABLE],
      captureReplies: true,
      sessionKeys: { [KEY]: SESSION },
      // 故意写一个"过时的"配置值，验证运行时优先用桌面当前选择
      agentOptions: { provider: 'config-provider', model: 'config-model' },
      ipc: { enabled: true, port: port2, token: 'test-token' },
    })
    await wait(250)
    const client2 = ipcClient(port2)
    await client2.ready
    client2.send({ id: 30, op: 'prompt', sessionId: RESUMABLE, text: '用 composition 拉起', token: 'test-token' })
    const composed = await client2.reply(30)
    check('prompt 成功（走 resume）', composed.ok === true && composed.accepted === true, JSON.stringify(composed))
    const call = fake2.resumeCalls.at(-1)
    check('resume 带了 setup 回调', typeof call?.setup === 'function', typeof call?.setup)
    check('模型路由取桌面当前选择（不是配置里的旧值）', call?.agentOptions?.provider === 'live-provider', JSON.stringify(call?.agentOptions))
    check('reasoningEffort 也一并带上', call?.agentOptions?.reasoningEffort === 'high', JSON.stringify(call?.agentOptions))
  }

  console.log('\n[4g] selfcheck：进程内适配器（网关走的就是它）必须能跑')
  {
    client.send({ id: 40, op: 'selfcheck', token: 'test-token' })
    const self = await client.reply(40)
    check('selfcheck 成功（说明 selfPort 没有作用域错误）', self.ok === true, JSON.stringify(self.error ?? ''))
    check('能解析出测试 key 对应的会话', self.sampleSession === SESSION, JSON.stringify(self.sampleSession))
    check('报出了自己的 pid', self.pid > 0, String(self.pid))
    check('报出了 sessionKeys', Array.isArray(self.sessionKeys) && self.sessionKeys.includes(KEY), JSON.stringify(self.sessionKeys))
  }
  console.log('\n[4h] activity：后台任务与子 agent 的运行状态')
  {
    // 一个 job 开始、另一个已结束；一个子 agent 正在跑
    fake.emit(SESSION, { type: 'job/registered', data: { jobId: 'job-1', kind: 'pwsh', label: 'Start-Sleep -Seconds 60; Get-Date', startedAt: Date.now() - 65000 } })
    fake.emit(SESSION, { type: 'job/registered', data: { jobId: 'job-2', kind: 'pwsh', label: '已结束的任务', startedAt: Date.now() - 5000 } })
    fake.emit(SESSION, { type: 'job/settled', data: { jobId: 'job-2' } })
    fake.emit(SESSION, { type: 'tool/call', data: { turn: 9, callId: 'call-sub', name: 'subagent', arguments: JSON.stringify({ description: '调研回调机制' }) } })
    await wait(30)
    client.send({ id: 41, op: 'activity', sessionId: SESSION, token: 'test-token' })
    const activity = await client.reply(41)
    check('activity 成功', activity.ok === true, JSON.stringify(activity.error ?? ''))
    check('只报告仍在运行的 job', activity.jobs.length === 1 && activity.jobs[0].jobId === undefined && /Start-Sleep/.test(activity.jobs[0].label), JSON.stringify(activity.jobs))
    check('job 带已运行时长', /^\d+[smh]/.test(activity.jobs[0].elapsed), activity.jobs[0].elapsed)
    check('已结束的 job 不再出现', activity.jobs.every((job) => !/已结束/.test(job.label)), JSON.stringify(activity.jobs.map((j) => j.label)))
    check('子 agent 在运行列表中', activity.subagents.length === 1 && activity.subagents[0].label === '调研回调机制', JSON.stringify(activity.subagents))
    // 子 agent 结束后应消失
    fake.emit(SESSION, { type: 'tool/result', data: { callId: 'call-sub', name: 'subagent' } })
    await wait(20)
    client.send({ id: 42, op: 'activity', sessionId: SESSION, token: 'test-token' })
    const after = await client.reply(42)
    check('子 agent 结束后不再列出', after.subagents.length === 0, JSON.stringify(after.subagents))
  }
  console.log('\n[5] IPC：事件扇出到已 attach 的客户端')
  fake.emit(SESSION, {
    type: 'assistant/message',
    data: { turn: 4, message: { id: 'msg-2', content: [{ type: 'text', text: '扇出正文' }] } },
  })
  fake.emit(SESSION, { type: 'turn/end', data: { turn: 4, reason: 'completed' } })
  fake.emit(OTHER, {
    type: 'assistant/message',
    data: { turn: 1, message: { id: 'msg-x', content: [{ type: 'text', text: '不该收到' }] } },
  })
  const event1 = await client.next()
  const event2 = await client.next()
  check('收到 assistant 事件', event1.event === 'assistant' && event1.text === '扇出正文', JSON.stringify(event1))
  check('收到 turn-end 事件', event2.event === 'turn-end' && event2.turn === 4, JSON.stringify(event2))

  console.log('\n[5a] IPC：turn/start 也要转发（网关靠它知道"已经在跑"）')
  fake.emit(SESSION, { type: 'turn/start', data: { turn: 6 } })
  const turnStart = await client.next()
  check('收到 turn-start 事件', turnStart.event === 'turn-start' && turnStart.turn === 6, JSON.stringify(turnStart))

  console.log('\n[5b] IPC：工具进度（长任务不再沉默）')
  fake.emit(SESSION, {
    type: 'tool/call',
    data: { turn: 5, step: 1, callId: 'call-abc', name: 'pwsh', arguments: '{"command":"dir"}' },
  })
  fake.emit(SESSION, {
    type: 'tool/result',
    data: {
      turn: 5,
      step: 1,
      // Mirrors the real event: the id lives on message.toolCallId and on
      // message.source.callId — NOT on data.
      message: {
        role: 'tool',
        toolCallId: 'call-abc',
        source: { kind: 'tool', callId: 'call-abc' },
        isError: false,
        content: [{ type: 'text', text: '文件列表…' }],
      },
    },
  })
  const toolCall = await client.next()
  const toolResult = await client.next()
  check('收到 tool-call 事件', toolCall.event === 'tool-call' && toolCall.callId === 'call-abc', JSON.stringify(toolCall))
  check('带工具名与参数', toolCall.name === 'pwsh' && toolCall.arguments === '{"command":"dir"}', JSON.stringify({ name: toolCall.name, args: toolCall.arguments }))
  check('收到 tool-result 事件', toolResult.event === 'tool-result' && toolResult.callId === 'call-abc', JSON.stringify(toolResult))
  check('结果文本与错误位', toolResult.text === '文件列表…' && toolResult.isError === false, JSON.stringify({ text: toolResult.text, isError: toolResult.isError }))

  console.log('\n[6] IPC：cancel')
  client.send({ id: 7, op: 'cancel', sessionId: SESSION, token: 'test-token' })
  const cancelled = await client.reply(7)
  check('cancel 成功', cancelled.ok === true && fake.injected.some((m) => m.cancelled === true), JSON.stringify(cancelled))

  console.log('\n[7] 状态文件')
  const status = JSON.parse(readFileSync(join(ROOT, 'status.json'), 'utf8'))
  check('status.capture = subscribed', status.capture === 'subscribed', status.capture)
  check('status.ipc.bound = true', status.ipc?.bound === true, JSON.stringify(status.ipc))
  check('status.liveAgents 认得会话 id', status.liveAgents?.[0] === SESSION, JSON.stringify(status.liveAgents))

  console.log('\n[8] 热旋钮：改 <root>/config.json 不需要重启 Host')
  writeFileSync(
    join(ROOT, 'config.json'),
    JSON.stringify({ allowSessions: [SESSION, OTHER], sessionKeys: { 'hot:key': OTHER } }, null, 2),
  )
  const beforeHot = fake.injected.length
  client.send({ id: 8, op: 'prompt', sessionId: OTHER, text: '现在应该被允许了', token: 'test-token' })
  const hotAllowed = await client.reply(8)
  check('白名单热生效：原先被拒的会话现在被接受', hotAllowed.ok === true, JSON.stringify(hotAllowed))
  check('注入确实落到了那个会话', fake.injected.length === beforeHot + 1 && fake.injected.at(-1)?.to === OTHER)

  client.send({ id: 9, op: 'attach', key: 'hot:key', token: 'test-token' })
  const hotAttach = await client.reply(9)
  check('会话映射热生效', hotAttach.ok === true && hotAttach.sessionId === OTHER, JSON.stringify(hotAttach))

  client.send({ id: 10, op: 'hello', token: 'test-token' })
  const helloHot = await client.reply(10)
  check('hello 反映热白名单', helloHot.allowSessions?.includes(OTHER) === true, JSON.stringify(helloHot.allowSessions))
  client.close()

  console.log('\n[9] 默认配置必须"什么都不做"')
  const port2 = await freePort()
  const quiet = fakeCtx()
  apply(quiet.ctx, { root: join(ROOT, 'quiet'), ipc: { enabled: false, port: port2 } })
  await wait(200)
  const quietStatus = JSON.parse(readFileSync(join(ROOT, 'quiet', 'status.json'), 'utf8'))
  check('capture = disabled（不订阅事件）', quietStatus.capture === 'disabled', quietStatus.capture)
  check('ipc.bound = false（不监听）', quietStatus.ipc?.bound === false, JSON.stringify(quietStatus.ipc))
  check('allowSessions 默认空', Array.isArray(quietStatus.allowSessions) && quietStatus.allowSessions.length === 0)
  quiet.emit(SESSION, {
    type: 'assistant/message',
    data: { turn: 1, message: { id: 'm', content: [{ type: 'text', text: 'x' }] } },
  })
  check('没有订阅者时事件是空转的', !existsSync(join(ROOT, 'quiet', 'inbox', SESSION + '.jsonl')))

  console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('测试崩溃:', error)
  process.exit(1)
})

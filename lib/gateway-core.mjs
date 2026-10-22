/**
 * gateway-core — the transport-independent half of the Feishu gateway.
 *
 * Goal: own the Feishu side ourselves so a serial turn queue never blocks a
 * being a wall. With our own gateway we can decide, per incoming message, whether
 * to run a turn (`followup`) or to steer INTO the running one — the capability
 * mid-turn message — which a queueing bridge cannot express.
 *
 * Everything here is injectable and side-effect free so it can be tested without
 * Feishu, without DSH, and without a network:
 *
 *   plugin:    { hello, list, attach, prompt, steer, cancel, onEvent }
 *   transport: { sendText, replyMessage }
 *   log:       (...args) => void
 *
 * The Feishu-specific transport lives in ./feishu-transport.mjs and is the only
 * part that talks to the outside world.
 */

/**
 * @typedef {object} PluginPort
 * @property {() => Promise<{pid:number, allowSessions:string[], sessionKeys:string[], ipcBound:boolean, ipcClients:number, lastTurns:Record<string,number>}>} hello
 * @property {() => Promise<{sessions:string[]}>} list
 * @property {(target: {key?:string, sessionId?:string}) => Promise<{sessionId:string}>} attach
 * @property {(args: {sessionId:string, text:string}) => Promise<{afterTurn?:number}>} prompt
 * @property {(args: {sessionId:string, text:string}) => Promise<unknown>} steer
 * @property {(fn: (event:any)=>void) => void} onEvent
 */

import { markdownToText } from './markdown.mjs'

const DEFAULTS = {
  /** `?status` → self-diagnosis instead of a turn */
  statusPrefix: '?',
  /** `#text` → do NOT interrupt; wait for the running turn to end, then send. */
  deferPrefix: '#',
  /** Sent when a message is queued behind the running turn. */
  deferAckText: '已收到，等当前这一轮结束后发送',
  /** Optional force-insert prefix (`!text`); empty = disabled. */
  steerPrefix: '',
  /** 'steer' = mid-turn input when busy; 'queue' = plain followup */
  busyBehavior: 'steer',
  /** Feishu rejects very long messages; split well under the limit */
  chunkSize: 2800,
  /** Remember this many event ids for de-duplication */
  dedupeLimit: 2000,
  /** Trim assistant text longer than this before sending (per chat reply) */
  maxReplyChars: 12000,
  /**
   * Emoji reactions, so a phone user can see the message's lifecycle without
   * opening anything: received → working → done. Empty string disables a step.
   */
  ackEmoji: 'Get',
  onItEmoji: 'OnIt',
  doneEmoji: 'Done',
  /**
   * Feishu text messages render NO markdown, so the agent's ## and ** arrive as
   * literal symbols. Converting here keeps every reply readable; set false only if
   * the transport renders markdown itself (replyFormat: card).
   */
  markdownToText: true,
  /**
   * 回复送达方式：`live` 边产出边发，长任务期间也能看到进展；`buffered` 等这一轮结束
   * 再合并成一条发送。
   */
  deliver: 'live',
  /** Sent when a message is admitted INTO a running turn. */
  steerAckText: '已接收消息，当前工具调用结束后响应',
  /**
   * Fallback session for a chat key the plugin does not know yet.
   *
   * A Feishu key is `feishu:<chat_id>:<open_id>`, and BOTH halves only exist once a
   * message arrives — so a brand-new bot cannot be pre-wired in the plugin's
   * `sessionKeys`. With `defaultSession` set, an unmapped chat is routed there and
   * the exact key is logged for pinning.
   */
  defaultSession: null,
  /**
   * Who may drive this bot. open_id is APP-SCOPED, so a new app's ids are unknown
   * until someone writes to it. With `autoPinFirstUser`, the first sender becomes
   * the only allowed user for the life of the process and is logged so it can be
   * written into gateway.json.
   */
  allowUsers: [],
  autoPinFirstUser: true,
}

/** Tiny FIFO set: remembers the most recent `limit` keys. */
function createLru(limit) {
  const set = new Set()
  return {
    has: (key) => set.has(key),
    add(key) {
      set.add(key)
      if (set.size > limit) {
        const oldest = set.values().next().value
        set.delete(oldest)
      }
    },
  }
}

/** Split a long reply into transport-sized pieces, preferring line breaks. */
export function splitMessage(text, chunkSize) {
  const chunks = []
  let rest = text
  while (rest.length > chunkSize) {
    let cut = rest.lastIndexOf('\n', chunkSize)
    if (cut < chunkSize * 0.5) cut = chunkSize // no useful break nearby
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

export function createGateway({ plugin, transport, log = () => {}, config = {} }) {
  const settings = { ...DEFAULTS, ...config }
  // De-duplication must survive a restart: Feishu retries events that were not
  // acked, and re-injecting one duplicates a user message in the session. Callers
  // pass a durable store (lib/seen-store.mjs); the in-memory LRU is the fallback.
  const seen = settings.seenStore ?? createLru(settings.dedupeLimit)

  /**
   * Per-chat conversation state.
   *
   * `afterTurn` is the watermark the plugin returned for our prompt: only a
   * `turn-end` with a HIGHER turn number is our reply. Without it, a turn the
   * desktop started could be mistaken for ours (the two share one session).
   */
  const chats = new Map()

  function chatState(chatId) {
    let state = chats.get(chatId)
    if (!state) {
      state = {
        inFlight: false,
        afterTurn: 0,
        chunks: [],
        // Set when the plugin reports turn/start (or we infer activity), cleared
        // on turn-end. Used only when the gateway itself is idle.
        observedTurn: false,
        lastActivityAt: 0,
        /** Messages deferred with the defer prefix; drained on turn-end. */
        queue: [],
        draining: false,
        /** /stop 之后丢弃这一轮的残余输出 */
        suppressUntilTurnEnd: false,
        /** 模型目录缓存（编号稳定性） */
        models: null,
      }
      chats.set(chatId, state)
    }
    return state
  }

  let cachedHello = null
  async function hello() {
    if (!cachedHello) cachedHello = await plugin.hello()
    return cachedHello
  }

  /** Resolve which DSH session a Feishu chat drives, via the plugin's mapping. */
  async function resolveSession(chatId, userId) {
    const key = 'feishu:' + chatId + ':' + userId
    try {
      const attached = await plugin.attach({ key })
      return attached.sessionId
    } catch (error) {
      // Unknown chat (a brand-new bot has no pinned mapping yet): fall back to the
      // configured default session and log the exact key to pin.
      if (!settings.defaultSession) throw error
      log('unmapped key ' + key + ' -> defaultSession ' + settings.defaultSession)
      log('pin it with: "sessionKeys": { "' + key + '": "' + settings.defaultSession + '" }')
      const attached = await plugin.attach({ sessionId: settings.defaultSession })
      return attached.sessionId
    }
  }

  function isBusy(state) {
    return state.inFlight || state.observedTurn
  }

  /** 当前模型的可读标签：优先用缓存，没有就现取一次。 */
  async function currentModelLabel(state, info) {
    try {
      const catalogue = await modelCatalogue(state)
      const current = catalogue?.current
      if (current?.provider && current?.model) return current.provider + ' / ' + current.model
    } catch (error) {
      log('model label unavailable:', error?.message ?? error)
    }
    if (info?.provider && info?.model) return info.provider + ' / ' + info.model
    return '未知（发 /model 查看）'
  }

  async function buildStatus(chatId) {
    let info
    let sessions = []
    try {
      info = await plugin.hello()
    } catch (error) {
      info = { error: String(error?.message ?? error) }
    }
    try {
      const list = await plugin.list()
      sessions = Array.isArray(list.sessions) ? list.sessions : []
    } catch {}
    const state = chatState(chatId)
    const target = state.sessionId
    const lines = [
      '**cc-dsh-feishu 自检**',
      '- 插件 pid `' + (info.pid ?? '?') + '`，IPC ' + (info.ipcBound ? '已监听' : '**未监听**') + '，客户端 ' + (info.ipcClients ?? '?'),
      '- 目标会话 `' + (target ?? '未解析') + '`',
      '- 是否 live：' + (target && sessions.includes(target) ? '是' : '否（会尝试 resume，需要 agentOptions）'),
      '- 是否正在跑：' + (isBusy(state) ? '是' : '否'),
      '- 排队中：' + (state.queue?.length ? state.queue.length + ' 条（等这一轮结束）' : '无'),
      '- 模型：' + (await currentModelLabel(state, info)),
      '- 上一轮 turn：`' + (state.afterTurn ?? 0) + '`',
      '- 白名单：`' + JSON.stringify(info.allowSessions ?? []) + '`',
    ]
    if (info.error) lines.push('- ⚠ 插件通讯失败：`' + info.error + '`')
    if (info.agentServiceError) {
      lines.push('- ❌ **插件上下文已失效**：`' + info.agentServiceError + '`')
      lines.push('  → 端口被上一个插件实例占着，注入一定失败。**请重启桌面 App**。')
    }
    // What the session is actually doing. Answering "还在跑" without saying WHAT is
    // what makes a phone user ask again; jobs and subagents come from the plugin's
    // event bookkeeping.
    if (target && typeof plugin.activity === 'function' && !info.agentServiceError) {
      try {
        const activity = await plugin.activity({ sessionId: target })
        const jobs = activity?.jobs ?? []
        const subagents = activity?.subagents ?? []
        if (jobs.length === 0 && subagents.length === 0) {
          lines.push('- 正在运行的后台任务：无')
        } else {
          if (jobs.length > 0) {
            lines.push('- 正在运行的后台任务（' + jobs.length + '）：')
            for (const job of jobs.slice(0, 5)) {
              lines.push('  - `' + (job.kind ?? 'job') + '` ' + (job.label ?? '') + ' — 已运行 ' + (job.elapsed ?? '?'))
            }
          }
          if (subagents.length > 0) {
            lines.push('- 正在运行的子 agent（' + subagents.length + '）：')
            for (const agent of subagents.slice(0, 5)) {
              lines.push('  - ' + (agent.label ?? agent.name ?? '') + ' — 已运行 ' + (agent.elapsed ?? '?'))
            }
          }
        }
      } catch (error) {
        lines.push('- ⚠ 读取运行状态失败：`' + String(error?.message ?? error) + '`')
      }
    }
    return lines.join('\n')
  }

  /** Send a reply, splitting when needed. Never throws (a send failure is logged). */
  async function send(chatId, messageId, text) {
    const body = (text ?? '').trim()
    if (!body) {
      log('nothing to send (empty reply)')
      return
    }
    const rendered = settings.markdownToText ? markdownToText(body) : body
    const chunks = splitMessage(rendered.slice(0, settings.maxReplyChars), settings.chunkSize)
    for (let i = 0; i < chunks.length; i++) {
      // First chunk replies in-thread, the rest are plain sends.
      const useReply = i === 0 && messageId && typeof transport.replyMessage === 'function'
      try {
        if (useReply) await transport.replyMessage({ messageId, text: chunks[i] })
        else await transport.sendText({ chatId, text: chunks[i] })
        // Log the outcome, not just failures: "the agent replied" and "the phone
        // received it" are different facts, and only the second one helps a user.
        log('sent ' + (useReply ? 'reply' : 'message') + ' ' + (i + 1) + '/' + chunks.length + ' to ' + chatId + ' (' + chunks[i].length + ' chars)')
      } catch (error) {
        log('send failed (' + (i + 1) + '/' + chunks.length + '):', error?.message ?? error)
      }
    }
  }

  /**
   * Best-effort emoji reaction on the user's message.
   *
   * Never throws and never awaits: a reaction failure must not delay or drop the
   * actual reply.
   */
  function react(messageId, emoji) {
    if (!messageId || !emoji) return
    try {
      void Promise.resolve(transport.addReaction?.({ messageId, emoji })).catch((error) => {
        log('reaction failed (ignored):', error?.message ?? error)
      })
    } catch (error) {
      log('reaction failed (ignored):', error?.message ?? error)
    }
  }

  /**
   * Send the next deferred message, if the session is idle again.
   *
   * One at a time: each queued message becomes its own turn, so the queue drains on
   * successive `turn-end` events rather than dumping everything at once.
   */
  async function drainQueue(chatId, state) {
    if (state.draining || state.queue.length === 0) return
    if (state.inFlight || state.observedTurn) return
    state.draining = true
    try {
      const next = state.queue.shift()
      state.inFlight = true
      state.chunks = []
      state.replyTo = next.messageId
      const ack = await plugin.prompt({ sessionId: state.sessionId, text: next.text })
      state.afterTurn = Number(ack?.afterTurn ?? 0)
      log('queued prompt -> ' + state.sessionId + ' afterTurn=' + state.afterTurn + ': ' + next.text.slice(0, 60))
      react(next.messageId, settings.onItEmoji)
    } catch (error) {
      log('queued prompt failed:', error?.message ?? error)
      state.inFlight = false
    } finally {
      state.draining = false
    }
  }

  /** Flush the buffered assistant text of the turn that just ended. */
  async function flush(chatId, state) {
    const text = state.chunks.join('\n\n').trim()
    state.chunks = []
    return text
  }

  /** 已知指令；其它以 / 开头的内容一律当普通文本，避免把路径吃掉。 */
  const COMMANDS = new Set(['status', 'stop', 'model', 'help'])

  /**
   * 解析一条消息是不是指令。
   *
   * - `/status` / `/stop` / `/model` / `/help`（可带参数）
   * - `?status` 作为旧写法保留
   * - 其它 `/xxx` 不拦截（`/etc/hosts` 必须照常发给 agent）
   */
  function parseCommand(raw) {
    const slash = String(raw).match(/^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/)
    if (slash) {
      const name = slash[1].toLowerCase()
      if (!COMMANDS.has(name)) return null
      return { name, args: (slash[2] ?? '').trim() }
    }
    const legacy = String(raw).match(/^\?status\b\s*([\s\S]*)$/i)
    if (legacy) return { name: 'status', args: (legacy[1] ?? '').trim() }
    return null
  }

  /** 指令说明。手机端没有命令补全，这一条是唯一的入口说明。 */
  function helpText() {
    return [
      '**可用指令**',
      '- `/status`（旧写法 `?status`）：是否在跑、后台任务、子 agent、排队数、当前模型',
      '- `/stop`：停止当前正在跑的轮次',
      '- `/model`：列出可用模型；`/model 2` 或 `/model provider/model` 切换（**下一轮生效**）',
      '- `/help`：这条说明',
      '',
      '其它消息照常发给 agent；句首 `#` 表示排队到当前轮结束，不加则忙时插入当前轮。',
    ].join('\n')
  }

  /** 模型目录的缓存（编号要稳定，不能每次重排）。 */
  const MODEL_CACHE_MS = 5 * 60 * 1000

  async function modelCatalogue(state) {
    const fresh = state.models && Date.now() - state.models.at < MODEL_CACHE_MS
    if (fresh) return state.models
    const catalogue = await plugin.models({ sessionId: state.sessionId })
    const flat = []
    for (const group of catalogue.groups ?? []) {
      for (const model of group.models ?? []) {
        flat.push({ provider: group.provider, model: model.id, name: model.name, group: group.name })
      }
    }
    state.models = { at: Date.now(), ...catalogue, flat }
    return state.models
  }

  function formatModelList(catalogue) {
    const { flat, current } = catalogue
    if (flat.length === 0) {
      return '没有发现可用模型。检查 provider 的凭据（`dsh-feishu-setup`，或 DSH 设置里的账号）。'
    }
    const lines = ['**可用模型**']
    if (current?.provider && current?.model) {
      lines.push('当前默认：`' + current.provider + ' / ' + current.model + '`')
    }
    flat.slice(0, 30).forEach((entry, index) => {
      const isCurrent = current && current.provider === entry.provider && current.model === entry.model
      lines.push(index + 1 + ') `' + entry.provider + ' / ' + entry.model + '`' + (isCurrent ? '  ← 当前' : ''))
    })
    if (flat.length > 30) {
      lines.push('（还有 ' + (flat.length - 30) + ' 个未列出，可用 /model provider/model 直接指定）')
    }
    lines.push('')
    lines.push('发 `/model 2` 切换（或 `/model provider/model`）。切换对**下一轮**生效。')
    return lines.join('\n')
  }

  /** 执行一条指令。 */
  async function runCommand(command, { chatId, messageId, state }) {
    if (command.name === 'help') {
      await send(chatId, messageId, helpText())
      return
    }
    if (command.name === 'status') {
      await send(chatId, messageId, await buildStatus(chatId))
      return
    }
    if (command.name === 'stop') {
      if (!isBusy(state)) {
        await send(chatId, messageId, '当前没有在跑的轮次。')
        return
      }
      // 停止后这一轮的残余输出不再发出去，否则"已停止"后面还会冒出一大段。
      state.suppressUntilTurnEnd = true
      state.inFlight = false
      state.chunks = []
      const result = await plugin.cancel({ sessionId: state.sessionId })
      log('stop -> ' + state.sessionId + ' ok=' + result?.ok)
      await send(chatId, messageId, result?.ok === false ? '停止失败：' + (result.error ?? '原因未知') : '已停止当前轮。')
      return
    }
    if (command.name === 'model') {
      const catalogue = await modelCatalogue(state)
      const arg = command.args
      if (!arg) {
        await send(chatId, messageId, formatModelList(catalogue))
        return
      }
      const flat = catalogue.flat ?? []
      let picked = null
      if (/^\d+$/.test(arg)) {
        picked = flat[Number(arg) - 1] ?? null
        if (!picked) {
          await send(chatId, messageId, '编号超出范围（1–' + flat.length + '）。发 `/model` 看列表。')
          return
        }
      } else if (arg.includes('/')) {
        const parts = arg.split('/')
        const provider = parts[0]
        const model = parts.slice(1).join('/')
        picked = flat.find((entry) => entry.provider === provider && entry.model === model) ?? null
      } else {
        picked = flat.find((entry) => entry.model === arg) ?? null
      }
      if (!picked) {
        await send(chatId, messageId, '没找到模型「' + arg + '」。发 `/model` 看列表。')
        return
      }
      try {
        await plugin.setModel({ sessionId: state.sessionId, provider: picked.provider, model: picked.model })
        state.models = null
        const busyNote = isBusy(state) ? '（当前这一轮仍用旧模型）' : ''
        await send(chatId, messageId, '已切到 `' + picked.provider + ' / ' + picked.model + '`，下一轮生效。' + busyNote)
      } catch (error) {
        await send(chatId, messageId, '切换失败：' + String(error?.message ?? error))
      }
    }
  }

  async function handleIncoming(message) {
    const { eventId, messageId, chatId, userId, text, fromBot } = message
    if (fromBot) return
    if (eventId) {
      if (seen.has(eventId)) {
        log('duplicate event ignored:', eventId)
        return
      }
      seen.add(eventId)
    }
    const raw = (text ?? '').trim()
    if (!raw) return

    // 记下这个会话：chat_id 按应用隔离，这是唯一能保证"本机器人可达"的值。
    // 媒体发送在没有显式指定目标时用它兜底。
    try {
      settings.onChatSeen?.({ chatId, userId })
    } catch (error) {
      log('chat recording failed:', error?.message ?? error)
    }

    // Immediately: "your message reached the bot". Placed after de-duplication so a
    // Feishu retry does not stack reactions.
    react(messageId, settings.ackEmoji)

    // Who may drive this bot: open_id is app-scoped, so a fresh app learns it from
    // the first message and then refuses everybody else.
    if (settings.allowUsers.length > 0) {
      if (!settings.allowUsers.includes(userId)) {
        log('refusing message from ' + userId + ' (not in allowUsers)')
        return
      }
    } else if (settings.autoPinFirstUser && userId) {
      settings.allowUsers = [userId]
      log('PINNED first sender as the only allowed user: ' + userId)
      log('persist it: "allowUsers": ["' + userId + '"] in gateway.json')
    }

    const state = chatState(chatId)
    try {
      if (!state.sessionId) state.sessionId = await resolveSession(chatId, userId)

      const command = parseCommand(raw)
      if (command) {
        await runCommand(command, { chatId, messageId, state })
        return
      }

      // `#` means "do NOT interrupt — wait for the running turn to finish".
      const wantsDefer = Boolean(settings.deferPrefix) && raw.startsWith(settings.deferPrefix)
      // An explicit force-insert prefix (empty by default) still exists for the case
      // where the busy/idle decision is wrong.
      const wantsForceSteer = Boolean(settings.steerPrefix) && raw.startsWith(settings.steerPrefix)
      const prefix = wantsDefer ? settings.deferPrefix : wantsForceSteer ? settings.steerPrefix : ''
      const body = prefix ? raw.slice(prefix.length).trim() : raw
      if (!body) {
        await send(chatId, messageId, '（' + prefix + ' 后面要有内容）')
        return
      }

      if (wantsDefer) {
        // 永远先入队再回执：这样"# 意味着不打断"在忙和闲两种情况下表现一致。
        // 空闲时 drainQueue 会立刻放行，所以用户看到的仍是马上执行。
        state.queue.push({ text: body, messageId })
        log('deferred (' + state.queue.length + ' queued, busy=' + isBusy(state) + ') -> ' + state.sessionId + ': ' + body.slice(0, 60))
        await send(chatId, messageId, settings.deferAckText)
        await drainQueue(chatId, state)
        return
      }

      const wantSteer = wantsForceSteer || (isBusy(state) && settings.busyBehavior === 'steer')
      if (wantSteer) {
        const result = await plugin.steer({ sessionId: state.sessionId, text: body })
        log((wantsForceSteer ? 'forced' : 'auto') + ' steer -> ' + state.sessionId + ': ' + body.slice(0, 60))
        state.lastActivityAt = Date.now()
        if (result?.via === 'followup') {
          // No turn was running, so the plugin queued an ordinary message instead.
          // Treat it exactly like a prompt: otherwise nobody flushes its reply and
          // the user would get an acknowledgement and then silence.
          state.inFlight = true
          state.chunks = []
          state.replyTo = messageId
          state.afterTurn = Number(result?.afterTurn ?? 0)
          void react(messageId, settings.onItEmoji)
          return
        }
        void react(messageId, settings.onItEmoji)
        await send(chatId, messageId, settings.steerAckText)
        return
      }

      if (state.inFlight) {
        await send(chatId, messageId, '还在跑上一轮，这条会排在后面。')
      }
      state.inFlight = true
      state.chunks = []
      // The reply lands as a threaded answer to THIS message, so remember it.
      state.replyTo = messageId
      const ack = await plugin.prompt({ sessionId: state.sessionId, text: body })
      state.afterTurn = Number(ack?.afterTurn ?? 0)
      log('prompt -> ' + state.sessionId + ' afterTurn=' + state.afterTurn + ': ' + body.slice(0, 60))
      void react(messageId, settings.onItEmoji)
    } catch (error) {
      state.inFlight = false
      log('incoming failed:', error?.message ?? error)
      // Never stay silent: an unreachable plugin is exactly what the operator must see.
      await send(chatId, messageId, '❌ 桥接失败：' + String(error?.message ?? error))
    }
  }

  /** Plugin events: aggregate our turn's output, then answer once it ends. */
  async function handleEvent(event) {
    if (!event || !event.sessionId) return
    // Find the chat(s) driving this session (usually one).
    const affected = []
    for (const [chatId, state] of chats) {
      if (state.sessionId === event.sessionId) affected.push([chatId, state])
    }
    if (affected.length === 0) return

    for (const [chatId, state] of affected) {
      if (event.event === 'turn-start') {
        state.observedTurn = true
        state.lastActivityAt = Date.now()
        continue
      }
      if (event.event === 'assistant' && event.text) {
        state.observedTurn = true
        state.lastActivityAt = Date.now()
        state.observedTurn = true
        state.lastActivityAt = Date.now()
        if (state.suppressUntilTurnEnd) continue
        if (!state.inFlight || !(event.turn > state.afterTurn)) continue
        if (settings.deliver === 'live') {
          // Deliver as the turn produces text. Buffering until `turn-end` means a
          // long turn — which is exactly when someone checks their phone — shows
          // nothing until it finishes.
          await send(chatId, state.replyTo, event.text)
        } else {
          state.chunks.push(event.text)
        }
        continue
      }
      if (event.event === 'tool-call' || event.event === 'tool-result') {
        // Progress only affects the busiest flag, never the reply body.
        state.observedTurn = true
        state.lastActivityAt = Date.now()
        continue
      }
      if (event.event === 'turn-end') {
        const turn = Number(event.turn)
        const isOurs = state.inFlight && Number.isFinite(turn) && turn > state.afterTurn
        state.observedTurn = false
        state.lastActivityAt = Date.now()
        if (state.suppressUntilTurnEnd) {
          state.suppressUntilTurnEnd = false
          state.replyTo = undefined
        }
        if (!isOurs) {
          // A deferred message waits for ANY turn to finish, including one started
          // from the desktop — that is the whole point of `#`.
          await drainQueue(chatId, state)
          continue
        }
        state.inFlight = false
        const replyTo = state.replyTo
        if (settings.deliver === 'buffered') {
          const text = await flush(chatId, state)
          await send(chatId, replyTo, text || '（这一轮没有文字输出）')
        }
        react(replyTo, settings.doneEmoji)
        state.replyTo = undefined
        await drainQueue(chatId, state)
      }
    }
  }

  plugin.onEvent((event) => {
    void handleEvent(event).catch((error) => log('event handling failed:', error?.message ?? error))
  })

  return {
    /** Entry point for transport messages. */
    handleIncoming,
    /** Exposed for tests and for `?status`. */
    buildStatus,
    /** chatId -> state. Read-only view for diagnostics. */
    chats,
    /** Number of chats seen since start (heartbeat uses this). */
    get chatCount() {
      return chats.size
    },
    splitMessage: (text) => splitMessage(text, settings.chunkSize),
  }
}

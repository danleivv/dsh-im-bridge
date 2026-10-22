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

      if (raw.startsWith(settings.statusPrefix)) {
        await send(chatId, messageId, await buildStatus(chatId))
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

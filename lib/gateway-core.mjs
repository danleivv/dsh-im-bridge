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
import { createTranslator } from './i18n.mjs'
import { buildModelCard, buildPermissionCard, buildResultCard } from './cards.mjs'
import {
  createProgress,
  recordToolCall,
  recordToolResult,
  renderProgressCard,
  PROGRESS_MIN_INTERVAL_MS,
  PROGRESS_HEARTBEAT_MS,
} from './progress-card.mjs'

const DEFAULTS = {
  /** `?status` → self-diagnosis instead of a turn */
  statusPrefix: '?',
  /** `#text` → do NOT interrupt; wait for the running turn to end, then send. */
  deferPrefix: '#',
  /** Sent when a message is queued behind the running turn. */
  deferAckText: null,
  /** Optional force-insert prefix (`!text`); empty = disabled. */
  steerPrefix: '',
  /** 'steer' = mid-turn input when busy; 'queue' = plain followup */
  busyBehavior: 'steer',
  /** Feishu rejects very long messages; split well under the limit */
  chunkSize: 2800,
  /** 长任务进度卡（lib/progress-card.mjs） */
  progressCard: true,
  /** 桌面端发起的轮次也推进度卡：同一会话，手机上也该看到桌面在干什么 */
  progressAllTurns: true,
  /** 把桌面端的对话同步到飞书：默认开启（不想同步就 /mirror off） */
  mirrorDesktop: true,
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
  steerAckText: null,
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
    let piece = rest.slice(0, cut)
    // 切点落在未闭合的代码块里：给这一段补上围栏，并在下一段重新打开。
    // 否则两段都是"未闭合"状态，谁都不会渲染成代码块。
    if (hasOpenFence(piece)) {
      const language = lastFenceLanguage(piece)
      piece += '\n```'
      rest = '```' + language + '\n' + rest.slice(cut).replace(/^\n+/, '')
    } else {
      rest = rest.slice(cut).replace(/^\n+/, '')
    }
    chunks.push(piece)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** 这段文本结束时是否还在代码块里。 */
export function hasOpenFence(text) {
  const fences = String(text).match(/^```/gm)
  return (fences?.length ?? 0) % 2 === 1
}

/** 最后一个代码块的语言标记（用于续接）。 */
export function lastFenceLanguage(text) {
  const all = [...String(text).matchAll(/^```([A-Za-z0-9_+-]*)\s*$/gm)]
  return all.length > 0 ? all[all.length - 1][1] : ''
}

export function createGateway({ plugin, transport, log = () => {}, config = {} }) {
  const settings = { ...DEFAULTS, ...config }
  /** 所有面向用户的文字都走它；日志不翻译。 */
  const t = createTranslator(settings.language)
  log('mirror default: ' + (settings.mirrorDesktop === true ? 'on' : 'off') + ', progress default: ' + (settings.progressCard !== false ? 'on' : 'off'))
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
        /** 当前轮次的来源：feishu / desktop */
        turnOrigin: null,
        /** 桌面端刚说过话，等 turn-start 认领镜像轮次 */
        mirrorPending: false,
        /** 正在镜像的那一轮 */
        mirrorTurn: null,
        /** 我们自己刚从飞书注入的话（文本 + 失效时间），防止回显成"桌面端发来" */
        ownSteer: null,
        /** 最近一次 turn 号（/progress on 补建卡片时用） */
        lastTurn: null,
        /** 长任务的进度卡片状态（lib/progress-card.mjs） */
        progress: null,
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
  /**
   * sessionId → chatId 的反向查找。
   *
   * 桌面端发起的轮次没有入站消息，网关手上没有 chat 状态映射，但进度卡要有地方发。
   * 这里从配置（sessionKeys 的 key 前缀 / defaultSession+defaultChat）反推。
   */
  let chatMapCache = { at: 0, map: {} }
  const CHAT_MAP_TTL_MS = 60000

  async function sessionChatMap() {
    if (Date.now() - chatMapCache.at < CHAT_MAP_TTL_MS) return chatMapCache.map
    try {
      const map = (await plugin.chats?.({})) ?? {}
      chatMapCache = { at: Date.now(), map }
      return map
    } catch (error) {
      log('chats lookup failed:', error?.message ?? error)
      return chatMapCache.map
    }
  }

  async function chatIdForSession(sessionId) {
    if (!sessionId) return null
    if (settings.defaultSession && settings.defaultSession === sessionId && settings.defaultChat) {
      return settings.defaultChat
    }
    const fromConfig = Object.entries(settings.sessionKeys ?? {}).find(([, target]) => target === sessionId)
    if (fromConfig) {
      const parts = String(fromConfig[0]).split(':')
      if (parts[0] === 'feishu' && parts[1]) return parts[1]
    }
    const map = await sessionChatMap()
    return map[sessionId] ?? null
  }

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
    return t('status.modelUnknown')
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
      t('status.title'),
      t('status.ipc', { pid: info.pid ?? '?', bound: Boolean(info.ipcBound), clients: info.ipcClients ?? '?' }),
      t('status.target', { target: target ?? t('status.unresolved') }),
      t('status.live', { live: target && sessions.includes(target) ? t('status.liveYes') : t('status.liveNo') }),
      t('status.running', { running: isBusy(state) ? t('status.yes') : t('status.no') }),
      t('status.queue', { count: state.queue?.length ?? 0 }),
      t('status.model', { model: await currentModelLabel(state, info) }),
      t('status.lastTurn', { turn: state.afterTurn ?? 0 }),
      t('status.allow', { list: JSON.stringify(info.allowSessions ?? []) }),
    ]
    if (info.error) lines.push(t('status.pluginError', { error: info.error }))
    if (info.agentServiceError) {
      lines.push(t('status.contextDead', { error: info.agentServiceError }))
      lines.push(t('status.contextDeadHint'))
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
          lines.push(t('status.jobsNone'))
        } else {
          if (jobs.length > 0) {
            lines.push(t('status.jobsHeader', { count: jobs.length }))
            for (const job of jobs.slice(0, 5)) {
              lines.push(t('status.jobLine', { kind: job.kind ?? 'job', label: job.label ?? '', elapsed: job.elapsed ?? '?' }))
            }
          }
          if (subagents.length > 0) {
            lines.push(t('status.subagentsHeader', { count: subagents.length }))
            for (const agent of subagents.slice(0, 5)) {
              lines.push(t('status.subagentLine', { name: agent.label ?? agent.name ?? '', elapsed: agent.elapsed ?? '?' }))
            }
          }
        }
      } catch (error) {
        lines.push(t('status.readFail', { error: String(error?.message ?? error) }))
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
  const COMMANDS = new Set(['status', 'stop', 'model', 'help', 'progress', 'perm', 'mirror'])

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
      t('help.title'),
      t('help.status'),
      t('help.stop'),
      t('help.model'),
      t('help.mirror'),
      t('help.perm'),
      t('help.progress'),
      t('help.progressToggle'),
      t('help.help'),
      '',
      t('help.tail'),
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
      return t('model.empty')
    }
    const lines = [t('model.title')]
    if (current?.provider && current?.model) {
      lines.push(t('model.current', { provider: current.provider, model: current.model }))
    }
    flat.slice(0, 30).forEach((entry, index) => {
      const isCurrent = current && current.provider === entry.provider && current.model === entry.model
      lines.push(index + 1 + ') `' + entry.provider + ' / ' + entry.model + '`' + (isCurrent ? t('model.currentMark') : ''))
    })
    if (flat.length > 30) {
      lines.push(t('model.more', { count: flat.length - 30 }))
    }
    lines.push('')
    lines.push(t('model.hintText'))
    return lines.join('\n')
  }

  /** 权限名称查找（宿主返回的 name 常常就是 id 本身，这时用我们的标签）。 */
  function labelForPreset(presets, id) {
    const translated = t('preset.' + id)
    if (translated !== 'preset.' + id) return translated
    const found = presets.find((preset) => preset.id === id)
    return found ? found.name : String(id)
  }

  /** 权限的可读名称与说明：宿主没给就补上。 */
  function describePreset(preset) {
    const label = labelForPreset([], preset.id)
    const name = preset.name && preset.name !== preset.id ? preset.name : label
    const fallbackDesc = t('preset.' + preset.id + '.desc')
    const description = preset.description ?? (fallbackDesc !== 'preset.' + preset.id + '.desc' ? fallbackDesc : undefined)
    return { label: name, description }
  }

  /** 权限的文字兜底列表。 */
  function formatPermissionList(presets, current) {
    const lines = [t('perm.title')]
    presets.forEach((preset, index) => {
      const readable = describePreset(preset)
      lines.push(index + 1 + ') ' + readable.label + (preset.id === current ? t('model.currentMark') : ''))
      if (readable.description) lines.push('    ' + readable.description)
    })
    lines.push('')
    lines.push(t('perm.hintText'))
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
        await send(chatId, messageId, t('stop.idle'))
        return
      }
      // 停止后这一轮的残余输出不再发出去，否则"已停止"后面还会冒出一大段。
      state.suppressUntilTurnEnd = true
      state.inFlight = false
      state.chunks = []
      const result = await plugin.cancel({ sessionId: state.sessionId })
      log('stop -> ' + state.sessionId + ' ok=' + result?.ok)
      await send(chatId, messageId, result?.ok === false ? t('stop.failed', { error: result.error ?? t('stop.unknownReason') }) : t('stop.ok'))
      return
    }
    if (command.name === 'progress') {
      const arg = (command.args ?? '').toLowerCase()
      if (arg === 'on' || arg === 'off') {
        const enabled = arg === 'on'
        // 先收尾再改开关：flushProgress 会读开关，先关掉的话最后一张卡刷不出去。
        if (!enabled && state.progress) {
          stopProgressTimers(state)
          await flushProgress(chatId, state, { final: true }).catch(() => {})
          state.progress = null
        }
        settings.progressPrefs = { ...(settings.progressPrefs ?? {}), [chatId]: enabled }
        try {
          settings.saveProgressPrefs?.(settings.progressPrefs)
        } catch (error) {
          log('save progress pref failed:', error?.message ?? error)
        }
        if (enabled) {
          // 立即生效：正在跑的这一轮 turn-start 早就过了，必须在这里补建。
          // 但桌面端发起的轮次，mirror 没开就不补建（否则等于绕过 mirror 泄露桌面活动）。
          const mayShow = state.turnOrigin !== 'desktop' || mirrorEnabled(chatId)
          if (isBusy(state) && mayShow) {
            if (!state.progress || state.progress.finished) {
              state.progress = createProgress(state.lastTurn ?? '?')
            }
            startProgressHeartbeat(chatId, state)
            await flushProgress(chatId, state)
          }
        }
        await send(chatId, messageId, enabled
          ? t('progress.enabled')
          : t('progress.disabled'))
        return
      }
      if (arg !== '') {
        await send(chatId, messageId, t('progress.usage'))
        return
      }
      const progress = state.progress
      if (!progress || progress.finished) {
        await send(chatId, messageId, t('progress.none'))
        return
      }
      const lines = [t('progress.title', { turn: progress.turn, total: progress.total }), '']
      for (const entry of progress.entries) {
        const started = new Date(entry.startedAt).toLocaleTimeString('zh-CN', { hour12: false })
        if (entry.kind === 'note') {
          lines.push('- ' + started + '  ' + entry.text)
          continue
        }
        const status = entry.status === 'running' ? t('progress.running') : t('progress.done')
        const ms = (entry.endedAt ?? Date.now()) - entry.startedAt
        lines.push(t('progress.line', { time: started, name: entry.name, summary: entry.summary || t('progress.noArgs'), status, seconds: (ms / 1000).toFixed(1) }))
      }
      if (progress.entries.length === 0) lines.push(t('progress.empty'))
      lines.push('', t('progress.footer'))
      await send(chatId, messageId, lines.join('\n'))
      return
    }
    if (command.name === 'mirror') {
      const arg = (command.args ?? '').trim().toLowerCase()
      if (arg === '' || arg === 'status') {
        await send(chatId, messageId, t('mirror.status', { state: mirrorEnabled(chatId) ? t('mirror.on') : t('mirror.off') }))
        return
      }
      if (arg !== 'on' && arg !== 'off') {
        await send(chatId, messageId, t('mirror.usage'))
        return
      }
      const enabled = arg === 'on'
      settings.mirrorPrefs = { ...(settings.mirrorPrefs ?? {}), [chatId]: enabled }
      try {
        settings.saveMirrorPrefs?.(settings.mirrorPrefs)
      } catch (error) {
        log('save mirror pref failed:', error?.message ?? error)
      }
      await send(chatId, messageId, enabled ? t('mirror.enabled') : t('mirror.disabled'))
      return
    }
    if (command.name === 'perm') {
      const arg = (command.args ?? '').trim()
      let choices
      try {
        choices = await plugin.permissions({ sessionId: state.sessionId })
      } catch (error) {
        await send(chatId, messageId, t('perm.unavailable', { error: String(error?.message ?? error) }))
        return
      }
      const presets = choices?.presets ?? []
      if (presets.length === 0) {
        await send(chatId, messageId, t('perm.empty'))
        return
      }
      const current = choices?.current ?? null
      if (!arg) {
        const card = buildPermissionCard({
          title: t('card.permTitle'),
          subtitle: current ? t('perm.current', { preset: labelForPreset(presets, current) }) : null,
          options: presets.map((preset) => {
            const readable = describePreset(preset)
            return { id: preset.id, label: readable.label, description: readable.description, current: preset.id === current }
          }),
          warn: t('perm.warn'),
        })
        try {
          state.permCardId = await transport.createCard({ chatId, card })
        } catch (error) {
          log('perm card failed, falling back to text:', error?.message ?? error)
          await send(chatId, messageId, formatPermissionList(presets, current))
        }
        return
      }
      // 文字兜底：/perm <编号 或 preset id>
      const picked = /^\d+$/.test(arg)
        ? presets[Number(arg) - 1] ?? null
        : presets.find((preset) => preset.id === arg) ?? presets.find((preset) => preset.name === arg) ?? null
      if (!picked) {
        await send(chatId, messageId, t('perm.notFound', { name: arg }))
        return
      }
      try {
        await plugin.setPermission({ sessionId: state.sessionId, preset: picked.id })
        await send(chatId, messageId, t('perm.switched', { preset: picked.name }))
      } catch (error) {
        await send(chatId, messageId, t('perm.failed', { error: String(error?.message ?? error) }))
      }
      return
    }
    if (command.name === 'model') {
      const catalogue = await modelCatalogue(state)
      const arg = command.args
      if (!arg) {
        // 选项卡：点一下就切，不用记编号。
        const flatModels = catalogue.flat ?? []
        if (flatModels.length === 0) {
          await send(chatId, messageId, t('model.empty'))
          return
        }
        const current = catalogue.current
        const card = buildModelCard({
          title: t('card.modelTitle'),
          subtitle: current ? t('model.current', { provider: current.provider, model: current.model }) : null,
          options: flatModels.slice(0, 10).map((entry) => ({
            label: entry.provider + ' / ' + entry.model,
            value: { provider: entry.provider, model: entry.model },
            current: Boolean(current && current.provider === entry.provider && current.model === entry.model),
          })),
          note: t('model.hint'),
        })
        try {
          state.modelCardId = await transport.createCard({ chatId, card })
        } catch (error) {
          log('model card failed, falling back to text:', error?.message ?? error)
          await send(chatId, messageId, formatModelList(catalogue))
        }
        return
      }
      const flat = catalogue.flat ?? []
      let picked = null
      if (/^\d+$/.test(arg)) {
        picked = flat[Number(arg) - 1] ?? null
        if (!picked) {
          await send(chatId, messageId, t('model.badIndex', { max: flat.length }))
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
        await send(chatId, messageId, t('model.notFound', { name: arg }))
        return
      }
      try {
        await plugin.setModel({ sessionId: state.sessionId, provider: picked.provider, model: picked.model })
        state.models = null
        const busyNote = isBusy(state) ? t('model.busyNote') : ''
        await send(chatId, messageId, t('model.switched', { provider: picked.provider, model: picked.model }) + busyNote)
      } catch (error) {
        await send(chatId, messageId, t('model.switchFailed', { error: String(error?.message ?? error) }))
      }
    }
  }

  /** 镜像开关：按聊天记忆，默认取全局默认（关）。 */
  function mirrorEnabled(chatId) {
    const pref = chatId ? settings.mirrorPrefs?.[chatId] : undefined
    if (pref === true) return true
    if (pref === false) return false
    return settings.mirrorDesktop === true
  }

  /** 只回显插件启动之后产生的消息：重启时系统会把历史再播一遍。 */
  const gatewayStartedAt = Date.now()
  function isFresh(event) {
    const time = Number(event?.time ?? 0)
    if (!time) return true
    return time >= gatewayStartedAt - 1000
  }

  /** 进度卡片：长任务的"它还活着"信号，详情见 lib/progress-card.mjs。 */
  function progressEnabled(chatId) {
    // 每个聊天可以单独 /progress off；没设过就看全局默认。
    const pref = chatId ? settings.progressPrefs?.[chatId] : undefined
    if (pref === false) return false
    if (pref === true) return true
    return settings.progressCard !== false
  }

  /** 第一次更新时建卡，之后原地 patch。 */
  async function flushProgress(chatId, state, { final = false } = {}) {
    const progress = state.progress
    if (!progress || !progressEnabled(chatId)) return
    try {
      const card = renderProgressCard(progress, { final, lang: settings.language })
      if (!progress.messageId) {
        // 单飞：并发的两次刷新（心跳 + 第一次工具调用）都看到"还没建卡"时，
        // 只能建一张。否则后建的会覆盖 messageId，先建的那张永远停在第一屏
        // ——就是"每次两个消息、第一个只显示一条"的那个 bug。
        if (!progress.creating) {
          progress.creating = (async () => {
            const messageId = await transport.createCard({ chatId, card })
            progress.messageId = messageId
            log('progress card created for ' + chatId)
            return messageId
          })()
          progress.creating
            .catch(() => {})
            .finally(() => {
              progress.creating = null
            })
        }
        await progress.creating
        // 建卡期间进度可能又变了，补一次原地更新，别让卡片停在旧内容。
        if (progress.messageId) {
          await transport.updateCard({ messageId: progress.messageId, card })
        }
      } else {
        await transport.updateCard({ messageId: progress.messageId, card })
      }
      progress.lastRenderAt = Date.now()
    } catch (error) {
      // 进度是锦上添花，失败绝不能影响正式回复。
      log('progress card failed (ignored):', error?.message ?? error)
    }
  }

  /** 节流：最多每 PROGRESS_MIN_INTERVAL_MS 更新一次，并保证最后一次一定会刷出去。 */
  function scheduleProgress(chatId, state) {
    const progress = state.progress
    if (!progress || !progressEnabled(chatId) || progress.finished) return
    // 还没建卡时立刻建，不要等节流——否则长任务开头是空白。
    if (!progress.messageId) {
      if (progress.pendingTimer) return
      progress.pendingTimer = setTimeout(() => {
        progress.pendingTimer = null
        void flushProgress(chatId, state)
      }, 0)
      if (typeof progress.pendingTimer?.unref === 'function') progress.pendingTimer.unref()
      return
    }
    const wait = Math.max(0, PROGRESS_MIN_INTERVAL_MS - (Date.now() - progress.lastRenderAt))
    if (progress.pendingTimer) return
    progress.pendingTimer = setTimeout(() => {
      progress.pendingTimer = null
      void flushProgress(chatId, state)
    }, wait)
    if (typeof progress.pendingTimer?.unref === 'function') progress.pendingTimer.unref()
  }

  /** 心跳：没有新事件时也要刷新"已运行多久"。 */
  function startProgressHeartbeat(chatId, state) {
    const progress = state.progress
    if (!progress || progress.heartbeatTimer) return
    progress.heartbeatTimer = setInterval(() => {
      if (!progress.finished) void flushProgress(chatId, state)
    }, PROGRESS_HEARTBEAT_MS)
    if (typeof progress.heartbeatTimer?.unref === 'function') progress.heartbeatTimer.unref()
  }

  function stopProgressTimers(state) {
    const progress = state.progress
    if (!progress) return
    if (progress.pendingTimer) clearTimeout(progress.pendingTimer)
    if (progress.heartbeatTimer) clearInterval(progress.heartbeatTimer)
    progress.pendingTimer = null
    progress.heartbeatTimer = null
  }

  /** 卡片上的点击：模型切换 / 权限切换。 */
  async function handleCardAction({ value, messageId, chatId, userId }) {
    if (settings.allowUsers?.length > 0 && userId && !settings.allowUsers.includes(userId)) {
      log('card action refused for ' + userId + ' (not in allowUsers)')
      return { toast: { type: 'error', content: t('action.forbidden') } }
    }
    if (!chatId) return { toast: { type: 'error', content: t('action.noChat') } }
    const state = chatState(chatId)
    try {
      if (!state.sessionId) state.sessionId = await resolveSession(chatId, userId)
      const action = value?.action
      if (action === 'model.select') {
        await plugin.setModel({ sessionId: state.sessionId, provider: value.provider, model: value.model })
        state.models = null
        const card = buildResultCard({
          title: t('action.modelDone'),
          detail: '`' + value.provider + ' / ' + value.model + '`',
          hint: t('action.nextTurn'),
        })
        if (messageId) await transport.updateCard({ messageId, card }).catch(() => {})
        return { toast: { type: 'success', content: t('action.modelDone') } }
      }
      if (action === 'permission.select') {
        await plugin.setPermission({ sessionId: state.sessionId, preset: value.preset })
        const card = buildResultCard({
          title: t('action.permDone'),
          detail: '`' + value.preset + '`',
          hint: t('action.permHint'),
        })
        if (messageId) await transport.updateCard({ messageId, card }).catch(() => {})
        return { toast: { type: 'success', content: t('action.permDone') } }
      }
      return { toast: { type: 'info', content: t('action.unknown') } }
    } catch (error) {
      log('card action failed:', error?.message ?? error)
      return { toast: { type: 'error', content: String(error?.message ?? error) } }
    }
  }

  /** 收到文件/图片：交给插件下载落盘并注入会话。 */
  async function handleAttachments({ chatId, messageId, userId, attachments }) {
    if (settings.receiveFiles === false) {
      await send(chatId, messageId, t('attach.disabled'))
      return
    }
    const state = chatState(chatId)
    try {
      if (!state.sessionId) state.sessionId = await resolveSession(chatId, userId)
      if (typeof settings.onAttachments !== 'function') {
        await send(chatId, messageId, t('attach.unsupported'))
        return
      }
      const result = await settings.onAttachments({ chatId, messageId, userId, attachments, sessionId: state.sessionId })
      await send(chatId, messageId, result?.summary ?? t('attach.received', { count: attachments.length }))
    } catch (error) {
      log('attachment handling failed:', error?.message ?? error)
      await send(chatId, messageId, t('attach.failed', { error: String(error?.message ?? error) }))
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
    const attachments = Array.isArray(message.attachments) ? message.attachments : []
    // 只发了文件、没有文字：交给收件处理，不要当成空消息丢掉。
    if (!raw && attachments.length > 0) {
      await handleAttachments({ chatId, messageId, userId, attachments })
      return
    }
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
        await send(chatId, messageId, t('ack.emptyPrefix', { prefix }))
        return
      }

      if (wantsDefer) {
        // 永远先入队再回执：这样"# 意味着不打断"在忙和闲两种情况下表现一致。
        // 空闲时 drainQueue 会立刻放行，所以用户看到的仍是马上执行。
        state.queue.push({ text: body, messageId })
        log('deferred (' + state.queue.length + ' queued, busy=' + isBusy(state) + ') -> ' + state.sessionId + ': ' + body.slice(0, 60))
        await send(chatId, messageId, settings.deferAckText ?? t('ack.defer'))
        await drainQueue(chatId, state)
        return
      }

      const wantSteer = wantsForceSteer || (isBusy(state) && settings.busyBehavior === 'steer')
      if (wantSteer) {
        const result = await plugin.steer({ sessionId: state.sessionId, text: body })
        // 记下这句话：它会在会话里以 user/message 事件回来，回显时必须认出来。
        state.ownSteer = { text: body.trim(), until: Date.now() + 15000 }
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
        await send(chatId, messageId, settings.steerAckText ?? t('ack.steer'))
        return
      }

      if (state.inFlight) {
        await send(chatId, messageId, t('ack.queued'))
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
      await send(chatId, messageId, t('reply.failed', { error: String(error?.message ?? error) }))
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
    if (affected.length === 0) {
      // 桌面端发起的轮次：这个会话还没被任何入站消息登记过，靠配置反推 chat。
      const chatId = await chatIdForSession(event.sessionId)
      if (!chatId) return
      const state = chatState(chatId)
      if (!state.sessionId) state.sessionId = event.sessionId
      affected.push([chatId, state])
    }

    for (const [chatId, state] of affected) {
      if (event.event === 'user-message') {
        // 桌面端有人说话：如果这个聊天开了镜像，就把内容推过去。
        // 我们自己刚从飞书注入的话，绝不能当成桌面输入回显回来。
        // rpcId 那条路（插件侧 rememberInjection）是主力，这里按文本兜底：
        // 注入是异步的，事件回来时 rpcId 万一对不上，文本和时间也对得上。
        const ownText = state.ownSteer?.text
        const isOwnSteer =
          typeof ownText === 'string' && ownText === String(event.text ?? '').trim() && Date.now() < (state.ownSteer?.until ?? 0)
        if (isOwnSteer) {
          state.ownSteer = null
          log('mirror skipped (own steer echoed back)')
          continue
        }
        if (mirrorEnabled(chatId) && isFresh(event)) {
          state.mirrorPending = true
          log('mirror desktop message -> ' + chatId)
          await send(chatId, undefined, t('mirror.user', { text: event.text }))
        } else {
          log('mirror skipped (enabled=' + mirrorEnabled(chatId) + ' fresh=' + isFresh(event) + ')')
        }
        continue
      }
      if (event.event === 'turn-start') {
        state.observedTurn = true
        state.lastActivityAt = Date.now()
        if (Number.isFinite(Number(event.turn))) state.lastTurn = Number(event.turn)
        if (state.mirrorPending) {
          state.mirrorTurn = Number(event.turn)
          state.mirrorPending = false
        }
        // 轮次来源：飞书发起的（inFlight）与桌面端发起的，进度卡规则不同。
        state.turnOrigin = state.inFlight ? 'feishu' : 'desktop'
        // 两个开关是正交的：
        //   /progress 决定"要不要看进度"，/mirror 决定"桌面端的事要不要出现在飞书"。
        // 桌面端发起的轮次，只有 mirror 开着才推进度卡——否则进度卡本身就是在泄露桌面活动。
        const desktopProgressAllowed = state.turnOrigin === 'desktop' && mirrorEnabled(chatId) && settings.progressAllTurns !== false
        if ((state.turnOrigin === 'feishu' || desktopProgressAllowed) && progressEnabled(chatId)) {
          stopProgressTimers(state)
          state.progress = createProgress(event.turn)
          startProgressHeartbeat(chatId, state)
        }
        continue
      }
      if (event.event === 'assistant' && event.text) {
        state.observedTurn = true
        state.lastActivityAt = Date.now()
        if (state.suppressUntilTurnEnd) continue
        // 事件顺序不固定：有时 turn/start 先到、user/message 后到（实测桌面端就是这样），
        // 那种情况下 turn/start 时还没有"要镜像"的标记。所以这里也认领一次：
        // 谁先看到标记谁把它绑定到当前轮次。
        if (state.mirrorPending) {
          state.mirrorTurn = Number(event.turn)
          state.mirrorPending = false
        }
        // 桌面端发起的轮次：默认不推送；开了镜像才推。
        const isMirrorTurn = state.mirrorTurn !== null && Number(event.turn) === state.mirrorTurn && mirrorEnabled(chatId)
        if (!isMirrorTurn && (!state.inFlight || !(event.turn > state.afterTurn))) continue
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
        if (state.progress && !state.progress.finished && progressEnabled(chatId)) {
          if (event.event === 'tool-call') {
            recordToolCall(state.progress, { name: event.name, callId: event.callId, args: event.arguments, description: event.description })
          } else {
            recordToolResult(state.progress, { callId: event.callId })
          }
          scheduleProgress(chatId, state)
        }
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
        // 先收进度卡：桌面端发起的轮次不走下面的回复逻辑，但进度卡必须收尾。
        if (state.progress) {
          state.progress.finished = true
          stopProgressTimers(state)
          await flushProgress(chatId, state, { final: true })
          state.progress = null
        }
        if (!isOurs) {
          // A deferred message waits for ANY turn to finish, including one started
          // from the desktop — that is the whole point of `#`.
          await drainQueue(chatId, state)
          continue
        }
        state.inFlight = false
        state.mirrorTurn = null
        state.mirrorPending = false
        const replyTo = state.replyTo
        if (settings.deliver === 'buffered') {
          const text = await flush(chatId, state)
          await send(chatId, replyTo, text || t('reply.empty'))
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
    /** 退出时清理：停掉所有聊天的进度卡定时器。 */
    dispose() {
      for (const state of chats.values()) {
        try {
          stopProgressTimers(state)
        } catch {}
        state.progress = null
      }
    },
    /** 卡片回调（模型 / 权限选项卡）。 */
    handleCardAction,
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

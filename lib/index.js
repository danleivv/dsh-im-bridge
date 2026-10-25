/**
 * dsh-im-bridge — a private DeepSeek Harness plugin.
 *
 * v0.1 scope:
 *   DOWN  (outbox -> session)  take a job file from an outbox directory and put
 *                              its text into a session as a real user message.
 *   UP    (session -> inbox)   subscribe to committed `session/event` facts and
 *                              append the assistant's committed messages to inbox.
 *
 * SAFETY (learned the hard way, 2026-10-18/19):
 *   `agent.followup()` stores its payload VERBATIM as a durable
 *   `agent/inbox/spliced` entry, which is later folded into a `user/message`
 *   event. DSH adds NOTHING: `role` and `id` must come from the caller. (The web
 *   client supplies both itself — compare its splice, which carries
 *   `"role":"user"` and `"id":"<uuid>"`.) A committed user/message without `role`
 *   makes the provider reject the WHOLE request:
 *
 *       Failed to deserialize the JSON body into the target type:
 *       messages[N]: missing field `role`
 *
 *   and because the event stays in the history, that session is poisoned for
 *   every later turn. Three hard rules follow:
 *     1. buildPayload() is the ONLY way this plugin creates an injected message;
 *        it always sets `role` and a fresh `id`.
 *     2. NEVER inject into a session the operator did not name explicitly:
 *        `allowSessions` defaults to an empty list, which refuses every job.
 *     3. Test on a throwaway session first; tools/repair-session.mjs can patch a
 *        role-less event back to health if one ever lands.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createFileSeenStore } from './seen-store.mjs'
import { createSendFileTool } from './feishu-tool.mjs'
import Schema from 'schemastery'
import { writeLastChat, readProgressPrefs, writeProgressPrefs, readMirrorPrefs, writeMirrorPrefs } from './gateway-config.mjs'
import { LANGUAGES, normalizeLanguage, createTranslator } from './i18n.mjs'
import { blocksToText, userMessageText } from './session-text.mjs'
import { normalizePresets } from './permissions.mjs'
import { resolveInboxDir, saveAttachment, asImagePayload, mediaTypeForName, MAX_FILE_BYTES } from './inbox.mjs'

export const name = 'dsh-im-bridge'

/** Required services. `agents` is the live-agent registry from dsh-agent. */
export const inject = ['agents', 'tools']

/**
 * 插件配置：DSH 设置界面按这个 schema 渲染表单。
 * union 会被画成下拉框——只列两种语言，填别的值校验不过。
 */
export const Config = Schema.object({
  language: Schema.union(LANGUAGES.map((item) => item.label))
    .default('中文')
    .description('飞书里的输出语言（只影响发到飞书的文字，不影响日志）/ Output language in Feishu'),
})

const DEFAULTS = {
  root: join(homedir(), '.dsh-im-bridge'),
  pollMs: 1000,
  agentOptions: undefined,
  /** Session ids the operator explicitly allows this plugin to write into. Empty = refuse everything. */
  allowSessions: [],
  /**
   * Reply capture is OFF by default: while it is off this plugin registers NO
   * `session/event` listener and writes nothing, so an idle install cannot
   * interfere with the Host's event dispatch.
   */
  captureReplies: false,
  /** 'all' or an array of session ids to capture replies for (only used when captureReplies is true). */
  captureSessions: 'all',
  /**
   * Local IPC for external consumers: a client speaks to
   * this listener, and THIS plugin performs the injection from inside the Host,
   * so no launch token and no cross-process write lease are involved.
   * Disabled by default; the listener binds loopback only, never 0.0.0.0.
   */
  ipc: {
    enabled: false,
    host: '127.0.0.1',
    port: 9811,
    /** Optional shared secret; when set, every request must carry `token`. */
    token: null,
  },
  /**
   * Maps an opaque external key (e.g. a chat key such as
   * "feishu:oc_…:ou_…") to a DSH session id, so a consumer can attach by key.
   */
  sessionKeys: {},
}

let logFile = join(DEFAULTS.root, 'bridge.log')

function log(...args) {
  const text = args
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join(' ')
  const line = '[dsh-im-bridge] ' + text
  console.log(line)
  try {
    appendFileSync(logFile, new Date().toISOString() + ' ' + line + '\n')
  } catch {
    // never let logging break the bridge
  }
}

function asAgent(candidate) {
  if (!candidate) return undefined
  return candidate.agent ?? candidate
}

function listJson(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
}

function sessionIdOf(item) {
  const agent = asAgent(item)
  const session = agent?.session
  return session?.id ?? session?.header?.id ?? (typeof item === 'string' ? item : undefined)
}

/** Flatten the text blocks of a committed message. */
export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  // 原生工具：agent 直接调用发文件，不经过 shell，因此不受当前目录、PATH 与引号转义影响。
  // 注册失败不能让整个插件起不来——命令行入口仍然可用。
  try {
    if (typeof ctx.tools?.register === 'function') {
      ctx.tools.register(createSendFileTool({ root: String(config.root), log }))
    }
  } catch (error) {
    log('tool registration skipped:', error?.message ?? error)
  }
  const root = String(config.root)
  const outbox = join(root, 'outbox')
  const done = join(root, 'done')
  const failed = join(root, 'failed')
  const inbox = join(root, 'inbox')
  const statusFile = join(root, 'status.json')
  const allow = Array.isArray(config.allowSessions) ? config.allowSessions : []

  /**
   * Mutable knobs are re-read from <root>/config.json on every request, so the
   * operator can change the write allowlist or the session bindings WITHOUT
   * restarting the Host. That matters because this is a `link:` package: code and
   * profile config only take effect on restart, and a restart also drags the web
   * client with it (see the mid-turn-input incident of 2026-10-18).
   *
   * Only keys present in that file override the static config; a missing file
   * means "use the profile config as-is".
   */
  const runtimeConfigFile = join(root, 'config.json')
  /** Feishu credentials + gateway knobs. Read at startup only (secrets belong here). */
  const gatewayConfigFile = join(root, 'gateway.json')
  /** Durable de-duplication shared by the in-process gateway. */
  let seenStore = null
  /** Handle for the in-process Feishu connection, so dispose can close it. */
  let gatewayHandle = null
  /** 网关本体：退出时要清理它持有的定时器。 */
  let gatewayObject = null
  function runtimeConfig() {
    try {
      return JSON.parse(readFileSync(runtimeConfigFile, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') log('config.json ignored:', error?.message ?? error)
      return {}
    }
  }
  const effectiveAllowlist = () => {
    const runtime = runtimeConfig()
    return Array.isArray(runtime.allowSessions) ? runtime.allowSessions : allow
  }
  const effectiveSessionKeys = () => ({ ...(config.sessionKeys ?? {}), ...(runtimeConfig().sessionKeys ?? {}) })

  logFile = join(root, 'bridge.log')

  for (const dir of [root, outbox, done, failed, inbox]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      log('mkdir failed', dir, error?.message ?? error)
    }
  }
  log('loaded. root=' + root)
  log('write allowlist (' + allow.length + '): ' + (allow.join(', ') || '(empty - every job will be refused)'))
  log('runtime config: ' + (existsSync(runtimeConfigFile) ? runtimeConfigFile + ' (hot-reloaded per request)' : '(none; using the profile config)'))

  // ---- 1) inventory -------------------------------------------------------
  const status = {
    loadedAt: new Date().toISOString(),
    pid: process.pid,
    root,
    allowSessions: allow,
    liveAgents: [],
    services: {},
    capture: 'unknown',
  }

  // status.json is also rewritten when the IPC listener finishes binding, since
  // listen() completes asynchronously after apply() has already returned.
  const writeStatus = () => {
    try {
      writeFileSync(statusFile, JSON.stringify(status, null, 2) + '\n')
    } catch (error) {
      log('could not write status.json:', error?.message ?? error)
    }
  }

  try {
    const live = ctx.agents.list?.() ?? []
    status.liveAgents = live.map(sessionIdOf).filter(Boolean)
  } catch (error) {
    status.agentsListError = error?.message ?? String(error)
  }
  log('live agents (' + status.liveAgents.length + '): ' + (status.liveAgents.join(', ') || '(none)'))

  for (const key of ['sessions', 'sessionQuery']) {
    const service = ctx.get?.(key)
    if (!service) {
      status.services[key] = 'not available'
      continue
    }
    const listFn = service.list ?? service.page
    if (typeof listFn !== 'function') {
      status.services[key] = 'no list()/page()'
      continue
    }
    try {
      const value = listFn.call(service)
      status.services[key] = Array.isArray(value) ? value.length + ' items' : typeof value
    } catch (error) {
      status.services[key] = 'list failed: ' + (error?.message ?? String(error))
    }
  }

  // ---- 2) resolve an injectable agent for an allowlisted session ----------
  /**
   * Is this instance's service context still usable?
   *
   * A reloaded plugin can leave the previous instance listening on the port with a
   * dead context; `hello` used to answer ipcBound=true regardless, which reads as
   * "healthy" while every real operation fails. Probing here makes `?status` and
   * bridge-health able to say "the plugin needs a Host restart".
   */
  function liveProbe() {
    try {
      const live = ctx.agents.list?.() ?? []
      return { liveAgents: live.map(sessionIdOf).filter(Boolean), agentServiceError: null }
    } catch (error) {
      return { liveAgents: null, agentServiceError: error?.message ?? String(error) }
    }
  }

  /**
   * Build the `setup` callback the DESKTOP uses when it activates a session.
   *
   * `ctx.agents.resume()` alone does NOT install the agent's tools: it only reopens
   * the persisted session. The desktop pairs it with `composition.setup`, which
   * calls `agentPresets.mount(agentCtx, presetId)` — that mount is what installs the
   * tool set (32 tools for this app). Without it a resumed agent gets 2 tools and
   * every call fails with `Error: unknown tool "pwsh"`.
   *
   * Source: dsh-api-session-controller, ApiSessionAgentController.composeAgent():
   *   const resolvedId = (await presets.resolve(presetId)).id
   *   setup: async (agentCtx, agent) => { installSelection(agent); await presets.mount(agentCtx, resolvedId) }
   *
   * @returns {Promise<{setup?: Function, presetId?: string, reason?: string}>}
   */
  async function composeForResume(sessionId) {
    const presets = ctx.get?.('agentPresets')
    if (!presets || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') {
      return { reason: 'agentPresets service unavailable' }
    }
    let presetId
    try {
      const query = ctx.get?.('sessionQuery')
      const observation = await query.observeSession(sessionId)
      // The preset is a Session projection, not a header field.
      presetId = observation?.projections?.values?.agentPreset
    } catch (error) {
      return { reason: 'cannot read session projection: ' + (error?.message ?? error) }
    }
    try {
      const resolvedId = (await presets.resolve(presetId)).id
      return {
        presetId: resolvedId,
        setup: async (agentCtx, agent) => {
          installSelection(agent)
          await presets.mount(agentCtx, resolvedId)
        },
      }
    } catch (error) {
      return { reason: 'preset resolve/mount failed: ' + (error?.message ?? error) }
    }
  }

  /** Install the model route into an agent's selection projection (desktop parity). */
  function installSelection(agent) {
    try {
      const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (!selection?.provider || !selection?.model) return
      agent?.setModelSelection?.({
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      })
    } catch (error) {
      log('installSelection failed (non-fatal):', error?.message ?? error)
    }
  }

  async function resolveAgent(sessionId) {
    if (!sessionId) throw new Error('job.sessionId is required')
    // Re-read on every call: the allowlist is hot-reloadable via <root>/config.json.
    const allowList = effectiveAllowlist()
    if (!allowList.includes(sessionId)) throw new Error('session not in allowSessions: ' + sessionId)
    const existing = asAgent(ctx.agents.get?.(sessionId))
    if (existing) return { agent: existing, how: 'live' }

    // Compose first: if we can install the real tool set, resuming is safe.
    const composition = await composeForResume(sessionId)
    const hotCfg = runtimeConfig()
    const resumeAllowed = hotCfg.allowResume === undefined ? config.allowResume === true : hotCfg.allowResume === true
    if (!composition.setup && !resumeAllowed) {
      // 2026-10-20: a resume WITHOUT composition produced a 2-tool agent and every
      // tool call failed with `Error: unknown tool "pwsh"`. Refusing beats silently
      // degrading the operator's real session.
      throw new Error(
        'cannot inject into ' + sessionId + ': it is not open in the desktop, and a proper resume is unavailable (' +
          (composition.reason ?? 'no composition') +
          '). Open that session in the desktop app and retry, or set {"allowResume": true} in ' +
          runtimeConfigFile +
          ' to resume anyway (degraded tool set).',
      )
    }

    // dsh-agent-loop's resumeWith() reads `options.resumeSessionId` — NOT
    // `sessionId`. With the wrong key the id stays undefined and the failure only
    // surfaces deep inside session persistence as
    //   TypeError: Cannot read properties of undefined (reading 'length')
    //     at encodeSegment (dsh-session-persistence-jsonl)
    // The key name is therefore load-bearing and covered by a test.
    const configured = hotCfg.agentOptions ?? config.agentOptions
    let agentOptions = configured
    try {
      // Prefer the desktop's CURRENT selection so a resumed agent matches the model
      // the operator sees, instead of a value copied into config.json days ago.
      const live = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (live?.provider && live?.model) {
        agentOptions = {
          provider: live.provider,
          model: live.model,
          ...(live.reasoningEffort === undefined ? {} : { reasoningEffort: live.reasoningEffort }),
        }
      }
    } catch {}
    if (!agentOptions && !composition.setup) {
      // No route and no composition: such an agent stays live and every turn fails
      // with `prompt variable "{{model}}" has no value` and cannot be repaired.
      throw new Error(
        'cannot resume ' + sessionId + ': no agentOptions configured and no composition available. ' +
          'Add "agentOptions": {"provider":"…","model":"…"} to ' + runtimeConfigFile,
      )
    }
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(composition.setup === undefined ? {} : { setup: composition.setup }),
    })
    const resumed = asAgent(handle)
    if (!resumed) throw new Error('resume returned no agent for ' + sessionId)
    // Keep the handle: it is the only object that can dispose this agent, and a
    // broken resume used to strand a live-but-unusable agent in the Host.
    resumedHandles.set(sessionId, handle)
    log(
      'resume -> ' + sessionId + '  preset=' + (composition.presetId ?? '(none)') +
        '  composed=' + Boolean(composition.setup) + '  model=' + (agentOptions ? agentOptions.provider + '/' + agentOptions.model : '(default)'),
    )
    return { agent: resumed, how: 'resumed', composed: Boolean(composition.setup), presetId: composition.presetId }
  }

  /**
   * Build the payload for `agent.followup()`.
   *
   * DSH stores this payload VERBATIM as a durable `agent/inbox/spliced` entry and
   * later folds it into a `user/message` event. It does NOT add `role` or `id`:
   * the web client supplies both itself (its splice carries `"role":"user"` and
   * `"id":"<uuid>"`). A user/message without `role` poisons the session — the
   * provider then rejects every later request with
   *
   *     messages[N]: missing field `role`
   *
   * so both fields are mandatory here. `followupTemplate` in <root>/config.json can
   * add further fields WITHOUT a Host restart, which keeps this debuggable.
   */
  function buildPayload(text) {
    const template = runtimeConfig().followupTemplate ?? {}
    const source = { kind: 'user', rpcId: randomUUID(), ...(template.source ?? {}) }
    return {
      ...template,
      content: [{ type: 'text', text }],
      source,
      role: template.role ?? 'user',
      id: randomUUID(), // unique per message, never reused across turns
    }
  }

  /**
   * Inject a normal next-turn message.
   *
   * Shared by the IPC `prompt` op and the in-process gateway: when both paths had
   * their own copy, any fix had to be written twice (and drift was invisible).
   */
  /** permissionPresets 服务（不存在时返回 null，上层给明确错误）。 */
  function permissionPresetsService() {
    try {
      return ctx.get('permissionPresets') ?? null
    } catch (error) {
      log('permissionPresets unavailable:', error?.message ?? error)
      return null
    }
  }

  /** 可选权限 + 当前值。 */
  async function listPermissionChoices(sessionId) {
    const service = permissionPresetsService()
    let presets = []
    try {
      presets = normalizePresets(await service?.catalog?.())
    } catch (error) {
      log('preset catalog failed:', error?.message ?? error)
    }
    let current = null
    try {
      const live = asAgent(ctx.agents.get?.(sessionId))
      if (live?.session && typeof service?.current === 'function') current = service.current(live.session) ?? null
    } catch (error) {
      log('preset current failed:', error?.message ?? error)
    }
    return { presets, current }
  }

  /** 切换会话权限（写 permission/preset 与 sandbox/mode 两个会话事件）。 */
  async function setPermissionForSession(sessionId, preset) {
    const service = permissionPresetsService()
    if (typeof service?.set !== 'function') throw new Error('permissionPresets 服务不可用，无法切换权限')
    const live = asAgent(ctx.agents.get?.(sessionId))
    if (!live?.session) throw new Error('会话没打开（不是 live），无法切换权限')
    await service.set(live.session, preset)
    log('permission -> ' + sessionId + ' ' + preset)
    return { ok: true, preset }
  }

  /** 会话的工作目录（收件箱默认放在这里）。 */
  function sessionCwd(sessionId) {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      const live = asAgent(ctx.agents.get?.(sessionId))
      if (workingDirectory?.get && live?.session) return workingDirectory.get(live.session) ?? null
    } catch (error) {
      log('cwd lookup failed:', error?.message ?? error)
    }
    return null
  }

  /** 注入一个自定义 content 数组的消息（图片块 + 文本）。 */
  async function injectContent(sessionId, content) {
    if (!Array.isArray(content) || content.length === 0) throw new Error('content is required')
    const { agent, how } = await resolveAgent(sessionId)
    const afterTurn = lastTurns.get(sessionId) ?? 0
    const template = runtimeConfig().followupTemplate ?? {}
    const payload = {
      ...template,
      content,
      source: { kind: 'user', rpcId: randomUUID(), ...(template.source ?? {}) },
      role: template.role ?? 'user',
      id: randomUUID(),
    }
    rememberInjection(payload.source?.rpcId)
    await agent.followup(payload)
    log('files -> ' + sessionId + ' (' + how + '): ' + content.length + ' block(s)')
    return { sessionId, accepted: true, afterTurn, how }
  }

  /**
   * 我们自己注入过的消息编号。
   *
   * 系统不记录"这条消息从哪来"，所以回显时必须靠这张表把飞书发来的消息认出来，
   * 否则会把用户刚发的内容再复读一遍。
   */
  const injectedRpcIds = new Set()
  function rememberInjection(rpcId) {
    if (!rpcId) return
    injectedRpcIds.add(rpcId)
    // 简单封顶：只需要覆盖最近这段时间的注入。
    if (injectedRpcIds.size > 500) {
      const oldest = injectedRpcIds.values().next().value
      injectedRpcIds.delete(oldest)
    }
  }

  async function injectPrompt(sessionId, text) {
    const body = String(text ?? '')
    if (!body) throw new Error('text is required')
    const { agent, how } = await resolveAgent(sessionId)
    // Capture the watermark BEFORE injecting: the reply the caller wants is the
    // first turn that ends after this number.
    const afterTurn = lastTurns.get(sessionId) ?? 0
    const payload = buildPayload(body)
    rememberInjection(payload.source?.rpcId)
    await agent.followup(payload)
    log('prompt -> ' + sessionId + ' (' + how + '): ' + body.slice(0, 60))
    return { sessionId, accepted: true, afterTurn, how }
  }

  /**
   * Inject next-STEP input (mid-turn):
   * `steer()` submits it against the RUNNING turn and wakes the driver, which is
   * the capability the agent runtime cannot express itself (a prompt always means "run
   * another turn").
   */
  async function injectSteer(sessionId, text) {
    const body = String(text ?? '').trim()
    if (!body) throw new Error('text is required')
    const { agent, how } = await resolveAgent(sessionId)
    if (typeof agent.steer !== 'function') throw new Error('this agent has no steer()')
    try {
      await agent.steer(buildPayload(body))
      log('steer -> ' + sessionId + ' (' + how + '): ' + body.slice(0, 60))
      return { sessionId, injected: true, via: 'steer', how }
    } catch (error) {
      // steer() is admitted against the running turn; idle it can be refused.
      // Degrade to an ordinary queued message so a '#' from the phone never fails.
      log('steer refused, falling back to followup:', error?.message ?? error)
      // Capture the watermark like injectPrompt does: the caller must know which
      // turn is theirs, otherwise the fallback's reply is never flushed.
      const afterTurn = lastTurns.get(sessionId) ?? 0
      await agent.followup(buildPayload(body))
      return { sessionId, accepted: true, via: 'followup', afterTurn, steerError: String(error?.message ?? error), how }
    }
  }

  async function runJob(file) {
    const path = join(outbox, file)
    let job
    try {
      job = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      log('bad job ' + file + ':', error?.message ?? error)
      try { renameSync(path, join(failed, file)) } catch {}
      return
    }
    const text = String(job.text ?? '')
    if (!text) {
      log('job ' + file + ' carries no text')
      try { renameSync(path, join(failed, file)) } catch {}
      return
    }
    try {
      const { agent, how } = await resolveAgent(job.sessionId)
      await agent.followup(buildPayload(text))
      log('injected into ' + job.sessionId + ' (' + how + '): ' + text.slice(0, 60))
      try { renameSync(path, join(done, file)) } catch {}
    } catch (error) {
      log('inject refused/failed for ' + file + ':', error?.message ?? error)
      try { renameSync(path, join(failed, file)) } catch {}
    }
  }

  // ---- 3) downlink: outbox poller ----------------------------------------
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    const files = listJson(outbox)
    if (files.length === 0) return
    busy = true
    ;(async () => {
      try {
        for (const file of files) await runJob(file)
      } finally {
        busy = false
      }
    })()
  }, Number(config.pollMs) || 1000)
  if (typeof timer.unref === 'function') timer.unref()

  // ---- 4) local IPC: the way external consumers drive this Host ----------------
  // A consumer connects here; THIS plugin performs the
  // injection from inside the Host, so no launch token and no cross-process
  // write lease are involved. Loopback only, and still allowlist-gated.
  const ipcConfig = { ...DEFAULTS.ipc, ...(config.ipc ?? {}) }
  /** sessionId -> Set<socket> that asked for that session's events */
  const attached = new Map()
  /**
   * sessionId -> the number of the last turn we saw END.
   *
   * A message handed to followup() is admitted at the NEXT turn boundary, so the
   * reply the caller wants is the first `turn-end` whose number is greater than
   * this watermark. Without it a caller waiting on a turn could be satisfied by
   * somebody else's turn finishing (the desktop and the phone share one session).
   */
  const lastTurns = new Map()
  /**
   * sessionId -> the AgentHandle returned by resume(). We are the only owner of
   * that capability, so keeping it is what makes `dispose` possible: without it a
   * bad resume leaves a live agent nothing can tear down.
   */
  const resumedHandles = new Map()

  function resolveSessionId(request) {
    if (request?.sessionId) return String(request.sessionId)
    if (request?.key) {
      const mapped = effectiveSessionKeys()[String(request.key)]
      if (mapped) return String(mapped)
      throw new Error('no sessionKeys entry for key ' + request.key)
    }
    throw new Error('request needs sessionId or key')
  }

  /**
   * In-process event consumers: the built-in Feishu gateway subscribes here instead
   * of opening a socket to ourselves. Same events, no IPC hop.
   */
  const inProcessListeners = new Set()

  /**
   * 工具调用的人类可读描述（DSH 输入框显示的就是这个）。
   *
   * 它在 arguments JSON 里，但排在 command 之后，转发时 600 字符的截断会把它切掉，
   * 所以单独提出来发。
   */
  function toolDescription(args) {
    if (typeof args !== 'string') return undefined
    try {
      const parsed = JSON.parse(args)
      const text = parsed?.description
      return typeof text === 'string' && text !== '' ? text.slice(0, 160) : undefined
    } catch {
      return undefined
    }
  }

  function fanOut(sessionId, payload) {
    for (const listener of inProcessListeners) {
      try {
        listener(payload)
      } catch (error) {
        log('in-process listener failed:', error?.message ?? error)
      }
    }
    const sockets = attached.get(sessionId)
    if (!sockets || sockets.size === 0) return
    const line = JSON.stringify(payload) + '\n'
    for (const socket of sockets) {
      try {
        socket.write(line)
      } catch {
        // a dead socket is cleaned up by its own close handler
      }
    }
  }

  const ipcStatus = {
    enabled: ipcConfig.enabled === true,
    bound: false,
    host: ipcConfig.host,
    port: Number(ipcConfig.port) || 9811,
    clients: 0,
  }

  let ipcServer
  if (ipcConfig.enabled === true) {
    /** 所有 IPC 连接：server.close() 只停止接受新连接，已连上的必须主动断开。 */
  const ipcSockets = new Set()
  ipcServer = createServer((socket) => {
    ipcSockets.add(socket)
    socket.on('close', () => ipcSockets.delete(socket))
    socket.on('error', () => {
      ipcSockets.delete(socket)
      try {
        socket.destroy()
      } catch {}
    })
      ipcStatus.clients += 1
      const mine = new Set()
      const reply = (obj) => {
        try {
          socket.write(JSON.stringify(obj) + '\n')
        } catch {}
      }
      const detach = (sessionId) => {
        mine.delete(sessionId)
        const sockets = attached.get(sessionId)
        if (sockets) {
          sockets.delete(socket)
          if (sockets.size === 0) attached.delete(sessionId)
        }
      }
      const attach = (sessionId) => {
        mine.add(sessionId)
        if (!attached.has(sessionId)) attached.set(sessionId, new Set())
        attached.get(sessionId).add(socket)
      }
      const release = () => {
        for (const sessionId of [...mine]) detach(sessionId)
      }

      socket.setEncoding('utf8')
      socket.on('close', () => {
        ipcStatus.clients -= 1
        release()
      })
      socket.on('error', release)

      const handle = async (line) => {
        let request
        try {
          request = JSON.parse(line)
        } catch {
          reply({ ok: false, error: 'bad JSON' })
          return
        }
        const id = request.id
        const fail = (message) => reply({ id, ok: false, error: String(message) })
        try {
          if (ipcConfig.token != null && request.token !== ipcConfig.token) return fail('bad token')
          switch (request.op) {
            case 'hello':
              return reply({
                id,
                ok: true,
                pid: process.pid,
                allowSessions: effectiveAllowlist(),
                sessionKeys: Object.keys(effectiveSessionKeys()),
                // Enough for `?status` to answer from the phone without reading logs.
                ipcBound: ipcStatus.bound,
                ipcClients: ipcStatus.clients,
                lastTurns: Object.fromEntries(lastTurns),
                // Liveness of THIS instance's service context. After a plugin reload
                // the old instance can keep holding the port while its context is
                // dead — every ctx.agents call then fails with
                //   cannot get required service "agents" in inactive context
                // and callers that only look at ipcBound=true are misled.
                ...liveProbe(),
              })
            case 'list':
              return reply({
                id,
                ok: true,
                sessions: (ctx.agents.list?.() ?? []).map(sessionIdOf).filter(Boolean),
              })
            // Read-only: what is this session doing right now?
            case 'activity': {
              const sessionId = resolveSessionId(request)
              if (!effectiveAllowlist().includes(sessionId)) {
                return fail('session not in allowSessions: ' + sessionId)
              }
              const snapshot = activityFor(sessionId)
              return reply({
                id,
                ok: true,
                sessionId,
                jobs: snapshot.jobs.map((job) => ({ ...job, elapsed: formatDuration(job.elapsedMs) })),
                subagents: snapshot.subagents.map((agent) => ({ ...agent, elapsed: formatDuration(agent.elapsedMs) })),
              })
            }
            // Read-only self-check of the IN-PROCESS adapter.
            //
            // The in-process gateway talks to this plugin through selfPort() rather
            // than through a socket, so a scoping mistake there (calling a per-socket
            // closure such as `attach`) is invisible to the IPC tests until a real
            // Feishu message arrives. This op exercises the adapter on demand.
            case 'selfcheck': {
              const port = selfPort()
              const info = await port.hello()
              const keys = info.sessionKeys ?? []
              let attached = null
              let attachError = null
              if (keys.length > 0) {
                try {
                  attached = await port.attach({ key: keys[0] })
                } catch (error) {
                  attachError = String(error?.message ?? error)
                }
              }
              return reply({
                id,
                ok: attachError === null,
                ...(attachError === null ? {} : { error: attachError }),
                pid: info.pid,
                sessionKeys: keys,
                sampleSession: attached?.sessionId ?? null,
                liveAgents: info.liveAgents,
                agentServiceError: info.agentServiceError ?? null,
              })
            }
            case 'attach': {
              const sessionId = resolveSessionId(request)
              attach(sessionId)
              return reply({ id, ok: true, sessionId, attached: true })
            }
            // Release an agent this plugin resumed, so a broken one can be replaced
            // instead of blocking the session with "already owned by an active
            // write handle". Persisted state survives; the next resume reloads it.
            case 'dispose': {
              const sessionId = resolveSessionId(request)
              const handle = resumedHandles.get(sessionId)
              if (!handle) {
                return fail('no retained handle for ' + sessionId + ' (this plugin did not resume that agent)')
              }
              try {
                await handle.dispose?.()
              } catch (error) {
                return fail('dispose failed: ' + (error?.message ?? error))
              }
              resumedHandles.delete(sessionId)
              log('ipc dispose -> ' + sessionId)
              return reply({ id, ok: true, sessionId, disposed: true })
            }
            // Diagnostic probe: dsh-agent forwards `options` verbatim to the
            // driver factory, so trying shapes live beats guessing and restarting.
            // Allowlist-gated like every other write-capable op.
            case 'resume': {
              const sessionId = String(request.sessionId ?? '')
              if (!sessionId) return fail('sessionId is required')
              if (!effectiveAllowlist().includes(sessionId)) {
                return fail('session not in allowSessions: ' + sessionId)
              }
              const options = request.options ?? { sessionId }
              try {
                const raw = await ctx.agents.resume(options)
                const handle = asAgent(raw)
                // Keep the raw handle so `dispose` can release an agent created by a
                // probe — a resumed agent has an incomplete tool set, so being able
                // to dispose it is what makes the probe safe to run at all.
                if (raw) resumedHandles.set(sessionIdOf(handle) ?? sessionId, raw)
                return reply({
                  id,
                  ok: true,
                  sessionId: sessionIdOf(handle) ?? sessionId,
                  resumed: Boolean(handle),
                  hasFollowup: typeof handle?.followup === 'function',
                })
              } catch (error) {
                // The factory's failure surfaces as a bare TypeError, so the stack
                // is the only way to tell which option it actually read.
                return reply({
                  id,
                  ok: false,
                  error: String(error?.message ?? error),
                  stack: String(error?.stack ?? '').split('\n').slice(0, 8).join(' | '),
                })
              }
            }
            case 'detach': {
              const sessionId = resolveSessionId(request)
              detach(sessionId)
              return reply({ id, ok: true, sessionId, attached: false })
            }
            case 'prompt': {
              const sessionId = resolveSessionId(request)
              const result = await injectPrompt(sessionId, request.text)
              return reply({ id, ok: true, ...result })
            }
            case 'steer': {
              const sessionId = resolveSessionId(request)
              const result = await injectSteer(sessionId, request.text)
              return reply({ id, ok: true, ...result })
            }
            case 'cancel': {
              const sessionId = resolveSessionId(request)
              const result = await cancelSession(sessionId)
              return result.ok ? reply({ id, ok: true, sessionId }) : fail(result.error)
            }
            case 'permissions': {
              const sessionId = resolveSessionId(request)
              const choices = await listPermissionChoices(sessionId)
              return reply({ id, ok: true, ...choices })
            }
            case 'setPermission': {
              const sessionId = resolveSessionId(request)
              if (!request.preset) return fail('需要 preset')
              const result = await setPermissionForSession(sessionId, request.preset)
              return reply({ id, ok: true, ...result })
            }
            case 'models': {
              const catalogue = await listModelChoices()
              return reply({ id, ok: true, ...catalogue })
            }
            case 'setModel': {
              const sessionId = resolveSessionId(request)
              if (!request.provider || !request.model) return fail('需要 provider 与 model')
              await selectModelForSession(sessionId, request.provider, request.model)
              return reply({ id, ok: true, sessionId, provider: request.provider, model: request.model })
            }
            default:
              return fail('unknown op: ' + request.op)
          }
        } catch (error) {
          return fail(error?.message ?? error)
        }
      }

      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (line.trim()) void handle(line)
        }
      })
    })

    ipcServer.on('error', (error) => log('ipc server error:', error?.message ?? error))
    const loopback = ipcConfig.host === '127.0.0.1' || ipcConfig.host === 'localhost' || ipcConfig.host === '::1'
    if (!loopback) {
      log('refusing to bind non-loopback IPC host: ' + ipcConfig.host)
    } else {
      /**
       * Bind with retries.
       *
       * On a plugin reload the new instance is constructed BEFORE the old one is
       * disposed, so the port is still held for a few milliseconds and a single
       * listen() loses the race permanently: the port then frees up, nobody is
       * listening, and the bridge silently dies until the Host restarts. Retrying
       * turns that race into a ~1s hiccup.
       */
      let attempt = 0
      const tryBind = () => {
        attempt += 1
        ipcServer.listen(ipcStatus.port, ipcConfig.host, () => {
          ipcStatus.bound = true
          log('ipc listening on ' + ipcConfig.host + ':' + ipcStatus.port + (attempt > 1 ? ' (attempt ' + attempt + ')' : ''))
          writeStatus()
        })
      }
      ipcServer.on('error', (error) => {
        if (error?.code !== 'EADDRINUSE') return
        if (attempt >= 12) {
          log('ipc giving up on port ' + ipcStatus.port + ' after ' + attempt + ' attempts: another instance still holds it')
          return
        }
        const delay = Math.min(250 * attempt, 2000)
        log('ipc port busy (attempt ' + attempt + '), retrying in ' + delay + 'ms')
        setTimeout(() => {
          if (!ipcStatus.bound) tryBind()
        }, delay)
      })
      tryBind()
    }
  }
  status.ipc = ipcStatus

  // ---- 5) session events -> inbox capture AND IPC fan-out -----------------
  // Registered ONLY when one of those consumers is enabled: an idle install
  // must add no listener at all to the Host's event dispatch.
  const capturing = config.captureReplies === true
  if (!capturing && ipcStatus.enabled !== true) {
    status.capture = 'disabled'
  } else if (typeof ctx.on !== 'function') {
    status.capture = 'unavailable'
  } else {
    ctx.on('session/event', (session, event) => {
      const sessionId = session?.header?.id
      const type = event?.type
      if (!sessionId || !type) return

      // Keep the watermark current for every session we can see, so a caller can
      // tell "the turn I caused" from "somebody else's turn".
      if (type === 'turn/end') {
        const turn = Number(event.data?.turn)
        if (Number.isFinite(turn)) lastTurns.set(sessionId, turn)
      }
      if (capturing && (config.captureSessions === 'all' || (Array.isArray(config.captureSessions) && config.captureSessions.includes(sessionId)))) {
        try {
          if (type === 'assistant/message') {
            const message = event.data?.message
            appendFileSync(
              join(inbox, sessionId + '.jsonl'),
              JSON.stringify({
                at: new Date().toISOString(),
                kind: 'assistant/message',
                sessionId,
                messageId: message?.id,
                turn: event.data?.turn,
                text: blocksToText(message?.content),
              }) + '\n',
            )
          } else if (type === 'turn/end') {
            appendFileSync(
              join(inbox, sessionId + '.jsonl'),
              JSON.stringify({
                at: new Date().toISOString(),
                kind: 'turn/end',
                sessionId,
                turn: event.data?.turn,
                reason: event.data?.reason,
              }) + '\n',
            )
          }
        } catch (error) {
          log('inbox write failed:', error?.message ?? error)
        }
      }

      // Fan out when either an IPC client attached this session OR something
      // in-process is listening (the built-in gateway). The old gate made an
      // in-process consumer receive nothing.
      // Activity bookkeeping runs regardless of who is attached: `?status` must be
      // able to say what a session is doing even when nobody is watching it.
      trackActivity(sessionId, type, event.data)
      if (!attached.has(sessionId) && inProcessListeners.size === 0) return
      try {
        if (type === 'user/message') {
          // 只转发"真人输入的文本"。agent-instructions / time-context / goal 这些是系统注入的，
          // 回显出去就是噪音。
          const source = event.data?.source ?? {}
          const text = userMessageText(event.data)
          const rpcId = source.rpcId
          if (source.kind === 'user' && text && !injectedRpcIds.has(rpcId)) {
            fanOut(sessionId, {
              event: 'user-message',
              sessionId,
              text,
              rpcId: String(rpcId ?? ''),
              time: Number(event.time ?? 0),
            })
          }
        } else if (type === 'turn/start') {
          // A gateway needs this to know a turn is ALREADY running (e.g. the desktop
          // started one) so it can steer instead of queueing behind it. Without it
          // "busy" can only be inferred from the first assistant/tool output.
          fanOut(sessionId, { event: 'turn-start', sessionId, turn: event.data?.turn })
        } else if (type === 'assistant/message') {
          const message = event.data?.message
          fanOut(sessionId, {
            event: 'assistant',
            sessionId,
            messageId: message?.id,
            turn: event.data?.turn,
            text: blocksToText(message?.content),
          })
        } else if (type === 'turn/end') {
          fanOut(sessionId, { event: 'turn-end', sessionId, turn: event.data?.turn, reason: event.data?.reason })
        } else if (type === 'tool/call') {
          // Progress visibility: a long turn used to be minutes of silence on the
          // phone as progress.
          const data = event.data ?? {}
          fanOut(sessionId, {
            event: 'tool-call',
            sessionId,
            turn: data.turn,
            step: data.step,
            callId: data.callId,
            name: data.name,
            description: toolDescription(data.arguments),
            arguments: typeof data.arguments === 'string' ? data.arguments.slice(0, 600) : undefined,
          })
        } else if (type === 'tool/result') {
          const data = event.data ?? {}
          const message = data.message ?? {}
          fanOut(sessionId, {
            event: 'tool-result',
            sessionId,
            turn: data.turn,
            step: data.step,
            callId: message?.toolCallId ?? message?.source?.callId ?? data.callId,
            isError: message?.isError === true,
            text: blocksToText(message?.content).slice(0, 800),
          })
        }
      } catch (error) {
        log('ipc fan-out failed:', error?.message ?? error)
      }
    })
    status.capture = 'subscribed'
  }

  /**
   * What is this session doing right now?
   *
   * Two independent sources, both from the session event stream:
   *
   *   - `job/registered` … `job/settled` — long-running shell jobs (kind=pwsh).
   *   - `tool/call` named subagent / subagent_fork without a matching `tool/result`
   *     — a child agent that has not reported back yet. Subagent creation has its own
   *     `subagent/catalog` event, but no completion event, so the tool call is the
   *     only reliable running/finished signal.
   *
   * A session with hundreds of finished jobs must not accumulate memory, so settled
   * entries are deleted, and both maps are pruned when they grow past a limit.
   */
  const runningJobs = new Map() //  `${sessionId}\u0000${jobId}` -> { sessionId, kind, label, startedAt }
  const runningTools = new Map() // `${sessionId}\u0000${callId}` -> { sessionId, name, label, startedAt }

  /** First line, collapsed, truncated: labels can be whole shell commands. */
  function summarise(text, limit = 80) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
    return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat
  }

  /** Pull a human description out of a subagent tool call's arguments. */
  function subagentLabel(args) {
    if (typeof args !== 'string') return summarise(args)
    try {
      const parsed = JSON.parse(args)
      return summarise(parsed.description ?? parsed.task ?? parsed.prompt ?? parsed.instructions ?? args)
    } catch {
      return summarise(args)
    }
  }

  function trackActivity(sessionId, type, data) {
    const now = Date.now()
    try {
      if (type === 'job/registered') {
        const jobId = String(data?.jobId ?? '')
        if (!jobId) return
        runningJobs.set(sessionId + '\u0000' + jobId, {
          sessionId,
          kind: data?.kind ?? 'job',
          label: summarise(data?.label ?? jobId),
          startedAt: Number(data?.startedAt ?? now),
        })
        if (runningJobs.size > 200) runningJobs.delete(runningJobs.keys().next().value)
        return
      }
      if (type === 'job/settled') {
        const jobId = String(data?.jobId ?? '')
        if (jobId) runningJobs.delete(sessionId + '\u0000' + jobId)
        return
      }
      if (type === 'tool/call') {
        const name = String(data?.name ?? '')
        if (!/^subagent/i.test(name)) return
        const callId = String(data?.callId ?? '')
        if (!callId) return
        runningTools.set(sessionId + '\u0000' + callId, {
          sessionId,
          name,
          label: subagentLabel(data?.arguments),
          startedAt: now,
        })
        if (runningTools.size > 200) runningTools.delete(runningTools.keys().next().value)
        return
      }
      if (type === 'tool/result') {
        const callId = String(data?.callId ?? data?.message?.toolCallId ?? data?.source?.callId ?? '')
        if (callId) runningTools.delete(sessionId + '\u0000' + callId)
        return
      }
      if (type === 'turn/end') {
        // A finished turn cannot leave a subagent tool call outstanding: DSH would
        // have produced a result. Clearing avoids stale "running" entries when a
        // result event was missed (restart, dropped listener).
        for (const [key, entry] of runningTools) {
          if (entry.sessionId === sessionId) runningTools.delete(key)
        }
      }
    } catch (error) {
      log('activity tracking failed:', error?.message ?? error)
    }
  }

  function formatDuration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 60) return seconds + 's'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return minutes + 'm' + (seconds % 60 ? (seconds % 60) + 's' : '')
    return Math.floor(minutes / 60) + 'h' + (minutes % 60 ? (minutes % 60) + 'm' : '')
  }

  /** Activity snapshot for one session. */
  function activityFor(sessionId) {
    const now = Date.now()
    const jobs = []
    const subagents = []
    for (const entry of runningJobs.values()) {
      if (entry.sessionId !== sessionId) continue
      jobs.push({ kind: entry.kind, label: entry.label, elapsedMs: now - entry.startedAt })
    }
    for (const entry of runningTools.values()) {
      if (entry.sessionId !== sessionId) continue
      subagents.push({ name: entry.name, label: entry.label, elapsedMs: now - entry.startedAt })
    }
    jobs.sort((a, b) => b.elapsedMs - a.elapsedMs)
    subagents.sort((a, b) => b.elapsedMs - a.elapsedMs)
    return { sessionId, jobs, subagents, at: now }
  }

  /** 停止一个会话当前正在跑的轮次。 */
  async function cancelSession(sessionId) {
    const live = asAgent(ctx.agents.get?.(sessionId))
    if (!live) return { ok: false, error: '会话没打开（不是 live），没有可停的轮次' }
    if (typeof live.cancel !== 'function') return { ok: false, error: '该会话不支持取消' }
    await live.cancel({ kind: 'user' })
    log('cancel -> ' + sessionId)
    return { ok: true }
  }

  /**
   * 可用模型清单 + 当前默认选择。
   *
   * `ctx.llm` 是 provider 注册表：listProviders() 给路由，listModels() 给该路由下的模型。
   * 某条路由临时不可用时只跳过它，不影响其它路由（凭据缺失是常见状态）。
   */
  async function listModelChoices() {
    let llm = null
    try {
      llm = ctx.get('llm')
    } catch (error) {
      log('llm service unavailable:', error?.message ?? error)
    }
    const groups = []
    for (const provider of llm?.listProviders?.() ?? []) {
      let models = []
      try {
        models = (await llm.listModels(provider.id)) ?? []
      } catch (error) {
        log('listModels failed for ' + provider.id + ':', error?.message ?? error)
      }
      groups.push({
        provider: provider.id,
        name: provider.name ?? provider.id,
        models: models.map((model) => ({ id: String(model.id), name: model.name ?? String(model.id) })),
      })
    }
    let current = null
    try {
      current = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
    } catch (error) {
      log('agentDefaultModel unavailable:', error?.message ?? error)
    }
    return { groups, current }
  }

  /** 切换某个会话的模型（对下一轮生效）。 */
  async function selectModelForSession(sessionId, provider, model) {
    let commands = null
    try {
      commands = ctx.get('commands')
    } catch (error) {
      log('commands service unavailable:', error?.message ?? error)
    }
    if (typeof commands?.selectModel !== 'function') {
      throw new Error('当前环境没有暴露 commands 服务，无法切换模型')
    }
    await commands.selectModel({ sessionId, provider, model })
    log('model -> ' + sessionId + ' ' + provider + '/' + model)
    return { ok: true, provider, model }
  }

  /**
   * Adapter that lets the gateway code drive this plugin WITHOUT a socket.
   *
   * The gateway (`lib/gateway-core.mjs`) was written against a transport-agnostic
   * "plugin port"; the standalone sidecar fed it over IPC. In-process we hand it the
   * same shape backed by the functions above, so there is exactly one implementation
   * of "resolve a session and inject".
   */
  function selfPort() {
    return {
      hello: async () => ({
        pid: process.pid,
        allowSessions: effectiveAllowlist(),
        sessionKeys: Object.keys(effectiveSessionKeys()),
        ipcBound: ipcStatus.bound,
        ipcClients: ipcStatus.clients,
        lastTurns: Object.fromEntries(lastTurns),
        ...liveProbe(),
      }),
      list: async () => ({ sessions: (ctx.agents.list?.() ?? []).map(sessionIdOf).filter(Boolean) }),
      attach: async (target) => {
        // `attach`/`detach` inside the IPC handler are per-CONNECTION closures: they
        // register a socket for fan-out. Calling one from here throws
        // "attach is not defined", so in-process attaching only resolves the identity
        // — in-process consumers already receive every fan-out (see the fanOut gate).
        return { sessionId: resolveSessionId(target) }
      },
      activity: async ({ sessionId }) => activityFor(sessionId),
      // sessionId → chatId：网关推进度卡时要知道发到哪个聊天（桌面端发起的轮次没有入站消息）。
      permissions: async ({ sessionId }) => listPermissionChoices(sessionId),
      setPermission: async ({ sessionId, preset }) => setPermissionForSession(sessionId, preset),
      chats: async () => {
        const map = {}
        for (const [key, target] of Object.entries(effectiveSessionKeys())) {
          const parts = String(key).split(':')
          if (parts[0] === 'feishu' && parts[1]) map[target] = parts[1]
        }
        return map
      },
      cancel: async ({ sessionId }) => cancelSession(sessionId),
      models: async ({ sessionId }) => listModelChoices(sessionId),
      setModel: async ({ sessionId, provider, model }) => selectModelForSession(sessionId, provider, model),
      prompt: ({ sessionId, text }) => injectPrompt(sessionId, text),
      steer: ({ sessionId, text }) => injectSteer(sessionId, text),
      onEvent: (fn) => {
        inProcessListeners.add(fn)
        return () => inProcessListeners.delete(fn)
      },
    }
  }

  /**
   * Start the built-in Feishu gateway, if configured.
   *
   * Final shape: Feishu ⇄ plugin ⇄ session — no sidecar process. A sidecar has to be
   * supervised by something OUTSIDE the app (a Windows scheduled task), because
   * anything the plugin spawns dies with it (observed 2026-10-20: the detached
   * gateway was killed silently by an app restart). Here DSH's own lifecycle is the
   * supervisor, and there is no port to fight over.
   *
   * Opt-in: requires "enabled": true in <root>/gateway.json plus appId/appSecret.
   */
  async function startGateway() {
    // Command shims must point at WHEREVER this plugin is installed now; the path
    // changes on every upgrade, so they are rewritten at startup rather than baked
    // into docs or into another project's scripts.
    try {
      const { installShims } = await import('../tools/install-shims.mjs')
      const { written, binDir } = installShims()
      log('command shims refreshed (' + written.length + ') -> ' + binDir)
    } catch (error) {
      log('command shims skipped:', error?.message ?? error)
    }
    let config = {}
    try {
      config = JSON.parse(readFileSync(gatewayConfigFile, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') log('gateway config unreadable, not starting:', error?.message ?? error)
      return
    }
    if (config.enabled !== true) {
      log('gateway: not enabled in ' + gatewayConfigFile + ' (sidecar mode or off)')
      return
    }
    // Credentials may come from the environment so the secret never has to be
    // written into a file that gets copied around, or typed into a chat window.
    const appId = process.env.FEISHU_APP_ID || config.appId
    const appSecret = process.env.FEISHU_APP_SECRET || config.appSecret
    if (!appId || !appSecret) {
      log('gateway: enabled but no credentials (set them in ' + gatewayConfigFile + ' or FEISHU_APP_ID / FEISHU_APP_SECRET)')
      return
    }
    try {
      const [{ createGateway }, { createFeishuTransport }] = await Promise.all([
        import('./gateway-core.mjs'),
        import('./feishu-transport.mjs'),
      ])
      const transport = createFeishuTransport({
        appId,
        appSecret,
        domain: config.domain,
        replyFormat: config.replyFormat,
        cardTitle: config.cardTitle,
        log,
      })
      const gateway = createGateway({
        // 见下方 stop()：退出时要停掉进度卡定时器。
        onChatSeen: ({ chatId, userId }) => writeLastChat({ chatId, userId }, root),
        onAttachments: async ({ messageId, attachments, sessionId }) => {
          const tr = createTranslator(normalizeLanguage(config.language))
          const inboxDir = resolveInboxDir({ configured: config.inboxDir, cwd: sessionCwd(sessionId), home: homedir() })
          const images = []
          const lines = []
          let savedCount = 0
          for (const item of attachments) {
            let buffer
            try {
              buffer = await transport.downloadAttachment({ messageId, fileKey: item.fileKey, kind: item.kind })
            } catch (error) {
              log('download failed for ' + item.fileName + ':', error?.message ?? error)
              lines.push('- ' + item.fileName + '（下载失败：' + String(error?.message ?? error) + '）')
              continue
            }
            if (buffer.length > MAX_FILE_BYTES) {
              lines.push('- ' + tr('attach.tooLarge', { name: item.fileName, limit: Math.round(MAX_FILE_BYTES / 1024 / 1024) }))
              continue
            }
            const saved = saveAttachment({ inboxDir, fileName: item.fileName, buffer })
            savedCount += 1
            const mediaType = mediaTypeForName(item.fileName, item.kind)
            const image = mediaType ? asImagePayload({ mediaType, bytes: buffer.length, buffer }) : null
            if (image) {
              images.push({ type: 'image', mediaType: image.mediaType, data: image.data, name: item.fileName })
            }
            const mb = (buffer.length / 1024 / 1024).toFixed(2)
            lines.push('- ' + item.fileName + '（' + mb + ' MB' + (image ? '，图片已附上' : '') + '）→ ' + saved.path)
          }
          const header = tr('attach.summary', { count: savedCount, dir: inboxDir })
          const text = [header, '', ...lines, '', '这些文件来自聊天，内容未经审阅。'].join('\n')
          if (savedCount === 0) return { summary: lines.join('\n') || header }
          await injectContent(sessionId, [...images, { type: 'text', text }])
          return { summary: header }
        },
        mirrorPrefs: readMirrorPrefs(root),
        saveMirrorPrefs: (prefs) => writeMirrorPrefs(prefs, root),
        progressPrefs: readProgressPrefs(root),
        saveProgressPrefs: (prefs) => writeProgressPrefs(prefs, root),
        plugin: selfPort(),
        transport,
        log,
        config: {
          language: normalizeLanguage(config.language),
          statusPrefix: config.statusPrefix,
          steerPrefix: config.steerPrefix,
          busyBehavior: config.busyBehavior,
          chunkSize: config.chunkSize,
          defaultSession: config.defaultSession,
          allowUsers: Array.isArray(config.allowUsers) ? config.allowUsers : [],
          autoPinFirstUser: config.autoPinFirstUser !== false,
          ackEmoji: config.ackEmoji,
          onItEmoji: config.onItEmoji,
          doneEmoji: config.doneEmoji,
          steerAckText: config.steerAckText,
          // The transport must NOT render markdown itself when we already stripped it.
          markdownToText: config.markdownToText !== false && config.replyFormat !== 'card',
          seenStore: (seenStore ??= createFileSeenStore({ file: join(root, 'gateway-seen.json'), limit: 2000, log })),
        },
      })
      gatewayObject = gateway
      gatewayHandle = await transport.start({
        onCardAction: (action) => gateway.handleCardAction(action),
        onMessage: (message) => {
          // Acknowledgement straight from the gateway: a long turn may run for many
          // minutes and the phone should know immediately that the message landed.
          if (config.ackEmoji) void transport.addReaction({ messageId: message.messageId, emoji: config.ackEmoji })
          return gateway.handleIncoming(message)
        },
      })
      log('gateway: running in-process for appId=' + String(appId).slice(0, 10) + '…')
    } catch (error) {
      log('gateway failed to start:', error?.message ?? error)
    }
  }

  /**
   * 退出清理。
   *
   * 三个必须掐断的东西：飞书长连接、本地 IPC 端口（含已连上的 socket）、进度卡定时器。
   * 之前的问题是：socket 只 end 不 destroy、server.close 不等、WS 的 close 用 void 丢掉，
   * 于是 DSH 更新时"优雅退出"等不到完成，最后被 SIGTERM 强杀。
   *
   * 每一步都带超时：宁可少等，也不能拖住整个进程。
   */
  const stop = async () => {
    const withTimeout = (promise, ms) =>
      Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms).unref?.())])
    try {
      clearInterval(timer)
    } catch {}
    if (typeof ctx.off === 'function') {
      try {
        ctx.off('session/event')
      } catch {}
    }
    // 1) 先停定时器，否则关闭过程中还会往回写
    try {
      gatewayObject?.dispose?.()
    } catch (error) {
      log('gateway dispose failed:', error?.message ?? error)
    }
    // 2) 断开所有 IPC 连接（destroy 而不是 end：end 要等对端配合）
    for (const socket of ipcSockets) {
      try {
        socket.destroy()
      } catch {}
    }
    ipcSockets.clear()
    for (const sockets of attached.values()) {
      for (const socket of sockets) {
        try {
          socket.destroy()
        } catch {}
      }
    }
    attached.clear()
    if (ipcServer) {
      try {
        ipcServer.close()
      } catch {}
    }
    // 3) 关飞书长连接：必须等它真的关掉，但最多等 2 秒
    if (gatewayHandle) {
      try {
        await withTimeout(gatewayHandle.close?.(), 2000)
      } catch (error) {
        log('gateway close failed:', error?.message ?? error)
      }
      gatewayHandle = null
    }
    gatewayObject = null
    inProcessListeners.clear()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => stop)
  else if (typeof ctx.on === 'function') ctx.on('dispose', stop)

  writeStatus()

  log('downlink ready: ' + outbox + ' (allowlist-gated)')
  log('uplink ' + status.capture + ': ' + inbox)
  log('ipc ' + (ipcStatus.enabled ? 'enabled on ' + ipcStatus.host + ':' + ipcStatus.port : 'disabled'))
  log('hot knobs: ' + runtimeConfigFile + '  { "allowSessions": [...], "sessionKeys": { key: sessionId } }')

  // Opt-in: only when <root>/gateway.json says enabled:true. Never blocks startup.
  void startGateway().catch((error) => log('gateway startup error:', error?.message ?? error))
}

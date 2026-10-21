#!/usr/bin/env node
/**
 * dsh-feishu-gateway — Feishu ⇄ live DSH session, standalone sidecar.
 *
 * Why this exists: a queueing bridge serializes turns, so a message sent while
 * the agent is busy waits for the current turn to finish (`message queued for busy
 * session`). That makes real mid-turn input impossible. Owning the Feishu side lets
 * us decide per message: run a turn, or steer INTO the running one.
 *
 *   Feishu ──WS──> this process ──loopback IPC──> dsh-im-bridge (inside the Host)
 *                                                        │
 *                                                        └─> the live DSH session
 *
 * Config: ~/.dsh-im-bridge/gateway.json (see DEFAULTS below), or env overrides
 *   FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_DOMAIN, DSH_BRIDGE_PORT
 *
 * Run: node bin/dsh-feishu-gateway.mjs
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createPluginIpc } from '../lib/plugin-ipc.mjs'
import { createGateway } from '../lib/gateway-core.mjs'
import { createFeishuTransport } from '../lib/feishu-transport.mjs'
import { createFileSeenStore } from '../lib/seen-store.mjs'

const ROOT = join(homedir(), '.dsh-im-bridge')
const CONFIG_FILE = join(ROOT, 'gateway.json')
const LOG_FILE = join(ROOT, 'gateway.log')

const DEFAULTS = {
  pluginPort: 9811,
  pluginToken: null,
  domain: 'feishu',
  statusPrefix: '?',
  steerPrefix: '#',
  busyBehavior: 'steer',
  /** Reaction placed when a message is accepted ('' disables). */
  ackEmoji: 'Get',
  /** Reaction placed when the reply is sent ('' disables). */
  doneEmoji: 'Done',
}

function log(...args) {
  const line = '[' + new Date().toISOString() + '] [gateway] ' + args.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')
  process.stderr.write(line + '\n')
  try {
    appendFileSync(LOG_FILE, line + '\n')
  } catch {}
}

function loadConfig() {
  let file = {}
  try {
    file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') log('gateway.json ignored:', error?.message ?? error)
  }
  const merged = { ...DEFAULTS, ...file }
  // Env wins, so credentials never have to be written to disk.
  if (process.env.FEISHU_APP_ID) merged.appId = process.env.FEISHU_APP_ID
  if (process.env.FEISHU_APP_SECRET) merged.appSecret = process.env.FEISHU_APP_SECRET
  if (process.env.FEISHU_DOMAIN) merged.domain = process.env.FEISHU_DOMAIN
  if (process.env.DSH_BRIDGE_PORT) merged.pluginPort = Number(process.env.DSH_BRIDGE_PORT)
  return merged
}

async function main() {
  try {
    mkdirSync(ROOT, { recursive: true })
  } catch {}

  const config = loadConfig()
  if (config.enabled === true) {
    // One Feishu app allows ONE long-connection consumer. When the plugin has
    // enabled:true it owns that connection; a second one would receive a random
    // share of events, so messages would work "sometimes" and fail silently
    // otherwise. Refuse loudly instead.
    log(
      'refusing to start: ' + CONFIG_FILE + ' has "enabled": true, so the PLUGIN owns the Feishu connection. ' +
        'Set "enabled": false there to run this sidecar instead.',
    )
    process.exit(1)
  }
  if (!config.appId || !config.appSecret) {
    log('missing appId/appSecret: put them in ' + CONFIG_FILE + ' or set FEISHU_APP_ID / FEISHU_APP_SECRET')
    process.exit(1)
  }

  log('starting: pluginPort=' + config.pluginPort + ' appId=' + String(config.appId).slice(0, 8) + '… busyBehavior=' + config.busyBehavior)

  const plugin = createPluginIpc({ port: config.pluginPort, token: config.pluginToken, log })
  await plugin.whenConnected()
  const hello = await plugin.hello()
  log('plugin pid=' + hello.pid + ' ipcBound=' + hello.ipcBound + ' allowSessions=' + JSON.stringify(hello.allowSessions))

  const transport = createFeishuTransport({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain,
    replyFormat: config.replyFormat,
    cardTitle: config.cardTitle,
    log,
  })

  const gateway = createGateway({
    plugin,
    transport,
    log,
    config: {
      statusPrefix: config.statusPrefix,
      steerPrefix: config.steerPrefix,
      busyBehavior: config.busyBehavior,
      chunkSize: config.chunkSize,
      defaultSession: config.defaultSession,
      allowUsers: Array.isArray(config.allowUsers) ? config.allowUsers : [],
      autoPinFirstUser: config.autoPinFirstUser !== false,
      // Durable: a restart must not re-inject a message Feishu retried.
      ackEmoji: config.ackEmoji,
      onItEmoji: config.onItEmoji,
      doneEmoji: config.doneEmoji,
      steerAckText: config.steerAckText,
      markdownToText: config.markdownToText !== false && config.replyFormat !== 'card',
      seenStore: createFileSeenStore({ file: join(ROOT, 'gateway-seen.json'), limit: 2000, log }),
    },
  })

  // Light acknowledgement so a phone user knows the message landed, even if the
  // turn takes ten minutes.
  const original = gateway.handleIncoming
  const withAck = async (message) => {
    if (config.ackEmoji) void transport.addReaction({ messageId: message.messageId, emoji: config.ackEmoji })
    return original(message)
  }

  const connection = await transport.start({ onMessage: withAck })
  log('ready')

  const shutdown = async (reason) => {
    log('shutting down:', reason)
    try {
      await connection?.close?.()
    } catch {}
    plugin.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (error) => log('unhandled rejection:', error?.message ?? error))

  // Heartbeat: makes it obvious in the log whether the process is alive while idle.
  setInterval(() => {
    log('heartbeat: pluginConnected=' + plugin.connected + ' chats=' + gateway.chatCount)
  }, 10 * 60 * 1000).unref()
}

main().catch((error) => {
  log('fatal:', error?.stack ?? error)
  process.exit(1)
})

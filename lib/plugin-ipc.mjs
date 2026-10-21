/**
 * plugin-ipc — a resilient client for dsh-im-bridge's loopback IPC.
 *
 * The plugin lives inside the DSH Host, so it is the only thing that may inject
 * into a live session (no launch token, no cross-process write lease). Everything
 * that drives a session — the Feishu gateway today, other transports tomorrow — speaks
 * to it over 127.0.0.1 with newline-delimited JSON.
 *
 * Properties that matter in production:
 *   - reconnects with backoff (the Host restarts far more often than this process)
 *   - requests are matched by id, events are dispatched to listeners
 *   - a dropped socket fails in-flight requests instead of hanging forever
 */
import { connect } from 'node:net'

const DEFAULT_PORT = 9811
const REQUEST_TIMEOUT_MS = 30000

export function createPluginIpc({ port = DEFAULT_PORT, host = '127.0.0.1', token = null, log = () => {} } = {}) {
  const events = new Set()
  const pending = new Map()
  let socket = null
  let connected = false
  let buffer = ''
  let nextId = 1
  let retryDelay = 1000
  let stopped = false

  function failAll(reason) {
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
    }
    pending.clear()
  }

  function dispatch(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      log('bad JSON from plugin:', line.slice(0, 160))
      return
    }
    if (message.event) {
      for (const listener of events) {
        try {
          listener(message)
        } catch (error) {
          log('event listener failed:', error?.message ?? error)
        }
      }
      return
    }
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.ok === false) waiter.reject(new Error(message.error ?? 'plugin error'))
    else waiter.resolve(message)
  }

  function scheduleReconnect() {
    if (stopped) return
    const delay = retryDelay
    retryDelay = Math.min(retryDelay * 2, 15000)
    setTimeout(open, delay)
  }

  function open() {
    if (stopped) return
    socket = connect(port, host)
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      connected = true
      retryDelay = 1000
      log('plugin IPC connected on ' + host + ':' + port)
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim()) dispatch(line)
      }
    })
    socket.on('error', (error) => log('plugin IPC error:', error?.message ?? error))
    socket.on('close', () => {
      connected = false
      failAll('plugin IPC closed')
      log('plugin IPC closed; reconnecting in ' + retryDelay + 'ms')
      scheduleReconnect()
    })
  }

  function call(op, extra = {}) {
    if (!connected || !socket) return Promise.reject(new Error('plugin IPC is not connected'))
    const id = nextId++
    const payload = { id, op, ...extra }
    if (token) payload.token = token
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('plugin IPC timed out: ' + op))
      }, REQUEST_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      try {
        socket.write(JSON.stringify(payload) + '\n')
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  }

  open()

  return {
    get connected() {
      return connected
    },
    hello: () => call('hello'),
    list: () => call('list'),
    attach: (target) => call('attach', target),
    prompt: ({ sessionId, text }) => call('prompt', { sessionId, text }),
    steer: ({ sessionId, text }) => call('steer', { sessionId, text }),
    cancel: ({ sessionId }) => call('cancel', { sessionId }),
    dispose: ({ sessionId }) => call('dispose', { sessionId }),
    resume: ({ sessionId, options }) => call('resume', { sessionId, options }),
    onEvent: (fn) => {
      events.add(fn)
      return () => events.delete(fn)
    },
    /** Resolve once connected (or reject after timeoutMs). */
    whenConnected(timeoutMs = 30000) {
      if (connected) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs
        const tick = () => {
          if (connected) return resolve()
          if (Date.now() > deadline) return reject(new Error('plugin IPC never connected on ' + host + ':' + port))
          setTimeout(tick, 200)
        }
        tick()
      })
    },
    close() {
      stopped = true
      failAll('plugin IPC stopped')
      try {
        socket?.end()
      } catch {}
    },
  }
}

/**
 * seen-store — durable de-duplication for Feishu event ids.
 *
 * Why this is not over-engineering: Feishu retries an event when it is not acked
 * within a few seconds, and the gateway will be restarted (deploys, crashes, app
 * restarts). An in-memory set forgets what it has seen, so a retry after a restart
 * injects the SAME user message a second time — and a duplicate user/message is
 * indistinguishable from the operator saying it twice. On a long session that is
 * real corruption of the conversation.
 *
 * The store keeps the last `limit` ids in a small JSON file and writes atomically
 * (temp + rename) so a crash mid-write cannot leave a half-written file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function createFileSeenStore({ file, limit = 2000, log = () => {} }) {
  const ids = []

  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(parsed?.ids)) {
        for (const id of parsed.ids) if (typeof id === 'string') ids.push(id)
        log('seen-store loaded ' + ids.length + ' ids from ' + file)
      }
    }
  } catch (error) {
    log('seen-store unreadable, starting empty:', error?.message ?? error)
  }

  const set = new Set(ids)
  let dirty = false
  let timer = null

  function persist() {
    if (!dirty) return
    dirty = false
    const payload = JSON.stringify({ savedAt: new Date().toISOString(), ids })
    const temp = file + '.tmp'
    try {
      // The directory may not exist on first run; without this the write fails
      // silently and de-duplication would not survive a restart.
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(temp, payload)
      renameSync(temp, file)
    } catch (error) {
      log('seen-store write failed:', error?.message ?? error)
    }
  }

  function schedule() {
    if (timer) return
    // Small delay: bursts of events collapse into one write.
    timer = setTimeout(() => {
      timer = null
      persist()
    }, 500)
    if (typeof timer.unref === 'function') timer.unref()
  }

  return {
    has: (id) => set.has(id),
    add(id) {
      if (set.has(id)) return
      set.add(id)
      ids.push(id)
      while (ids.length > limit) {
        const dropped = ids.shift()
        set.delete(dropped)
      }
      dirty = true
      schedule()
    },
    /** Force a write (used by tests and on shutdown). */
    flush: persist,
    get size() {
      return ids.length
    },
  }
}

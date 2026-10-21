#!/usr/bin/env node
/**
 * session-route.mjs — print the provider/model a persisted session last used.
 *
 * Why: resuming a session that is NOT live in the desktop Host requires an
 * explicit route (`agentOptions` in ~/.cc-dsh-bridge/config.json). Without it the
 * resumed agent fails every turn with
 *
 *   prompt variable "{{model}}" has no value (section "deployment:persona-prefix")
 *
 * The authoritative source is the session log's own `model/selection` event.
 *
 * Usage:
 *   node tools/session-route.mjs                      # newest session in the current workspace
 *   node tools/session-route.mjs session-<uuid>       # one specific session id
 *   node tools/session-route.mjs --all                # every session's route
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/** DSH v4 artefacts are a chain of independent zstd frames. */
function decode(path) {
  const buffer = readFileSync(path)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let i = buffer.indexOf(magic)
  while (i >= 0) {
    offsets.push(i)
    i = buffer.indexOf(magic, i + 4)
  }
  const parts = []
  let start = 0
  let k = 1
  while (k <= offsets.length) {
    const end = k < offsets.length ? offsets[k] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
      start = end
      k++
    } catch {
      k++
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Every persisted session, newest first: { workspace, name, file, mtime }. */
function sessions() {
  const found = []
  for (const workspace of readdirSync(SESSIONS_ROOT)) {
    const dir = join(SESSIONS_ROOT, workspace)
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const file = join(dir, name, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      found.push({ workspace, name, file, mtime: statSync(file).mtimeMs })
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

function routeOf(file) {
  let text
  try {
    text = decode(file)
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
  let selection
  let turns = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (line.includes('"type":"model/selection"')) {
      try {
        const event = JSON.parse(line)
        selection = event.data
      } catch {}
    }
    if (line.includes('"type":"turn/end"')) turns++
  }
  return { selection, turns }
}

const args = process.argv.slice(2)
const all = args.includes('--all')
const wanted = args.find((a) => !a.startsWith('--'))

const list = sessions()
const picked = all ? list : wanted ? list.filter((s) => s.name === wanted || s.name === 'session-' + wanted) : list.slice(0, 1)

if (picked.length === 0) {
  console.log('没找到匹配的会话。可用会话：')
  for (const s of list.slice(0, 15)) console.log('  ' + s.name)
  process.exit(1)
}

for (const s of picked) {
  const { selection, turns, error } = routeOf(s.file)
  console.log(s.name + '  [' + s.workspace + ']  turns=' + (turns ?? '?') + '  ' + new Date(s.mtime).toLocaleString('sv-SE'))
  if (error) {
    console.log('  读取失败: ' + error)
    continue
  }
  if (!selection) {
    console.log('  (没有 model/selection 事件 → 这个会话没记录过路由)')
    continue
  }
  console.log('  provider=' + selection.provider + '  model=' + selection.model + (selection.reasoningEffort ? '  reasoningEffort=' + selection.reasoningEffort : ''))
  console.log('  建议写进 config.json 的 agentOptions:')
  console.log(
    '  "agentOptions": ' +
      JSON.stringify({ provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }),
  )
}

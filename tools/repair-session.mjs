#!/usr/bin/env node
/**
 * repair-session.mjs — repair the role-less `user/message` defect in DSH session logs.
 *
 * Background (2026-10-18):
 *   A plugin that calls `agent.followup({ content, source: { kind: '<not "user">' } })`
 *   makes DSH commit a `user/message` event that carries NO `role` and NO `id`,
 *   because DSH only derives those when `source.kind === 'user'`. In a long
 *   history the provider then rejects every request:
 *
 *     Failed to deserialize the JSON body into the target type:
 *     messages[N]: missing field `role`
 *
 *   This tool patches such events in place: it adds `role: "user"` and a fresh
 *   `id` to every `user/message` that lacks `role`, keeping everything else
 *   byte-identical in meaning (one JSON line, same `seq`, same `time`).
 *
 * Usage:
 *   node repair-session.mjs                 # scan every session under ~/.dsh/sessions, patch, back up
 *   node repair-session.mjs --dry-run       # report only, never writes
 *   node repair-session.mjs --file <path>   # one session file only
 *
 * IMPORTANT — run this with the DeepSeek Harness DESKTOP APP QUIT.
 *   The Host holds a per-session write lease while a session is live; rewriting
 *   the file underneath a live handle risks the handle appending at a stale
 *   offset. With the app closed, no handle is open and the next start reads the
 *   repaired file.
 *
 * Every rewritten file is backed up first to
 *   ~/.cc-dsh-bridge/backup/<session-dir>.<timestamp>.jsonl.zstd
 * and restored automatically if the post-write verification fails.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const sessionsRoot = join(homedir(), '.dsh', 'sessions')
const backupDir = join(homedir(), '.cc-dsh-bridge', 'backup')
const dryRun = process.argv.includes('--dry-run')
const fileArgIndex = process.argv.indexOf('--file')
const onlyFile = fileArgIndex >= 0 ? process.argv[fileArgIndex + 1] : undefined

/** Decode a DSH v4 session artefact: a chain of independent zstd frames. */
function decode(buf) {
  const offsets = []
  let i = buf.indexOf(MAGIC)
  while (i >= 0) {
    offsets.push(i)
    i = buf.indexOf(MAGIC, i + 4)
  }
  const parts = []
  let start = 0
  let k = 1
  let frames = 0
  while (k <= offsets.length) {
    const end = k < offsets.length ? offsets[k] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)))
      start = end
      k++
      frames++
    } catch {
      k++ // a magic inside compressed payload: widen the current slice
    }
  }
  return { buffer: Buffer.concat(parts), frames }
}

function collectFiles() {
  if (onlyFile) return [onlyFile]
  const found = []
  for (const workspace of readdirSync(sessionsRoot)) {
    const wsDir = join(sessionsRoot, workspace)
    let entries = []
    try {
      entries = readdirSync(wsDir)
    } catch {
      continue
    }
    for (const session of entries) {
      const candidate = join(wsDir, session, 'session.v4.jsonl.zstd')
      if (existsSync(candidate)) found.push(candidate)
    }
  }
  return found
}

/** Patch every `user/message` line that has no `role`. Returns { text, patched[] }. */
function patchText(text) {
  const lines = text.split('\n')
  const patched = []
  const out = lines.map((line, index) => {
    if (!line.trim()) return line
    if (!/"type":"user\/message"/.test(line)) return line
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return line
    }
    if (event?.type !== 'user/message') return line
    if (typeof event?.data?.role === 'string' && event.data.role.length > 0) return line
    const before = { role: event?.data?.role, id: event?.data?.id, kind: event?.data?.source?.kind }
    event.data.role = 'user'
    if (!event.data.id) event.data.id = randomUUID()
    patched.push({ line: index + 1, seq: event.seq, kind: before.kind, addedId: !before.id })
    return JSON.stringify(event)
  })
  return { text: out.join('\n'), patched }
}

function countRoleless(text) {
  let n = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (!/"type":"user\/message"/.test(line)) continue
    try {
      const event = JSON.parse(line)
      if (event?.type === 'user/message' && !(typeof event?.data?.role === 'string' && event.data.role)) n++
    } catch {}
  }
  return n
}

const files = collectFiles()
console.log('扫描 ' + files.length + ' 个会话文件' + (dryRun ? '（dry-run，不写盘）' : ''))
let changed = 0
let totalPatched = 0

for (const file of files) {
  let original
  try {
    original = readFileSync(file)
  } catch (error) {
    console.log('  跳过（读不到）: ' + file + ' — ' + error.message)
    continue
  }
  const decoded = decode(original)
  const before = countRoleless(decoded.buffer.toString('utf8'))
  if (before === 0) continue

  const { text, patched } = patchText(decoded.buffer.toString('utf8'))
  const after = countRoleless(text)
  console.log('\n' + file)
  console.log('  压缩帧 ' + decoded.frames + '，解压后 ' + decoded.buffer.length + ' 字节')
  console.log('  无 role 的 user/message: ' + before + ' -> ' + after)
  for (const p of patched) {
    console.log('    修补 line ' + p.line + '  seq=' + p.seq + '  source.kind=' + p.kind + '  补 id=' + p.addedId)
  }
  if (after !== 0) {
    console.log('  ⚠ 仍有 ' + after + ' 条无 role，说明形状超出本工具的处理范围，跳过此文件')
    continue
  }
  if (dryRun) {
    changed++
    totalPatched += patched.length
    continue
  }

  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(backupDir, file.split(/[\\/]/).slice(-2)[0] + '.' + stamp + '.jsonl.zstd')
  copyFileSync(file, backup)
  // Write back one zstd frame per line, mirroring DSH's own append-per-write
  // framing. Concatenating the frames reproduces `text` byte for byte.
  const frames = []
  const rows = text.split('\n')
  for (let i = 0; i < rows.length; i++) {
    const chunk = i === rows.length - 1 ? rows[i] : rows[i] + '\n'
    if (chunk.length === 0) continue
    frames.push(zstdCompressSync(Buffer.from(chunk, 'utf8')))
  }
  try {
    writeFileSync(file, Buffer.concat(frames))
  } catch (error) {
    console.log('  写入失败，从备份恢复: ' + error.message)
    copyFileSync(backup, file)
    continue
  }
  // verify by re-reading from disk
  const verify = countRoleless(decode(readFileSync(file)).buffer.toString('utf8'))
  if (verify !== 0) {
    console.log('  校验失败（仍有 ' + verify + ' 条无 role），从备份恢复')
    copyFileSync(backup, file)
    continue
  }
  console.log('  ✅ 已修补并校验通过；备份: ' + backup)
  changed++
  totalPatched += patched.length
}

console.log('\n汇总: 处理文件 ' + changed + ' 个，修补事件 ' + totalPatched + ' 条' + (dryRun ? '（dry-run）' : ''))
if (!dryRun && changed > 0) console.log('现在可以重新启动 DeepSeek Harness。')

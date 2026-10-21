import { fileURLToPath } from 'node:url'
/**
 * seen-store tests — durable de-duplication.
 *
 * The failure this prevents: Feishu retries an unacked event; the gateway was
 * restarted in between; an in-memory set no longer knows the id, so the same user
 * message is injected twice. A duplicated user message is indistinguishable from
 * the operator repeating themselves, so it silently corrupts the conversation.
 *
 * Run: node test/seen-store.test.mjs
 */
import { rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFileSeenStore } from '../lib/seen-store.mjs'

const ROOT = fileURLToPath(new URL('../.test-seen', import.meta.url))
const FILE = join(ROOT, 'gateway-seen.json')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  rmSync(ROOT, { recursive: true, force: true })

  console.log('\n[1] 基本行为')
  const a = createFileSeenStore({ file: FILE })
  check('一开始没见过', a.has('ev-1') === false)
  a.add('ev-1')
  check('加了之后见过', a.has('ev-1') === true)
  check('重复 add 不重复记录', (a.add('ev-1'), a.size === 1), String(a.size))
  a.flush()
  check('flush 后文件存在', existsSync(FILE), FILE)

  console.log('\n[2] 重启后仍然记得（这就是重点）')
  const b = createFileSeenStore({ file: FILE })
  check('新实例读到了旧 id', b.has('ev-1') === true, String(b.size))
  check('没见过的仍然没见过', b.has('ev-2') === false)

  console.log('\n[3] 容量上限：只保留最近 N 个')
  const c = createFileSeenStore({ file: join(ROOT, 'small.json'), limit: 3 })
  for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) c.add(id)
  check('只记 3 个', c.size === 3, String(c.size))
  check('最早的被淘汰', c.has('e1') === false && c.has('e2') === false)
  check('最近的还在', c.has('e5') === true)

  console.log('\n[4] 坏文件不能崩')
  const bad = join(ROOT, 'bad.json')
  rmSync(ROOT, { recursive: true, force: true })
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(bad, '{not json')
  let threw = false
  let store
  try {
    store = createFileSeenStore({ file: bad })
  } catch {
    threw = true
  }
  check('坏 JSON 不抛异常，从空开始', !threw && store.has('x') === false)

  console.log('\n[5] 写入是原子的（先写 .tmp 再 rename）')
  const d = createFileSeenStore({ file: join(ROOT, 'atomic.json') })
  d.add('z1')
  await wait(700) // 让去抖的写入落地
  const raw = readFileSync(join(ROOT, 'atomic.json'), 'utf8')
  check('文件是合法 JSON', (() => { try { JSON.parse(raw); return true } catch { return false } })(), raw.slice(0, 40))
  check('内容包含刚加的 id', /z1/.test(raw))

  rmSync(ROOT, { recursive: true, force: true })
  console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('测试崩溃:', error)
  process.exit(1)
})

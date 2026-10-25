/**
 * 用假上下文加载插件，跑一次"启动 → 退出"，看进程能不能自己退干净。
 *
 * 注意：ctx.effect(fn) 里的 fn 是"返回清理函数"，要拿到返回值再调用。
 */
import { pathToFileURL } from 'node:url'

const started = Date.now()
const log = (...args) => console.log('  [probe]', ...args)

const disposers = []
const fakeService = {}
const ctx = new Proxy(
  {
    on: () => () => {},
    off: () => {},
    effect: (fn) => {
      disposers.push(fn)
    },
    get: () => fakeService,
    tools: { register: () => () => {} },
    agents: { get: () => undefined, list: () => [] },
  },
  {
    get(target, prop) {
      return prop in target ? target[prop] : undefined
    },
  },
)

const plugin = await import(pathToFileURL('D:/dsh-im-bridge/lib/index.js').href)
plugin.apply(ctx, { enabled: true })
log('registered, 耗时 ' + (Date.now() - started) + 'ms')

await new Promise((resolve) => setTimeout(resolve, 1500))
log('等连接稳定后开始退出')

const resources = () => {
  const list = process.getActiveResourcesInfo?.() ?? []
  const counts = {}
  for (const item of list) counts[item] = (counts[item] ?? 0) + 1
  return JSON.stringify(counts)
}
log('退出前资源: ' + resources())

const disposeStarted = Date.now()
for (const effectFn of disposers) {
  try {
    const cleanup = await effectFn()
    if (typeof cleanup === 'function') await cleanup()
  } catch (error) {
    log('清理抛错: ' + (error?.message ?? error))
  }
}
log('dispose 完成，耗时 ' + (Date.now() - disposeStarted) + 'ms')
log('退出后资源: ' + resources())

const watchdog = setTimeout(() => {
  log('❌ 8 秒后进程仍然活着，还挂着: ' + resources())
  process.exit(7)
}, 8000)
watchdog.unref()

process.on('exit', (code) => {
  clearTimeout(watchdog)
  log('✅ 进程自然退出 code=' + code + '，总计 ' + (Date.now() - started) + 'ms')
})

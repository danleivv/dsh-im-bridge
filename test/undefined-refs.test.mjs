/**
 * 启动期引用检查：用了却没导入的符号会让网关整个起不来，而 `node --check` 只查语法。
 *
 * 已经发生过一次：`/progress on|off` 用到 readProgressPrefs，但 import 语句的替换
 * 静默失败 —— 插件加载正常，直到 startGateway() 抛 ReferenceError，
 * 飞书网关整条链路是死的（日志里只有一行 "gateway failed to start"）。
 *
 * Run: node test/undefined-refs.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const path = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const source = readFileSync(path, 'utf8')

/** 本文件里 import 进来的名字。 */
const imported = new Set()
for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'[^']+'/g)) {
  for (const raw of match[1].split(',')) {
    const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
    if (name) imported.add(name)
  }
}
for (const match of source.matchAll(/import\s+(\w+)\s+from/g)) imported.add(match[1])

/** 本文件里定义的名字。 */
const defined = new Set()
for (const match of source.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)) defined.add(match[1])
for (const match of source.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+(\w+)/g)) defined.add(match[1])
for (const match of source.matchAll(/(?:^|\n)\s*(?:export\s+)?let\s+(\w+)/g)) defined.add(match[1])
for (const match of source.matchAll(/(?:^|\n)\s*(?:export\s+)?class\s+(\w+)/g)) defined.add(match[1])
for (const match of source.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+(\w+)/g)) defined.add(match[1])
for (const match of source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=/g)) defined.add(match[1])
// for (const x of ...) / for (const x in ...)
for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+(?:of|in)\b/g)) defined.add(match[1])
// 声明行里的绑定名：处理解构、多声明等所有形态。
// 取 = / of / in 之前的全部标识符（属性名也会被收进来，宁可漏报也不误报）。
for (const line of source.split('\n')) {
  if (!/^\s*(?:export\s+)?(?:const|let|var)\b/.test(line)) continue
  const head = line.split(/\s=\s|\s+of\s+|\s+in\s+|\s*=\s*/)[0] ?? ''
  for (const name of head.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (name[0] === 'const' || name[0] === 'let' || name[0] === 'var') continue
    defined.add(name[0])
  }
}

/** gateway-config 的导出。 */
const configPath = fileURLToPath(new URL('../lib/gateway-config.mjs', import.meta.url))
const configSource = readFileSync(configPath, 'utf8')
const configExports = new Set()
for (const match of configSource.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) configExports.add(match[1])

console.log('\n[1] gateway-config 的每个导出，用到就必须导入')
{
  for (const name of configExports) {
    const used = new RegExp('(?<![\\w.])' + name + '\\s*\\(').test(source)
    if (!used) continue
    check('导入 ' + name, imported.has(name), imported.has(name) ? 'ok' : '用了但没有 import —— 会在运行期抛 ReferenceError')
  }
}

console.log('\n[2] 检查范围没有空转')
{
  check('gateway-config 里至少有 3 个导出', configExports.size >= 3, [...configExports].join(', '))
  check('检测到了 readProgressPrefs', configExports.has('readProgressPrefs'))
  check('index.js 里确实用到了它', /readProgressPrefs\s*\(/.test(source))
}

console.log('\n[3] 全文件扫描：调用了，但既没导入、也没定义、也不是全局')
{
  const GLOBALS = new Set([
    'console', 'JSON', 'process', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Math',
    'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError', 'RegExp',
    'Symbol', 'BigInt', 'Intl', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
    'structuredClone', 'fetch', 'AbortController', 'AbortSignal', 'parseInt', 'parseFloat', 'isNaN',
    'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'require', 'module', 'exports',
    'globalThis', 'undefined', 'NaN', 'Infinity', 'eval', 'Function', 'Proxy', 'Reflect',
    'Atomics', 'SharedArrayBuffer', 'ArrayBuffer', 'DataView', 'Uint8Array', 'Uint16Array',
    'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array',
    'BigInt64Array', 'BigUint64Array', 'AggregateError', 'EvalError', 'SyntaxError', 'URIError',
    'ReferenceError', 'decodeURI', 'encodeURI', 'escape', 'unescape', 'isPrototypeOf',
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'await',
    'async', 'super', 'import', 'export', 'default', 'delete', 'void', 'in', 'of',
    'instanceof', 'do', 'else', 'try', 'finally', 'throw', 'case', 'break', 'continue', 'class',
    'const', 'let', 'var', 'yield', 'static', 'get', 'set', 'extends', 'elseif',
  ])

  // 去掉注释与字符串字面量，避免把文本里的词当成调用
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')

  const called = new Set()
  for (const match of stripped.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(match[1])

  const missing = [...called].filter((name) => !imported.has(name) && !defined.has(name) && !GLOBALS.has(name))
  check('没有未定义的调用', missing.length === 0, missing.length === 0 ? 'ok' : missing.join(', '))
}

console.log('\n[4] 关键模块都能被解析（导入期错误早发现）')
{
  const modules = ['../lib/gateway-config.mjs', '../lib/progress-card.mjs', '../lib/feishu-payload.mjs', '../lib/markdown.mjs']
  for (const specifier of modules) {
    let ok = true
    let detail = 'ok'
    try {
      await import(specifier)
    } catch (error) {
      ok = false
      detail = error.message
    }
    check('可导入 ' + specifier.replace('../lib/', ''), ok, detail)
  }
}

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)

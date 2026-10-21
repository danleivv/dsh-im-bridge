/**
 * Feishu message parsing — the one place raw Feishu payloads become text.
 *
 * Broken parsing here is silent: the gateway would inject an empty message or a
 * message full of `@_user_1` placeholders. Cheap to test, so it is tested.
 *
 * Run: node test/feishu-parse.test.mjs
 */
import { extractText } from '../lib/feishu-transport.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

console.log('\n[1] 纯文本')
check(
  '取到 text 字段',
  extractText('text', JSON.stringify({ text: '你好' })) === '你好',
  JSON.stringify(extractText('text', JSON.stringify({ text: '你好' }))),
)

console.log('\n[2] @ 提及要被剥掉（否则会注入 "@_user_1 帮我看看"）')
check(
  '去掉 @_user_N 占位',
  extractText('text', JSON.stringify({ text: '@_user_1 帮我看看' })) === '帮我看看',
  JSON.stringify(extractText('text', JSON.stringify({ text: '@_user_1 帮我看看' }))),
)
check(
  '@_all 也去掉',
  extractText('text', JSON.stringify({ text: '@_all 通知' })) === '通知',
  JSON.stringify(extractText('text', JSON.stringify({ text: '@_all 通知' }))),
)

console.log('\n[3] 富文本（post）')
const post = { zh_cn: { title: '', content: [[{ tag: 'text', text: '第一行' }], [{ tag: 'text', text: '第二行' }]] } }
check('两行都取到', extractText('post', JSON.stringify(post)) === '第一行\n第二行', JSON.stringify(extractText('post', JSON.stringify(post))))

console.log('\n[4] 坏输入不能抛异常')
for (const [label, input] of [
  ['空字符串', ''],
  ['非 JSON', 'not json'],
  ['null', null],
]) {
  let threw = false
  let value
  try {
    value = extractText('text', input)
  } catch {
    threw = true
  }
  check(label + ' 不抛异常，返回空串', !threw && value === '', JSON.stringify(value))
}

console.log('\n[5] 不支持的类型返回空串（图片/文件等）')
check('image 类型', extractText('image', JSON.stringify({ image_key: 'k' })) === '')
check('file 类型', extractText('file', JSON.stringify({ file_key: 'k' })) === '')

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)

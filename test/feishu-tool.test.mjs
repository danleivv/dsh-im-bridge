/**
 * 原生工具（feishu_send_file）测试：不联网。
 *
 * 工具注册形状错、会话解析错，表现为“agent 看不到这个工具”或“文件发到别人的会话”。
 *
 * Run: node test/feishu-tool.test.mjs
 */
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSendFileTool, chatIdForSession, resolveTargetChat, TOOL_NAME } from '../lib/feishu-tool.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const root = mkdtempSync(join(tmpdir(), 'ccdsh-tool-'))
const SESSION = 'session-aaaa-bbbb'
const CHAT = 'oc_test_chat'

mkdirSync(root, { recursive: true })
writeFileSync(join(root, 'config.json'), JSON.stringify({
  sessionKeys: { ['feishu:' + CHAT + ':ou_user']: SESSION, 'feishu:oc_other:ou_user': 'session-zzzz' },
}, null, 2))
writeFileSync(join(root, 'gateway.json'), JSON.stringify({ enabled: true, appId: 'cli_x', appSecret: 's'.repeat(32) }, null, 2))

console.log('\n[1] 会话 → 聊天')
{
  check('找到对应聊天', chatIdForSession(SESSION, { ['feishu:' + CHAT + ':ou_1']: SESSION }) === CHAT)
  check('不匹配返回 null', chatIdForSession('session-none', { ['feishu:' + CHAT + ':ou_1']: SESSION }) === null)
  check('空会话返回 null', chatIdForSession('', {}) === null)
  check('非 feishu 键被忽略', chatIdForSession('session-x', { 'slack:C123': 'session-x' }) === null)
}

console.log('\n[2] 目标解析优先级')
{
  check('chat 参数最高', resolveTargetChat({ chat: 'oc_direct', session: SESSION, sessionKeys: {}, defaultChat: 'oc_d' }).chatId === 'oc_direct')
  check('session 参数次之', resolveTargetChat({ session: SESSION, sessionKeys: { ['feishu:' + CHAT + ':ou']: SESSION }, defaultChat: 'oc_d' }).chatId === CHAT)
  check('最后才用 defaultChat', resolveTargetChat({ defaultChat: 'oc_d' }).chatId === 'oc_d')
  let threw = false
  try { resolveTargetChat({ session: 'session-missing', sessionKeys: {} }) } catch (error) { threw = /没有对应的飞书聊天/.test(error.message) }
  check('会话没有映射时明确报错', threw)
  threw = false
  try { resolveTargetChat({}) } catch (error) { threw = /无法确定目标聊天/.test(error.message) }
  check('什么都没有时明确报错', threw)
}

console.log('\n[3] 工具形状（能被 DSH 注册）')
{
  const tool = createSendFileTool({ root })
  check('名字正确', tool.name === TOOL_NAME && tool.name === 'feishu_send_file', tool.name)
  check('有 description', typeof tool.description === 'string' && tool.description.length > 10)
  check('parameters 是 JSON Schema', tool.parameters?.type === 'object' && Array.isArray(tool.parameters.required), JSON.stringify(tool.parameters?.required))
  check('files 是数组参数', tool.parameters.properties?.files?.type === 'array' && tool.parameters.properties.files.items.type === 'string')
  check('output 有 schema 与 render', tool.output?.schema?.type === 'object' && typeof tool.output.render === 'function')
  check('execute 是函数', typeof tool.execute === 'function')
  const rendered = tool.output.render({}, { chatId: CHAT, sent: [{ path: 'a.md', kind: 'file', bytes: 2048 }] })
  check('render 输出文本', rendered?.[0]?.type === 'text' && /已发送 file：a.md/.test(rendered[0].text), rendered?.[0]?.text)
}

console.log('\n[3b] schema 必须符合 DSH 的 JSON Schema 规则')
{
  // DSH 的转换器只接受标准 JSON Schema：required 是对象级的字符串数组，
  // 不能在属性里写 required: true。这条规则是实际注册失败后才发现的。
  const walk = (node, path) => {
    const problems = []
    if (!node || typeof node !== 'object') return problems
    if (Array.isArray(node)) {
      node.forEach((item, index) => problems.push(...walk(item, path + '[' + index + ']')))
      return problems
    }
    if ('required' in node && !Array.isArray(node.required)) {
      problems.push(path + '.required 必须是数组，实际是 ' + typeof node.required)
    }
    for (const [key, value] of Object.entries(node)) problems.push(...walk(value, path + '.' + key))
    return problems
  }
  const tool = createSendFileTool({ root })
  const paramProblems = walk(tool.parameters, 'parameters')
  const outputProblems = walk(tool.output.schema, 'output.schema')
  check('parameters 里没有 required: true', paramProblems.length === 0, paramProblems.join('; '))
  check('output.schema 里没有 required: true', outputProblems.length === 0, outputProblems.join('; '))
  check('顶层 required 是数组', Array.isArray(tool.parameters.required) && Array.isArray(tool.output.schema.required), JSON.stringify(tool.output.schema.required))
}
console.log('\n[4] 执行：按调用方会话发送')
{
  const calls = []
  const tool = createSendFileTool({
    root,
    senderFactory: () => ({
      send: async ({ chatId, filePath }) => {
        calls.push({ chatId, filePath })
        if (filePath.includes('bad')) throw new Error('文件过大')
        return { messageId: 'om_' + filePath, kind: 'file', bytes: 100 }
      },
    }),
  })
  const result = await tool.execute({ files: ['/tmp/a.md'] }, { agent: { session: { id: SESSION } } })
  check('解析到调用方会话的聊天', result.chatId === CHAT, result.chatId)
  check('返回 sent 明细', result.sent?.length === 1 && result.sent[0].messageId === 'om_/tmp/a.md', JSON.stringify(result.sent))
  check('部分失败不打断整体', await (async () => {
    const r = await tool.execute({ files: ['/tmp/a.md', '/tmp/bad.zip'] }, { agent: { session: { id: SESSION } } })
    return r.sent.length === 1 && r.failed?.length === 1 && /文件过大/.test(r.failed[0].error)
  })())
  let threw = false
  try { await tool.execute({ files: ['/tmp/bad.zip'] }, { agent: { session: { id: SESSION } } }) } catch (error) { threw = /全部发送失败/.test(error.message) }
  check('全失败时抛错（agent 能看到原因）', threw)
  let empty = false
  try { await tool.execute({ files: [] }, {}) } catch (error) { empty = /不能为空/.test(error.message) }
  check('空列表报错', empty)
}

console.log('\n[5] 缺凭据时给出可操作提示')
{
  const bare = mkdtempSync(join(tmpdir(), 'ccdsh-tool-bare-'))
  const tool = createSendFileTool({ root: bare, senderFactory: () => ({ send: async () => ({ messageId: 'x', kind: 'file', bytes: 1 }) }) })
  let threw = false
  try { await tool.execute({ files: ['/tmp/a.md'] }, {}) } catch (error) { threw = /dsh-feishu-setup|setup-feishu/.test(error.message) }
  check('提示去配凭据', threw)
  rmSync(bare, { recursive: true, force: true })
}

console.log('\n[6] chat 参数可以绕过会话映射')
{
  const calls = []
  const tool = createSendFileTool({ root, senderFactory: () => ({ send: async ({ chatId }) => { calls.push(chatId); return { messageId: 'om', kind: 'file', bytes: 1 } } }) })
  await tool.execute({ files: ['/tmp/a.md'], chat: 'oc_explicit' }, { agent: { session: { id: 'session-unknown' } } })
  check('用了显式 chat', calls[0] === 'oc_explicit', calls[0])
}

rmSync(root, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)

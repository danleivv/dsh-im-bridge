/**
 * 会话事件取文本：两种结构必须都认。
 *
 * 踩坑记录：按 data.message.content 去读用户消息，永远得到空串，
 * 于是所有桌面输入被当成"没有文字"丢掉，镜像功能看起来完全没生效。
 *
 * Run: node test/session-text.test.mjs
 */
import { blocksToText, userMessageText, assistantMessageText } from '../lib/session-text.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const textBlocks = (text) => [{ type: 'text', text }]

console.log('\n[1] 用户消息：内容在 data.content')
{
  // 真实结构（从会话日志里抄的）
  const data = {
    content: textBlocks('然后这个 goal 里面不要做时间太长的 GPU 实验'),
    source: { kind: 'user', rpcId: '947dacbf', clientTimeZone: 'Asia/Shanghai' },
    role: 'user',
    id: 'feaa8963',
  }
  check('读得出内容', userMessageText(data) === '然后这个 goal 里面不要做时间太长的 GPU 实验', JSON.stringify(userMessageText(data)))
}

console.log('\n[2] 助手回复：内容在 data.message.content')
{
  const data = { message: { content: textBlocks('好，只重拍第三镜') }, turn: 12 }
  check('读得出内容', assistantMessageText(data) === '好，只重拍第三镜', JSON.stringify(assistantMessageText(data)))
}

console.log('\n[3] 两种结构互相兜底')
{
  check('用户消息也能读 message.content', userMessageText({ message: { content: textBlocks('兜底') } }) === '兜底')
  check('助手回复也能读 data.content', assistantMessageText({ content: textBlocks('兜底') }) === '兜底')
}

console.log('\n[4] 边界')
{
  check('空 data', userMessageText(null) === '' && assistantMessageText(undefined) === '')
  check('没有 content', userMessageText({}) === '')
  check('content 不是数组', userMessageText({ content: 'text' }) === '')
  check('忽略非 text 块', userMessageText({ content: [{ type: 'image' }, ...textBlocks('只有这句')] }) === '只有这句')
  check('多个 text 块拼接', userMessageText({ content: [...textBlocks('a'), ...textBlocks('b')] }) === 'ab')
  check('blocksToText 空输入', blocksToText(undefined) === '')
}

console.log('\n[5] 关键回归：按助手路径读用户消息会拿到空串（这就是当时的 bug）')
{
  const userData = { content: textBlocks('桌面端说的话'), source: { kind: 'user' } }
  check('错误路径确实读不到', blocksToText(userData.message?.content) === '')
  check('正确路径读得到', userMessageText(userData) === '桌面端说的话')
}

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)

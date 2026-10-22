/**
 * Outbound payload tests.
 *
 * Two things are worth locking down here:
 *   1. a `text` message cannot render markdown at all, so "formatting" means a card —
 *      and the card must be the 2.0 shape (the `markdown` element), because 1.0's
 *      `lark_md` drops headings/tables/code;
 *   2. short acknowledgements must NOT become cards (a one-line card is all padding).
 *
 * Run: node test/feishu-payload.test.mjs
 */
import { buildMessagePayload, buildMarkdownCard, buildLegacyCard, hasMarkdownSyntax, splitMarkdownTables, MAX_CARD_TABLES } from '../lib/feishu-payload.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

console.log('\n[1] 卡片 2.0：用 markdown 元素（才能渲染标题/表格/代码）')
{
  const payload = buildMessagePayload('## 标题\n**粗**', { format: 'card' })
  check('msg_type = interactive', payload.msg_type === 'interactive', payload.msg_type)
  const card = JSON.parse(payload.content)
  check('schema = 2.0', card.schema === '2.0', JSON.stringify(card.schema))
  check('body.elements 存在', Array.isArray(card.body?.elements), JSON.stringify(Object.keys(card)))
  check('元素是 markdown 标签', card.body.elements[0]?.tag === 'markdown', JSON.stringify(card.body.elements[0]?.tag))
  check('markdown 原文未被转义', card.body.elements[0]?.content === '## 标题\n**粗**', JSON.stringify(card.body.elements[0]?.content))
  check('宽屏模式（表格在手机上不换行炸开）', card.config?.wide_screen_mode === true)
}

console.log('\n[2] 卡片 1.0 兜底形状')
{
  const card = JSON.parse(buildMessagePayload('**粗**', { format: 'card', cardVersion: '1.0' }).content)
  check('1.0 用 elements[].div + lark_md', card.elements?.[0]?.text?.tag === 'lark_md', JSON.stringify(card.elements?.[0]?.text?.tag))
  check('1.0 没有 schema 字段', card.schema === undefined)
}

console.log('\n[3] 纯文本载荷')
{
  const payload = buildMessagePayload('就是一句话', { format: 'text' })
  check('msg_type = text', payload.msg_type === 'text')
  check('content 是 {text}', JSON.parse(payload.content).text === '就是一句话', payload.content)
}

console.log('\n[4] 标题只在给了 title 时才加')
{
  const withTitle = buildMarkdownCard('正文', { title: '标题' })
  check('有标题时多一个元素', withTitle.body.elements.length === 2, String(withTitle.body.elements.length))
  const without = buildMarkdownCard('正文')
  check('没标题时只有一个元素', without.body.elements.length === 1, String(without.body.elements.length))
}

console.log('\n[5] hasMarkdownSyntax：决定要不要花钱做成卡片')
for (const [label, text, expected] of [
  ['标题', '## 结论', true],
  ['加粗', '这是 **重点**', true],
  ['行内代码', '用 `pwsh` 跑', true],
  ['表格', '| a | b |\n|---|---|', true],
  ['代码块', '```js\nx\n```', true],
  ['无序列表', '- 一\n- 二', true],
  ['有序列表', '1. 一', true],
  ['链接', '[文档](https://a.b)', true],
  ['短回执（中文）', '已接收消息，当前工具调用结束后响应', false],
  ['普通句子', '好的，我看一下', false],
  ['空串', '', false],
  ['带下划线的单词', 'snake_case', false],
]) {
  check(label + ' → ' + (expected ? '用卡片' : '用纯文本'), hasMarkdownSyntax(text) === expected, JSON.stringify(text))
}

console.log('\n[6] 卡片 JSON 必须能被序列化回等价对象（防止运行时炸）')
{
  const md = '## t\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```powershell\nStart-Sleep 1\n```'
  const payload = buildMessagePayload(md, { format: 'card' })
  let parsed = null
  try {
    parsed = JSON.parse(payload.content)
  } catch {}
  check('可解析', parsed !== null)
  const tags = (parsed?.body?.elements ?? []).map((e) => e.tag)
  check('表格变成 table 组件', tags.includes('table'), tags.join(','))
  check('正文仍在 markdown 元素里', tags.includes('markdown'), tags.join(','))
  const text = parsed.body.elements.filter((e) => e.tag === 'markdown').map((e) => e.content).join('\n')
  check('标题与代码块原样保留', text.includes('## t') && text.includes('```powershell'), JSON.stringify(text))
}

console.log('\n[7] 表格提取：markdown 表格 → 原生 table 组件')
{
  const md = ['开头', '', '| 组 | 改动 |', '|---|---|', '| base | 现状 |', '| +1 | 加词 |', '', '结尾'].join('\n')
  const segs = splitMarkdownTables(md)
  check('分段顺序正确', segs.map((s) => s.type).join(',') === 'markdown,table,markdown', JSON.stringify(segs.map((s) => s.type)))
  check('表头解析', JSON.stringify(segs[1].header) === JSON.stringify(['组', '改动']), JSON.stringify(segs[1].header))
  check('数据行不含分隔行', segs[1].rows.length === 2, String(segs[1].rows.length))

  const card = buildMarkdownCard(md)
  check('卡片里有 table 元素', card.body.elements.some((e) => e.tag === 'table'), card.body.elements.map((e) => e.tag).join(','))
  const table = card.body.elements.find((e) => e.tag === 'table')
  check('列名来自表头', table.columns.map((c) => c.display_name).join('/') === '组/改动', table.columns.map((c) => c.display_name).join('/'))
  check('单元格用 lark_md', table.columns.every((c) => c.data_type === 'lark_md'))
  check('行数据按列 key 对齐', table.rows[0].c0 === 'base' && table.rows[0].c1 === '现状', JSON.stringify(table.rows[0]))
}

console.log('\n[8] 不该被当成表格的情况')
{
  const noSep = '| a | b |\n| 1 | 2 |'
  check('缺分隔行不当表格', splitMarkdownTables(noSep).every((s) => s.type === 'markdown'), JSON.stringify(splitMarkdownTables(noSep).map((s) => s.type)))

  const fence = '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```'
  check('代码块里的表格不抽', splitMarkdownTables(fence).every((s) => s.type === 'markdown'), JSON.stringify(splitMarkdownTables(fence).map((s) => s.type)))
}

console.log('\n[9] 表格数量上限与降级')
{
  const one = '| a |\n|---|\n| 1 |'
  const many = Array.from({ length: MAX_CARD_TABLES + 2 }, () => one).join('\n\n')
  const card = buildMarkdownCard(many)
  const tables = card.body.elements.filter((e) => e.tag === 'table')
  check('最多 ' + MAX_CARD_TABLES + ' 个表格组件', tables.length === MAX_CARD_TABLES, String(tables.length))
  const text = card.body.elements.filter((e) => e.tag === 'markdown').map((e) => e.content).join('')
  check('超限部分降级且不露竖线', !text.includes('|') && text.trim().length > 0, JSON.stringify(text.slice(0, 60)))
}

console.log('\n[10] 无表格时保持原样')
{
  const card = buildMarkdownCard('## 标题\n\n**粗体**')
  check('只有一个 markdown 元素', card.body.elements.length === 1 && card.body.elements[0].tag === 'markdown', JSON.stringify(card.body.elements.map((e) => e.tag)))
  check('内容原样传递', card.body.elements[0].content === '## 标题\n\n**粗体**', card.body.elements[0].content)
}

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)

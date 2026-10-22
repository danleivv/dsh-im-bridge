/**
 * Outbound Feishu message payloads.
 *
 * Why cards: a `text` message renders NO markdown at all — the user sees `##` and
 * `**` literally. Card 1.0's `lark_md` only covers bold/links; **card 2.0** has a
 * `markdown` element that renders headings, lists and code blocks.
 *
 * Important: card 2.0's `markdown` element does **not** render tables — a markdown
 * table arrives as a wall of pipes. Feishu has a native `table` component instead, so
 * markdown tables are lifted out of the text and emitted as that component.
 *
 * Kept pure (no SDK, no network) so the exact JSON can be unit-tested and previewed.
 */
import { toLarkMd } from './markdown.mjs'

/** 卡片 2.0 规定单张卡片最多 5 个表格组件。 */
export const MAX_CARD_TABLES = 5


/** 卡片富文本只认官方语言名；模型常写 js / ts / py 这些别名。 */
const LANGUAGE_ALIASES = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', py3: 'python', sh: 'shell', zsh: 'shell', ps1: 'powershell', pwsh: 'powershell',
  yml: 'yaml', md: 'markdown', rb: 'ruby', rs: 'rust', kt: 'kotlin',
  cxx: 'cpp', 'c++': 'cpp', 'c#': 'c_sharp', cs: 'c_sharp', objc: 'objective_c',
  dockerfile: 'docker_file', text: 'plain_text', txt: 'plain_text', plain: 'plain_text',
  conf: 'properties', ini: 'properties', env: 'properties', htm: 'html',
}

/**
 * 把代码块的语言标记换成飞书支持的名字。
 *
 * 官方文档：未指定语言按 Plain Text 处理；语言名不在名单里时不会渲染成代码块。
 * 另外围栏必须在行首，这里顺手把带前导空格的三反引号推到行首。
 */
export function normalizeFenceLanguages(text) {
  if (typeof text !== 'string' || text === '') return ''
  const out = []
  for (const line of text.split('\n')) {
    const fence = line.match(/^\s*```([A-Za-z0-9_+#-]*)\s*$/)
    if (fence) {
      // 表格行紧跟围栏时，飞书的表格解析会把围栏当成表格内容吃掉，代码块起不来。
      // 强制插一个空行，把两者掰开（实测 08:43 那条消息就是这个形态）。
      const previous = out[out.length - 1]
      if (previous !== undefined && /^\s*\|/.test(previous)) out.push('')
      const token = fence[1].toLowerCase()
      out.push(token === '' ? '```' : '```' + (LANGUAGE_ALIASES[token] ?? token))
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}
/** Escape nothing: card markdown takes the string verbatim. */

/** 一行表格：以 | 开头结尾，且至少两个单元格。 */
function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line)
}

/** 分隔行：|---|---| 或 |:--|--:| 等。 */
function isTableSeparator(line) {
  if (!isTableRow(line)) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/**
 * 把 markdown 切成「文本段」与「表格段」。
 *
 * 只认标准的 `| a | b |` + `|---|---|` 形态（模型实际产出的就是这种）。
 * 段落之间不做任何改写，文本段原样交给 markdown 元素。
 */
export function splitMarkdownTables(text) {
  const lines = String(text ?? '').split('\n')
  const segments = []
  let buffer = []
  let inFence = false

  const flushText = () => {
    if (buffer.length === 0) return
    const content = buffer.join('\n')
    if (content.trim() !== '') segments.push({ type: 'markdown', content })
    buffer = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      buffer.push(line)
      continue
    }
    if (inFence || !isTableRow(line)) {
      buffer.push(line)
      continue
    }
    // 表格必须有紧随其后的分隔行，否则只是含竖线的普通文本。
    const next = lines[i + 1]
    if (!next || !isTableSeparator(next)) {
      buffer.push(line)
      continue
    }
    const header = splitRow(line)
    const rows = []
    let j = i + 2
    while (j < lines.length && isTableRow(lines[j]) && !isTableSeparator(lines[j])) {
      rows.push(splitRow(lines[j]))
      j++
    }
    flushText()
    segments.push({ type: 'table', header, rows })
    i = j - 1
  }
  flushText()
  return segments
}

/** 表格段 → 飞书原生表格组件。 */
export function buildTableElement(segment, index = 0) {
  const { header, rows } = segment
  const width = Math.max(header.length, ...rows.map((row) => row.length))
  const columns = Array.from({ length: width }, (_, column) => ({
    name: 'c' + column,
    display_name: header[column] ?? '',
    // lark_md：单元格里保留 **粗体**、`代码`、链接；比 markdown 类型的客户端要求更低。
    data_type: 'lark_md',
    width: 'auto',
    horizontal_align: 'left',
    vertical_align: 'top',
  }))
  return {
    tag: 'table',
    element_id: 'table_' + index,
    page_size: 10,
    row_height: 'auto',
    header_style: { text_align: 'left', text_size: 'normal', background_style: 'grey', bold: true, lines: 1 },
    columns,
    rows: rows.map((row) => {
      const record = {}
      for (let column = 0; column < width; column++) record['c' + column] = row[column] ?? ''
      return record
    }),
  }
}

/**
 * Card 2.0 payload for a markdown body, with tables lifted into native components.
 *
 * `wide_screen_mode` matters: narrow cards wrap tables badly on a phone.
 */
export function buildMarkdownCard(text, { title = null, maxTables = MAX_CARD_TABLES } = {}) {
  const elements = []
  if (title) elements.push({ tag: 'markdown', content: '**' + title + '**' })

  const segments = splitMarkdownTables(normalizeFenceLanguages(text))
  let tables = 0
  let textBuffer = []
  const flush = () => {
    if (textBuffer.length === 0) return
    const content = textBuffer.join('\n\n')
    if (content.trim() !== '') elements.push({ tag: 'markdown', content })
    textBuffer = []
  }

  for (const segment of segments) {
    if (segment.type === 'markdown') {
      textBuffer.push(segment.content)
      continue
    }
    if (tables >= maxTables) {
      // 超过单卡上限：降级成文本，至少不露出满屏竖线。
      textBuffer.push(toLarkMd(renderTableAsMarkdown(segment)))
      continue
    }
    flush()
    elements.push(buildTableElement(segment, tables))
    tables++
  }
  flush()

  if (elements.length === 0) elements.push({ tag: 'markdown', content: String(text ?? '') })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    body: { elements },
  }
}

/** 表格段还原成 markdown（用于超限降级）。 */
function renderTableAsMarkdown(segment) {
  const header = '| ' + segment.header.join(' | ') + ' |'
  const separator = '|' + segment.header.map(() => '---').join('|') + '|'
  const rows = segment.rows.map((row) => '| ' + row.join(' | ') + ' |')
  return [header, separator, ...rows].join('\n')
}

/** Card 1.0 shape (fallback for tenants that reject 2.0). */
export function buildLegacyCard(text, { title = null } = {}) {
  return {
    config: { wide_screen_mode: true },
    ...(title ? { header: { title: { tag: 'plain_text', content: title } } } : {}),
    // lark_md 只认强调与链接；表格、代码块、行内代码先压成文本，避免露出符号。
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: toLarkMd(normalizeFenceLanguages(text)) } }],
  }
}

/**
 * Does this text actually contain markdown worth rendering?
 *
 * Cards look heavy for one-liners (a short acknowledgement becomes a big padded
 * block), so the transport only pays for a card when there is structure to render.
 * Deliberately conservative: a false negative just means plain text, which is what
 * we had before anyway.
 */
export function hasMarkdownSyntax(text) {
  if (typeof text !== 'string' || text === '') return false
  return (
    /(^|\n)\s{0,3}#{1,6}\s/.test(text) || // heading
    /(^|\n)\s{0,3}[-*+]\s+\S/.test(text) || // bullet list
    /(^|\n)\s{0,3}\d+[.)]\s+\S/.test(text) || // ordered list
    /(^|\n)\s{0,3}>\s/.test(text) || // blockquote
    /(^|\n)\s*\|.*\|/.test(text) || // table row
    /```/.test(text) || // fenced code
    /\*\*[^*\n]+\*\*/.test(text) || // bold
    /`[^`\n]+`/.test(text) || // inline code
    /\[[^\]\n]+\]\([^)\n]+\)/.test(text) // link
  )
}

/**
 * Build the `data` block for im.message.create / im.message.reply.
 *
 * @param {string} text markdown or plain text
 * @param {{format?: 'text'|'card', cardVersion?: '2.0'|'1.0', title?: string}} options
 */
export function buildMessagePayload(text, options = {}) {
  const { format = 'text', cardVersion = '2.0', title = null } = options
  if (format === 'card') {
    const card = cardVersion === '1.0' ? buildLegacyCard(text, { title }) : buildMarkdownCard(text, { title })
    return { msg_type: 'interactive', content: JSON.stringify(card) }
  }
  return { msg_type: 'text', content: JSON.stringify({ text }) }
}

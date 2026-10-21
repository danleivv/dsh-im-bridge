/**
 * markdown → Feishu-friendly plain text.
 *
 * Why: Feishu `msg_type: "text"` renders NOTHING — the user literally sees `##` and
 * `**`. Cards help only a little: `lark_md` supports bold/links, but headings, tables
 * and fenced code still show their markers. So the reliable fix is to send text that
 * reads well as text: strip the syntax, keep the structure.
 *
 * Design rules:
 *   - never lose content, only syntax
 *   - keep visual structure (headings stand out by being short lines, tables by
 *     aligned columns, code by indentation)
 *   - be boring and fast: regex passes, no dependencies, no state
 */

/** CJK characters occupy two terminal columns (for table alignment). */
function visualWidth(text) {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ? 2 : 1
  }
  return width
}

function pad(text, width) {
  return text + ' '.repeat(Math.max(0, width - visualWidth(text)))
}

/** Inline syntax inside a single line. */
export function stripInline(line) {
  return line
    // images: ![alt](url) -> alt（url）
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => (alt ? alt + '（' + url + '）' : url))
    // links: [text](url) -> text（url）
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => (text === url ? url : text + '（' + url + '）'))
    // bold / italic / strike: keep the text, drop the markers
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(（])\*([^*\n]+)\*(?=[\s)），。、！？]|$)/g, '$1$2')
    .replace(/(^|[\s(（])_([^_\n]+)_(?=[\s)），。、！？]|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    // inline code: `x` -> x
    .replace(/`([^`]+)`/g, '$1')
    // trailing hard-break markers
    .replace(/[ \t]{2,}$/g, '')
}

/**
 * Convert a markdown document to plain text that reads correctly in Feishu.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToText(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return ''
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let inFence = false
  let fenceLang = ''
  let tableBuffer = []

  const flushTable = () => {
    if (tableBuffer.length === 0) return
    const rows = tableBuffer
      .map((row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => stripInline(cell.trim())))
      // drop the |---|---| separator row
      .filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === ''))
    tableBuffer = []
    if (rows.length === 0) return
    const columns = Math.max(...rows.map((r) => r.length))
    const widths = []
    for (let c = 0; c < columns; c++) widths[c] = Math.max(...rows.map((r) => visualWidth(r[c] ?? '')))
    for (const row of rows) {
      const line = []
      for (let c = 0; c < columns; c++) {
        const cell = row[c] ?? ''
        line.push(c === columns - 1 ? cell : pad(cell, widths[c]))
      }
      out.push(line.join('  ').replace(/\s+$/, ''))
    }
    out.push('')
  }

  for (const rawLine of lines) {
    const fence = rawLine.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/)
    if (fence) {
      flushTable()
      if (!inFence) {
        inFence = true
        fenceLang = fence[2] ?? ''
        if (fenceLang) out.push('〔' + fenceLang + '〕')
      } else {
        inFence = false
        fenceLang = ''
        out.push('')
      }
      continue
    }
    if (inFence) {
      // keep code verbatim; a leading space keeps it visually distinct
      out.push('  ' + rawLine.replace(/\t/g, '  '))
      continue
    }

    const line = rawLine.replace(/\t/g, '  ')

    // table row (start of a table)
    if (/^\s*\|.*\|\s*$/.test(line)) {
      tableBuffer.push(line)
      continue
    }
    flushTable()

    if (line.trim() === '') {
      out.push('')
      continue
    }

    // horizontal rule
    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push('————————')
      continue
    }

    // heading: keep the text, make it stand out with a little space
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (heading) {
      const text = stripInline(heading[2]).replace(/\s*#+\s*$/, '')
      const level = heading[1].length
      out.push(level <= 2 ? text : '• ' + text)
      continue
    }

    // blockquote
    const quote = line.match(/^\s{0,3}>\s?(.*)$/)
    if (quote) {
      out.push('│ ' + stripInline(quote[1]))
      continue
    }

    // checkbox list (must precede the plain bullet rule, which also matches "- [ )")
    const task = line.match(/^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/)
    if (task) {
      out.push('  '.repeat(Math.floor(task[1].length / 2)) + (task[2].toLowerCase() === 'x' ? '☑ ' : '☐ ') + stripInline(task[3]))
      continue
    }

    // unordered list
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/)
    if (bullet) {
      const indent = '  '.repeat(Math.floor(bullet[1].length / 2))
      out.push(indent + '• ' + stripInline(bullet[2]))
      continue
    }

    // ordered list: keep the number, Feishu renders it fine as text
    const ordered = line.match(/^(\s*)(\d+[.)])\s+(.*)$/)
    if (ordered) {
      out.push('  '.repeat(Math.floor(ordered[1].length / 2)) + ordered[2] + ' ' + stripInline(ordered[3]))
      continue
    }

    out.push(stripInline(line))
  }
  flushTable()

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * markdown → lark_md（飞书卡片 1.0 的富文本子集）。
 *
 * lark_md 支持粗体、斜体、删除线、链接、@，但**不支持**标题、表格、代码块。
 * 因此这里保留它支持的强调语法，把不支持的结构压成整齐的纯文本，
 * 避免用户看到 `| a | b |` 或 ``` 这种符号。
 */
export function toLarkMd(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return ''
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let inFence = false
  let tableBuffer = []

  const flushTable = () => {
    if (tableBuffer.length === 0) return
    // lark_md 会折叠连续空格，所以不能用空格对齐；改用 ` │ ` 分隔，宽度变化也不会错位。
    const rows = tableBuffer
      .map((row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim()))
      .filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === ''))
    tableBuffer = []
    if (rows.length === 0) return
    rows.forEach((cells, index) => {
      out.push(cells.filter((cell) => cell !== '').join(' │ '))
      if (index === 0) out.push('─────')
    })
    out.push('')
  }

  for (const rawLine of lines) {
    const fence = rawLine.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/)
    if (fence) {
      flushTable()
      if (!inFence) {
        inFence = true
        // lark_md 不认 ``` 围栏，但直接去掉会让代码混进正文。用语言标记 + 行首 │
        // 明确"这是代码块"，比裸文本可读得多。
        out.push('〔' + (fence[2] || 'code') + '〕')
      } else {
        inFence = false
        out.push('')
      }
      continue
    }
    if (inFence) {
      out.push('│ ' + rawLine)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(rawLine)) {
      tableBuffer.push(rawLine)
      continue
    }
    flushTable()

    if (rawLine.trim() === '') {
      out.push('')
      continue
    }
    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(rawLine)) {
      out.push('————————')
      continue
    }
    const heading = rawLine.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (heading) {
      out.push('**' + heading[2].replace(/\s*#+\s*$/, '') + '**')
      continue
    }
    const quote = rawLine.match(/^\s{0,3}>\s?(.*)$/)
    if (quote) {
      out.push('│ ' + quote[1])
      continue
    }
    const bullet = rawLine.match(/^(\s*)[-*+]\s+(.*)$/)
    if (bullet) {
      out.push(bullet[1] + '• ' + bullet[2])
      continue
    }
    // 行内代码与图片用 lark_md 不支持的语法，退化为文本
    out.push(rawLine.replace(/`([^`]+)`/g, '$1').replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1'))
  }
  flushTable()
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

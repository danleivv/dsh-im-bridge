/**
 * Outbound Feishu message payloads.
 *
 * Why cards: a `text` message renders NO markdown at all — the user sees `##` and
 * `**` literally. Card 1.0's `lark_md` only covers bold/links; **card 2.0** has a
 * `markdown` element that renders headings, tables, lists and code blocks, which is
 * what an agent reply actually contains.
 *
 * Kept pure (no SDK, no network) so the exact JSON can be unit-tested and previewed.
 */
import { toLarkMd } from './markdown.mjs'

/** Escape nothing: card markdown takes the string verbatim. */

/**
 * Card 2.0 payload for a markdown body.
 *
 * `wide_screen_mode` matters: narrow cards wrap tables badly on a phone.
 */
export function buildMarkdownCard(text, { title = null } = {}) {
  const elements = []
  if (title) elements.push({ tag: 'markdown', content: '**' + title + '**' })
  elements.push({ tag: 'markdown', content: text })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    body: { elements },
  }
}

/** Card 1.0 shape (fallback for tenants that reject 2.0). */
export function buildLegacyCard(text, { title = null } = {}) {
  return {
    config: { wide_screen_mode: true },
    ...(title ? { header: { title: { tag: 'plain_text', content: title } } } : {}),
    // lark_md 只认强调与链接；表格、代码块、行内代码先压成文本，避免露出符号。
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: toLarkMd(text) } }],
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

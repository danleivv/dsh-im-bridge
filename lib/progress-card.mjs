/**
 * 长任务的进度卡片。
 *
 * 设计取舍：飞书卡片没有滚动容器，逐条发消息又会刷屏，所以采用
 * **一条消息 + 固定 5 行窗口 + 原地更新**（im.message.patch）：
 *
 *   🔄 第 12 轮 · 已 1m30s
 *   ✓ pwsh  ffmpeg -i clip_01.mp4        18.2s
 *   ▶ pwsh  python render.py --batch 3   1m02s · 进行中
 *   · 子 agent 调研回调机制               35s · 进行中
 *   共 4 条 · 更新于 3 秒前
 *
 * 不显示推理原文：内部推理噪音大、可能带业务数据，只显示「思考中（12s）」。
 * 窗口外的旧条目直接滚掉，底部用「共 N 条」保留总量。
 */

/** 窗口里最多显示几行。 */
export const PROGRESS_ROWS = 5

/** 两条更新之间的最小间隔（毫秒）——飞书对消息更新有频率限制。 */
export const PROGRESS_MIN_INTERVAL_MS = 1500

/** 心跳：即使没有新事件，也要刷新"已运行多久"，让人知道它还活着。 */
export const PROGRESS_HEARTBEAT_MS = 10000

/** 参数摘要的长度上限。 */
const SUMMARY_LIMIT = 52

/** 一条事件最多保留的历史（防止超长任务把内存撑爆）。 */
const MAX_ENTRIES = 60

export function createProgress(turn) {
  return {
    turn,
    startedAt: Date.now(),
    entries: [],
    total: 0,
    messageId: null,
    lastRenderAt: 0,
    pendingTimer: null,
    heartbeatTimer: null,
    finished: false,
  }
}

/** 工具名 + 参数摘要，压成一行。 */
export function summariseArgs(name, args, description) {
  // description 是模型自己写的一句话（DSH 输入框显示的就是它），比原始命令可读得多。
  if (typeof description === 'string' && description.trim() !== '') {
    const text = description.replace(/\s+/g, ' ').trim()
    return text.length > SUMMARY_LIMIT ? text.slice(0, SUMMARY_LIMIT - 1) + '…' : text
  }
  let text = ''
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      text = parsed.description ?? parsed.command ?? parsed.prompt ?? parsed.file_path ?? parsed.path ?? args
    } catch {
      text = args
    }
  } else if (args && typeof args === 'object') {
    text = args.description ?? args.command ?? args.prompt ?? args.file_path ?? args.path ?? JSON.stringify(args)
  }
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > SUMMARY_LIMIT ? flat.slice(0, SUMMARY_LIMIT - 1) + '…' : flat
}

export function recordToolCall(progress, { name, callId, args, description }) {
  if (!progress || progress.finished) return
  const entry = {
    kind: 'tool',
    name: String(name ?? 'tool'),
    callId: String(callId ?? ''),
    summary: summariseArgs(name, args, description),
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
  }
  progress.entries.push(entry)
  progress.total += 1
  if (progress.entries.length > MAX_ENTRIES) progress.entries.splice(0, progress.entries.length - MAX_ENTRIES)
  return entry
}

export function recordToolResult(progress, { callId }) {
  if (!progress || progress.finished) return
  const key = String(callId ?? '')
  // 从后往前找：同一工具可能被调用多次
  for (let i = progress.entries.length - 1; i >= 0; i--) {
    const entry = progress.entries[i]
    if (entry.callId === key && entry.status === 'running') {
      entry.endedAt = Date.now()
      entry.status = 'done'
      return entry
    }
  }
}

/** 记一条非工具的进展（子 agent、压缩、重试等）。 */
export function recordNote(progress, text) {
  if (!progress || progress.finished) return
  progress.entries.push({ kind: 'note', text: String(text), startedAt: Date.now(), endedAt: Date.now(), status: 'note' })
  progress.total += 1
  if (progress.entries.length > MAX_ENTRIES) progress.entries.splice(0, progress.entries.length - MAX_ENTRIES)
}

/** 毫秒 → 人类可读的短时长。 */
export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return seconds + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm' + String(seconds % 60).padStart(2, '0') + 's'
  return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm'
}

function statusIcon(entry, now) {
  if (entry.kind === 'note') return '·'
  if (entry.status === 'running') return '▶'
  return entry.status === 'done' ? '✓' : '✗'
}

function renderRow(entry, now, final = false) {
  const end = entry.endedAt ?? now
  const elapsed = formatElapsed(end - entry.startedAt)
  if (entry.kind === 'note') return '· ' + entry.text + '  ' + elapsed
  // 轮次已经结束却还在"进行中"，说明是被中断的（取消/崩溃），不能谎报状态。
  const tail = entry.status !== 'running' ? elapsed : final ? elapsed + ' · 未完成' : elapsed + ' · 进行中'
  const name = entry.name.length > 10 ? entry.name.slice(0, 10) : entry.name
  return statusIcon(entry, now) + ' ' + name + '  ' + (entry.summary || '（无参数）') + '  ' + tail
}

/**
 * 渲染成 markdown（卡片里的一个 markdown 元素）。
 *
 * @param {object} progress
 * @param {{now?: number, final?: boolean}} [options]
 */
export function renderProgressText(progress, options = {}) {
  if (!progress) return ''
  const now = options.now ?? Date.now()
  const elapsed = formatElapsed(now - progress.startedAt)
  const header = options.final
    ? '✅ 完成（第 ' + progress.turn + ' 轮 · 共 ' + elapsed + ' · ' + progress.total + ' 条）'
    : '🔄 正在处理（第 ' + progress.turn + ' 轮 · 已 ' + elapsed + '）'
  const rows = progress.entries.slice(-PROGRESS_ROWS).map((entry) => renderRow(entry, now, options.final === true))
  const hidden = Math.max(0, progress.total - rows.length)
  const footer = []
  if (hidden > 0) footer.push('共 ' + progress.total + ' 条（省略 ' + hidden + ' 条）')
  else footer.push('共 ' + progress.total + ' 条')
  if (!options.final) {
    const since = progress.lastRenderAt > 0 ? now - progress.lastRenderAt : 0
    footer.push(since <= 2000 ? '刚刚更新' : '更新于 ' + formatElapsed(since) + '前')
  }
  return [header, '', rows.join('\n'), '', footer.join(' · ')].join('\n')
}

/** 进度卡片（卡片 2.0，单 markdown 元素）。 */
export function renderProgressCard(progress, options = {}) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    body: { elements: [{ tag: 'markdown', content: renderProgressText(progress, options) }] },
  }
}

/**
 * 是否该更新了。
 *
 * 节流是必须的：飞书对消息更新有频率限制，而且客户端本身有 ~1-2 秒的渲染延迟，
 * 更新太频繁只会让数字乱跳。
 */
export function shouldUpdate(progress, now = Date.now(), interval = PROGRESS_MIN_INTERVAL_MS) {
  if (!progress) return false
  if (progress.messageId === null) return true // 第一次：建卡
  return now - progress.lastRenderAt >= interval
}

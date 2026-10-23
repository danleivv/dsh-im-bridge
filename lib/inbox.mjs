/**
 * 收到的文件往哪放、叫什么名字。
 *
 * 这块看着琐碎，但它是唯一直接写磁盘的入口，文件名来自聊天内容——
 * 一个 `..\..\Windows\System32\` 就能把文件写到任意位置，所以消毒规则必须先定死。
 *
 * 纯函数 + 一个写盘函数，方便单测。
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 默认目录名（项目目录下的隐藏目录）。 */
export const INBOX_DIR_NAME = '.dsh-im-bridge-inbox'

/** 单个文件上限：飞书资源接口本身限制 100 MB。 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024

/** 能直接当图片注入给模型的类型（DSH 只认这四种）。 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** DSH 的图片单张上限约为 20 MiB，留一点余量。 */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024

/** Windows 保留名，写成 `CON.txt` 也会出问题。 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

const MAX_NAME_LENGTH = 80

/**
 * 把聊天里给的文件名变成一个安全的叶子名。
 *
 * - 去掉所有目录成分（`../`、`C:\`、`/etc/`）
 * - 去掉控制字符与 Windows 非法字符
 * - 保留名加下划线前缀
 * - 空名兜底 `file`，过长截断但保留扩展名
 */
export function sanitizeFileName(rawName) {
  let name = String(rawName ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .trim()
  // 控制字符 + Windows 非法字符
  name = name.replace(/[\u0000-\u001f<>:"|?*]/g, '')
  // 只剩点号的名字（`.`、`..`）没有意义
  if (/^\.+$/.test(name)) name = ''
  name = name.trim()
  if (name === '') return 'file'

  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let safeBase = base
  if (RESERVED.has(safeBase.toLowerCase())) safeBase = '_' + safeBase
  if (safeBase === '') safeBase = 'file'

  const budget = MAX_NAME_LENGTH - ext.length
  if (safeBase.length > Math.max(1, budget)) safeBase = safeBase.slice(0, Math.max(1, budget))
  return safeBase + ext.slice(0, 16)
}

/** 同名不覆盖：`a.txt` → `a-1.txt` → `a-2.txt`。 */
export function uniquePath(dir, fileName) {
  const candidates = join(dir, fileName)
  if (!existsSync(candidates)) return candidates
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  for (let index = 1; index < 1000; index++) {
    const next = join(dir, base + '-' + index + ext)
    if (!existsSync(next)) return next
  }
  return join(dir, base + '-' + Date.now() + ext)
}

/** 今天这一批放哪：`<inbox>/YYYY-MM-DD/`。 */
export function dayDir(inboxDir, now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return join(inboxDir, now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()))
}

/**
 * 决定收件目录。
 *
 * 优先用配置里的目录；否则用会话工作目录下的隐藏目录（用户要求放项目里）；
 * 两者都拿不到时才退回用户主目录，避免直接失败。
 */
export function resolveInboxDir({ configured, cwd, home }) {
  if (configured && String(configured).trim() !== '') return String(configured).trim()
  if (cwd && String(cwd).trim() !== '') return join(String(cwd).trim(), INBOX_DIR_NAME)
  return join(home, INBOX_DIR_NAME)
}

const EXT_TO_MEDIA = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 按文件名/消息类型推断图片 MIME；不是图片返回 null。 */
export function mediaTypeForName(fileName, kind) {
  const lower = String(fileName ?? '').toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot >= 0) {
    const mapped = EXT_TO_MEDIA[lower.slice(dot)]
    if (mapped) return mapped
  }
  if (kind === 'image') return 'image/jpeg'
  return null
}

/** 判断这个附件能不能当图片注入给模型。 */
export function asImagePayload({ mediaType, bytes, buffer }) {
  const type = String(mediaType ?? '').toLowerCase()
  if (!IMAGE_MEDIA_TYPES.includes(type)) return null
  if (bytes > MAX_IMAGE_BYTES) return null
  return { mediaType: type, data: buffer.toString('base64') }
}

/**
 * 落盘。
 *
 * @returns {{ path: string, bytes: number }}
 */
export function saveAttachment({ inboxDir, fileName, buffer, now = new Date() }) {
  const dir = dayDir(inboxDir, now)
  mkdirSync(dir, { recursive: true })
  const target = uniquePath(dir, sanitizeFileName(fileName))
  writeFileSync(target, buffer)
  return { path: target, bytes: statSync(target).size }
}

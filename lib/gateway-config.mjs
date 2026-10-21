/**
 * gateway.json 读写。
 *
 * 凭据文件的写入要统一走这里：默认值合并、目录创建、权限收紧（Windows ACL / POSIX 0600）、
 * 以及永不回显密钥。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_ROOT = join(homedir(), '.dsh-im-bridge')
export const DEFAULT_FILE = join(DEFAULT_ROOT, 'gateway.json')

/** 写入时的默认值；已有配置里的同名键优先保留。 */
export const GATEWAY_DEFAULTS = {
  enabled: true,
  domain: 'feishu',
  replyFormat: 'card',
  cardVersion: '2.0',
  busyBehavior: 'steer',
  statusPrefix: '?',
  steerPrefix: '#',
  steerAckText: '已接收消息，当前工具调用结束后响应',
  ackEmoji: 'Get',
  onItEmoji: 'OnIt',
  doneEmoji: 'Done',
  autoPinFirstUser: true,
  allowUsers: [],
}

/** 读取配置文件；不存在或损坏时返回空对象。 */
export function readGatewayFile(file = DEFAULT_FILE) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** 密钥脱敏：只留首尾，中间用省略号。 */
export function maskSecret(value) {
  if (!value) return '(未设置)'
  const text = String(value)
  if (text.length <= 10) return '*'.repeat(text.length)
  return text.slice(0, 6) + '…' + text.slice(-2) + '  (' + text.length + ' 字符)'
}

/** 把文件权限收紧到当前用户。失败不致命，因为文件本就在仓库之外。 */
export function hardenFile(file) {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME
    if (!user) return
    try {
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], { stdio: 'ignore' })
    } catch {}
  } else {
    try {
      chmodSync(file, 0o600)
    } catch {}
  }
}

/**
 * 合并并写入配置。
 *
 * @param {object} values 需要写入的键（通常含 appId / appSecret）
 * @param {{file?: string}} [options]
 * @returns {{file: string, config: object}}
 */
export function writeGatewayFile(values, options = {}) {
  const file = options.file ?? DEFAULT_FILE
  const current = readGatewayFile(file)
  const config = { ...GATEWAY_DEFAULTS, ...current, ...values }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  hardenFile(file)
  return { file, config }
}

export function gatewayFileExists(file = DEFAULT_FILE) {
  return existsSync(file)
}

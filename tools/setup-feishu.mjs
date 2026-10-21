#!/usr/bin/env node
/**
 * setup-feishu.mjs — write the Feishu credentials without ever putting the secret
 * into a chat window, a shell history entry, or a command line.
 *
 * Why this exists: the app secret is a bearer credential for the bot. Typing it into
 * an agent conversation (or a shell command) copies it into transcripts, logs and
 * history. This tool reads it from a hidden prompt (or from the environment) and
 * writes ~/.cc-dsh-bridge/gateway.json with permissions limited to the current user.
 *
 * Usage:
 *   node tools/setup-feishu.mjs              # interactive: prompts, input hidden
 *   node tools/setup-feishu.mjs --from-env   # read FEISHU_APP_ID / FEISHU_APP_SECRET
 *   node tools/setup-feishu.mjs --show       # print current config with the secret masked
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ROOT = join(homedir(), '.cc-dsh-bridge')
const FILE = join(ROOT, 'gateway.json')
const args = process.argv.slice(2)
const fromEnv = args.includes('--from-env')
const show = args.includes('--show')

function load() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'))
  } catch {
    return {}
  }
}

function mask(value) {
  if (!value) return '(未设置)'
  return value.slice(0, 6) + '…' + value.slice(-2) + '  (' + value.length + ' 字符)'
}

if (show) {
  const config = load()
  console.log('配置文件: ' + FILE + (existsSync(FILE) ? '' : '（不存在）'))
  console.log('  enabled   = ' + (config.enabled === true))
  console.log('  appId     = ' + (config.appId ?? '(未设置)'))
  console.log('  appSecret = ' + mask(config.appSecret))
  console.log('  环境变量  = ' + (process.env.FEISHU_APP_SECRET ? '已设置（优先于文件）' : '未设置'))
  process.exit(0)
}

/** Read a line with echo disabled. Windows and POSIX both support raw mode on a TTY. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY) {
      reject(new Error('不是交互终端，请改用 --from-env 或直接编辑 ' + FILE))
      return
    }
    process.stdout.write(question)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const cleanup = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
    }
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (char === '\u0003') {
          cleanup()
          process.stdout.write('\n已取消\n')
          process.exit(130)
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        if (char >= ' ') {
          value += char
          process.stdout.write('*')
        }
      }
    }
    stdin.on('data', onData)
  })
}

/** Restrict the file to the current user; a world-readable credential file is a leak. */
function harden(file) {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME
    if (!user) return
    try {
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], { stdio: 'ignore' })
    } catch {
      // Non-fatal: the file is still outside the repository.
    }
  } else {
    try {
      chmodSync(file, 0o600)
    } catch {}
  }
}

async function main() {
  mkdirSync(ROOT, { recursive: true })
  const config = load()

  let appId
  let appSecret
  if (fromEnv) {
    appId = process.env.FEISHU_APP_ID
    appSecret = process.env.FEISHU_APP_SECRET
    if (!appId || !appSecret) {
      console.error('环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET 未设置')
      process.exit(1)
    }
    console.log('从环境变量读取凭据（不回显）')
  } else {
    console.log('凭据只写入 ' + FILE + '，不会显示、不会进入命令历史。')
    if (config.appId) console.log('当前 appId: ' + config.appId + '（直接回车可保留）')
    appId = (await promptHidden('app_id（cli_ 开头）: ')).trim() || config.appId
    appSecret = (await promptHidden('app_secret（输入不回显）: ')).trim() || config.appSecret
  }

  if (!appId) {
    console.error('缺少 app_id')
    process.exit(1)
  }
  if (!appSecret) {
    console.error('缺少 app_secret')
    process.exit(1)
  }

  const next = {
    ...config,
    enabled: true,
    appId,
    appSecret,
    domain: config.domain ?? 'feishu',
    replyFormat: config.replyFormat ?? 'card',
    cardVersion: config.cardVersion ?? '2.0',
    busyBehavior: config.busyBehavior ?? 'steer',
    statusPrefix: config.statusPrefix ?? '?',
    steerPrefix: config.steerPrefix ?? '#',
    steerAckText: config.steerAckText ?? '已接收消息，当前工具调用结束后响应',
    ackEmoji: config.ackEmoji ?? 'Get',
    onItEmoji: config.onItEmoji ?? 'OnIt',
    doneEmoji: config.doneEmoji ?? 'Done',
    autoPinFirstUser: config.autoPinFirstUser !== false,
    allowUsers: Array.isArray(config.allowUsers) ? config.allowUsers : [],
  }

  writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  harden(FILE)

  console.log('\n已写入 ' + FILE)
  console.log('  enabled   = true')
  console.log('  appId     = ' + appId)
  console.log('  appSecret = ' + mask(appSecret))
  console.log('\n重启 DSH 后生效。')
  console.log('提示：如果这个 secret 曾经出现在聊天或日志里，建议在飞书开放平台重置一次。')
}

main().catch((error) => {
  console.error('失败: ' + (error?.message ?? error))
  process.exit(1)
})

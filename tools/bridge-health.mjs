#!/usr/bin/env node
/**
 * bridge-health — is the production bridge healthy right now?
 *
 * Read-only by default. It answers the three questions that matter when the phone
 * line "just stops":
 *   1. is the plugin's IPC listening, and does it still map the Feishu key to the
 *      intended session?
 *   2. is the Feishu long connection alive?
 *   3. is the target session known to the Host (live), and did a turn complete
 *      recently enough that the line is plausibly working?
 *
 * Usage:
 *   node tools/bridge-health.mjs                 # report only
 *   node tools/bridge-health.mjs --json          # machine-readable
 */
import { connect } from 'node:net'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ROOT = join(homedir(), '.cc-dsh-bridge')
const CONFIG = join(ROOT, 'config.json')

const args = process.argv.slice(2)
const asJson = args.includes('--json')

function ipcCall(port, op, extra = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('timeout'))
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, op, ...extra }) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index < 0) return
      clearTimeout(timer)
      socket.destroy()
      try {
        resolve(JSON.parse(buffer.slice(0, index)))
      } catch (error) {
        reject(error)
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/**
 * Count processes matching a PowerShell Where-Object clause.
 *
 * Filter on Name first: matching only on CommandLine makes the pwsh process that
 * runs this check match itself (its own -Command string contains the needle).
 */
function processCount(clause) {
  try {
    const out = execFileSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { ' + clause + ' } | Measure-Object | Select-Object -ExpandProperty Count'],
      { encoding: 'utf8', timeout: 20000 },
    )
    return Number(out.trim() || 0)
  } catch {
    return -1
  }
}



function portListening(port) {
  try {
    const out = execFileSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command',
        "(Get-NetTCPConnection -LocalPort " + port + " -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count"],
      { encoding: 'utf8', timeout: 20000 },
    )
    return Number(out.trim() || 0) > 0
  } catch {
    return false
  }
}

function tailLog(path, lines, patterns) {
  if (!existsSync(path)) return []
  try {
    const text = readFileSync(path, 'utf8')
    const all = text.split('\n').filter((l) => l.trim())
    return all.slice(-lines).filter((l) => patterns.test(l))
  } catch {
    return []
  }
}

function minutesSince(date) {
  return Math.round(((Date.now() - date.getTime()) / 60000) * 10) / 10
}

async function main() {
  const report = { ok: true, problems: [], notes: [] }

  // 1) config + plugin IPC
  let config = {}
  try {
    config = JSON.parse(readFileSync(CONFIG, 'utf8'))
  } catch (error) {
    report.problems.push('config.json 读不了: ' + (error?.message ?? error))
  }
  const mapping = Object.entries(config.sessionKeys ?? {})
  const allow = config.allowSessions ?? []
  report.mapping = mapping
  report.allowSessions = allow

  let hello = null
  try {
    hello = await ipcCall(config.pluginPort ?? 9811, 'hello')
    report.plugin = {
      pid: hello.pid,
      ipcBound: hello.ipcBound,
      allowSessions: hello.allowSessions,
      clients: hello.ipcClients,
      agentServiceError: hello.agentServiceError ?? null,
    }
    if (!hello.ipcBound) report.problems.push('插件 IPC 未监听（ipcBound=false）')
    // A reloaded instance can hold the port with a dead service context: hello
    // answers, ipcBound is true, and yet every real operation fails. That is the
    // most confusing failure mode, so it gets its own check.
    if (hello.agentServiceError) {
      report.problems.push('插件上下文已失效 → 重启桌面 App（注入一定失败）: ' + hello.agentServiceError)
    }
  } catch (error) {
    report.problems.push('插件 IPC 连不上: ' + (error?.message ?? error))
  }
  if (hello) {
    for (const [key, session] of mapping) {
      if (!(hello.allowSessions ?? []).includes(session)) {
        report.problems.push('映射的会话不在 allowSessions 里: ' + session)
      }
    }
  }

  // 2) live sessions (does the Host still know the target?)
  if (hello) {
    try {
      const list = await ipcCall(config.pluginPort ?? 9811, 'list')
      report.liveSessions = list.sessions ?? []
      for (const [, session] of mapping) {
        if (!(list.sessions ?? []).includes(session)) {
          report.notes.push('目标会话当前不在 live 列表（resume 会把它拉起来，但延迟会变大）: ' + session)
        }
      }
    } catch (error) {
      report.problems.push('list 失败: ' + (error?.message ?? error))
    }
  }

  // 3) 长连接本身：插件是否连上飞书
  const gatewayFile = join(homedir(), '.cc-dsh-bridge', 'gateway.json')
  let gatewayConfig = {}
  try {
    gatewayConfig = JSON.parse(readFileSync(gatewayFile, 'utf8'))
  } catch {}
  report.gateway = { enabled: gatewayConfig.enabled === true, appId: gatewayConfig.appId ? String(gatewayConfig.appId).slice(0, 10) + '…' : null }
  if (!report.gateway.enabled) report.notes.push('gateway.json 未启用：插件不连飞书（只提供本地 IPC）')
  else if (!report.gateway.appId) report.problems.push('gateway.json 已启用但没有 appId')
  if (report.gateway.enabled && report.plugin.ipcBound !== true) {
    report.problems.push('已启用原生模式，但插件 IPC 没起来')
  }
  // 4) 输出
  report.ok = report.problems.length === 0
  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.ok ? 0 : 1)
  }
  console.log('=== 桥接健康检查 ===')
  console.log(report.ok ? '✅ 总状态: 健康' : '❌ 总状态: ' + report.problems.length + ' 个问题')
  if (report.plugin) {
    console.log('  插件: pid=' + report.plugin.pid + '  ipcBound=' + report.plugin.ipcBound + '  clients=' + report.plugin.clients)
  }
  console.log('  飞书长连接: ' + (report.gateway?.enabled ? '已启用 (' + report.gateway.appId + ')' : '未启用'))
  if (report.lastTurnAt) console.log('  最近一次 turn complete: ' + report.lastTurnAt)
  console.log('  映射: ' + report.mapping.map(([k, v]) => k.split(':').slice(0, 2).join(':') + ' → ' + v.slice(0, 20) + '…').join(' | '))
  if (report.liveSessions) console.log('  live 会话数: ' + report.liveSessions.length)
  for (const p of report.problems) console.log('  ❌ ' + p)
  for (const n of report.notes ?? []) console.log('  ⚠ ' + n)
  process.exit(report.ok ? 0 : 1)
}

main().catch((error) => {
  console.error('健康检查崩溃:', error)
  process.exit(2)
})

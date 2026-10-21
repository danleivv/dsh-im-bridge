#!/usr/bin/env node
/**
 * install-shims.mjs — 在 ~/.dsh-im-bridge/bin 里生成稳定的命令入口。
 *
 * 解决什么问题：插件装在 DSH 的 profile 目录里，路径随安装位置变化；而 agent 的
 * 当前目录通常是某个项目。让 agent 记绝对路径既丑又会失效。
 *
 * 做法：生成一个改名代理（Windows 是 .cmd，POSIX 是 shell 脚本），里面指向当前
 * 安装位置。插件每次更新后重跑一次本工具即可（插件启动时也会自动刷新）。
 *
 * 用法：
 *   node tools/install-shims.mjs                 # 生成/刷新入口
 *   node tools/install-shims.mjs --add-to-path   # 并把 bin 目录加进用户 PATH
 */
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const BIN_DIR = join(homedir(), '.dsh-im-bridge', 'bin')

/** 要暴露的命令 → 包内脚本。 */
export const SHIMS = {
  'dsh-feishu-send-file': 'tools/send-media.mjs',
  'dsh-feishu-chat-log': 'tools/chat-log.mjs',
  'dsh-feishu-setup': 'tools/feishu-setup-qr.mjs',
  'dsh-feishu-setup-manual': 'tools/setup-feishu.mjs',
}

/**
 * 生成入口脚本。幂等：内容相同也会覆盖，因为安装路径可能变。
 *
 * @param {{packageRoot?: string, binDir?: string}} [options]
 * @returns {{written: string[], binDir: string}}
 */
export function installShims(options = {}) {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT
  const binDir = options.binDir ?? BIN_DIR
  mkdirSync(binDir, { recursive: true })
  const written = []
  for (const [name, relative] of Object.entries(SHIMS)) {
    const script = join(packageRoot, relative)
    // Windows：.cmd 会被 PowerShell / cmd 按 PATHEXT 解析
    writeFileSync(join(binDir, name + '.cmd'), '@echo off\r\nnode "' + script + '" %*\r\n')
    // POSIX
    const shim = join(binDir, name)
    writeFileSync(shim, '#!/bin/sh\nexec node "' + script + '" "$@"\n')
    try {
      chmodSync(shim, 0o755)
    } catch {}
    written.push(name)
  }
  return { written, binDir }
}

/** 把 bin 目录追加到用户 PATH（幂等）。返回是否发生了修改。 */
export function addBinDirToUserPath(binDir = BIN_DIR) {
  if (process.platform === 'win32') {
    const current = process.env.Path ?? process.env.PATH ?? ''
    if (current.includes(binDir)) return false
    // 只改用户级 PATH，不动物理机级；用 PowerShell 的 API 避免 setx 截断。
    const next = current.split(';').filter(Boolean).concat(binDir).join(';')
    execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::SetEnvironmentVariable('Path', " + JSON.stringify(next) + ", 'User')"], { stdio: 'ignore' })
    return true
  }
  return false
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {

  const { written, binDir } = installShims()
  console.log('已生成 ' + written.length + ' 个命令入口于 ' + binDir)
  for (const name of written) console.log('  ' + name)
  if (process.argv.includes('--add-to-path')) {
    const changed = addBinDirToUserPath(binDir)
    console.log(changed ? '\n已把该目录加入用户 PATH（新开的终端生效）。' : '\n用户 PATH 里已有该目录。')
  } else {
    console.log('\n要让命令不带路径直接用，把这一行加进 PATH，或重跑并加 --add-to-path：')
    console.log('  ' + binDir)
  }
}

#!/usr/bin/env node
/**
 * feishu-setup-qr.mjs — 扫码创建飞书应用，并自动写入凭据。
 *
 * 流程：向飞书申请一个设备码 → 打印授权链接（可用手机飞书扫码或直接打开）→
 * 你在飞书里确认创建应用 → 本工具轮询拿到 app_id / app_secret → 写入
 * ~/.cc-dsh-bridge/gateway.json（权限收紧，密钥不回显）。
 *
 * 密钥全程不经过对话、命令行参数与 shell 历史。
 *
 * 用法：
 *   node tools/feishu-setup-qr.mjs                  # 国内版（accounts.feishu.cn）
 *   node tools/feishu-setup-qr.mjs --lark           # 国际版（accounts.larksuite.com）
 *   node tools/feishu-setup-qr.mjs --name "DSH 桥"   # 预填应用名
 *   node tools/feishu-setup-qr.mjs --no-write       # 只显示链接，不写配置
 */
import { beginRegistration, pollRegistration, FEISHU_DOMAIN, LARK_DOMAIN } from '../lib/feishu-registration.mjs'
import { maskSecret, writeGatewayFile } from '../lib/gateway-config.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback = undefined) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}

const domain = args.includes('--lark') ? LARK_DOMAIN : FEISHU_DOMAIN
const name = flag('name', 'cc-dsh-bridge')
const write = !args.includes('--no-write')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  console.log('正在向飞书申请授权码…')
  let session
  try {
    session = await beginRegistration({ domain, name })
  } catch (error) {
    console.error('申请失败: ' + (error?.message ?? error))
    console.error('检查网络能否访问 ' + domain)
    process.exit(1)
  }

  console.log('')
  console.log('  用手机飞书扫码或直接打开下面链接，在飞书里确认创建应用：')
  console.log('')
  console.log('    ' + session.verificationUrl)
  console.log('')
  if (session.userCode) console.log('  如果不能点链接，可在页面里输入此代码：' + session.userCode)
  console.log('  有效期约 ' + Math.round(session.expiresInMs / 60000) + ' 分钟。')
  console.log('')
  console.log('等待授权…（扫描并确认后会自动继续）')

  const deadline = Date.now() + session.expiresInMs
  let interval = session.intervalMs
  let currentDomain = session.domain

  while (Date.now() < deadline) {
    await sleep(interval)
    let result
    try {
      result = await pollRegistration({ domain: currentDomain, deviceCode: session.deviceCode })
    } catch (error) {
      console.log('  轮询出错，重试: ' + (error?.message ?? error))
      continue
    }

    if (result.status === 'switch') {
      console.log('  账号属于另一个区域，切换到 ' + result.domain)
      currentDomain = result.domain
      continue
    }
    if (result.status === 'slow_down') {
      interval += 5000
      console.log('  放慢轮询频率到 ' + Math.round(interval / 1000) + 's')
      continue
    }
    if (result.status === 'pending') continue
    if (result.status === 'failed') {
      console.error('\n授权失败: ' + result.reason)
      process.exit(1)
    }
    if (result.status === 'success') {
      console.log('\n授权成功。')
      console.log('  app_id     = ' + result.appId)
      console.log('  app_secret = ' + maskSecret(result.appSecret))
      console.log('  创建者     = ' + result.openId)
      if (write) {
        const { file, config } = writeGatewayFile({ enabled: true, appId: result.appId, appSecret: result.appSecret })
        console.log('\n已写入 ' + file + '（权限已收紧到当前用户）')
        if (Array.isArray(config.allowUsers) && config.allowUsers.length === 0) {
          console.log('提示：把创建者的 open_id 填进 allowUsers 可锁定只有你能使用：')
          console.log('      "allowUsers": ["' + result.openId + '"]')
        }
        console.log('\n重启 DSH 后生效。')
      } else {
        console.log('\n未写入配置（--no-write）。')
      }
      return
    }
  }

  console.error('\n授权超时，请重新运行。')
  process.exit(1)
}

main().catch((error) => {
  console.error('失败: ' + (error?.message ?? error))
  process.exit(1)
})

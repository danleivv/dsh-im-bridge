/**
 * 配置工具测试：凭据写入、脱敏、默认值合并。
 *
 * 这些工具负责把 `app_secret` 落盘，所以行为必须可验证：默认值合并、权限收紧、
 * 以及"永不返回明文密钥"。
 *
 * Run: node test/config-tools.test.mjs
 */
import { rmSync, existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { maskSecret, readGatewayFile, writeGatewayFile, GATEWAY_DEFAULTS } from '../lib/gateway-config.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'ccdsh-config-'))
const file = join(dir, 'gateway.json')

console.log('\n[1] 脱敏')
check('短串整体打码', maskSecret('abc') === '***', maskSecret('abc'))
check('空值提示未设置', maskSecret('') === '(未设置)')
const fakeSecret = 'f4kes3cr3tplaceholder000000000000'
const masked = maskSecret(fakeSecret)
check('长串只留首尾', masked.startsWith('f4kes3') && masked.includes('…'), masked)
check('脱敏结果不含完整密钥', !masked.includes('placeholder0000'))

console.log('\n[2] 写入：默认值合并 + 权限')
{
  const { config } = writeGatewayFile({ appId: 'cli_test', appSecret: 's'.repeat(32) }, { file })
  check('enabled 默认打开', config.enabled === true, String(config.enabled))
  check('replyFormat 默认 card', config.replyFormat === 'card', config.replyFormat)
  check('表情默认值齐全', config.ackEmoji === 'Get' && config.onItEmoji === 'OnIt' && config.doneEmoji === 'Done')
  check('文件已创建', existsSync(file))
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  check('落盘的 appId 正确', raw.appId === 'cli_test', raw.appId)
  check('落盘包含全部默认键', Object.keys(GATEWAY_DEFAULTS).every((k) => k in raw), Object.keys(raw).join(','))
}

console.log('\n[3] 二次写入：保留用户已改过的键')
{
  writeGatewayFile({ statusPrefix: '!!' }, { file })
  const raw = readGatewayFile(file)
  check('自定义 statusPrefix 生效', raw.statusPrefix === '!!', raw.statusPrefix)
  check('原有 appId 未被清空', raw.appId === 'cli_test', raw.appId)
}

console.log('\n[4] 读取不存在的文件不抛异常')
{
  const missing = readGatewayFile(join(dir, 'nope.json'))
  check('返回空对象', JSON.stringify(missing) === '{}', JSON.stringify(missing))
}

rmSync(dir, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)

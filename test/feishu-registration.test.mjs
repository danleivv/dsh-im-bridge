/**
 * 设备码注册流程测试（不联网，用假 fetch）。
 *
 * 这段代码决定“扫码后能否自动拿到凭据”，失败模式都在状态机里：
 * pending / slow_down / 区域切换 / 拒绝 / 过期 / 成功。
 *
 * Run: node test/feishu-registration.test.mjs
 */
import { beginRegistration, pollRegistration, decorateVerificationUrl, FEISHU_DOMAIN, LARK_DOMAIN } from '../lib/feishu-registration.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

/** 构造一个按顺序返回预设响应的假 fetch，并记录请求。 */
function fakeFetch(responses) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, body: init?.body })
    const next = responses.shift()
    if (!next) throw new Error('没有更多预设响应')
    return { status: next.status ?? 200, text: async () => JSON.stringify(next.body ?? {}) }
  }
  impl.calls = calls
  return impl
}

console.log('\n[1] 授权链接补参数')
{
  const decorated = decorateVerificationUrl('https://open.feishu.cn/page/launcher?user_code=ABCD-1234', { name: '我的桥' })
  const url = new URL(decorated)
  check('保留 user_code', url.searchParams.get('user_code') === 'ABCD-1234', decorated)
  check('加 from=sdk', url.searchParams.get('from') === 'sdk')
  check('加 tp=sdk', url.searchParams.get('tp') === 'sdk')
  check('加 source', (url.searchParams.get('source') ?? '').includes('dsh-im-bridge'), url.searchParams.get('source'))
  check('name 预填', url.searchParams.get('name') === '我的桥')
  const withoutName = new URL(decorateVerificationUrl('https://x.y/z'))
  check('没给 name 时不加该参数', withoutName.searchParams.get('name') === null)
}

console.log('\n[2] begin 的请求与解析')
{
  const fetchImpl = fakeFetch([
    { body: { device_code: 'dc-1', verification_uri_complete: 'https://open.feishu.cn/page/launcher?user_code=AAAA-1', user_code: 'AAAA-1', interval: 3, expires_in: 900 } },
  ])
  const session = await beginRegistration({ fetchImpl, name: '测试' })
  check('device_code 解析正确', session.deviceCode === 'dc-1', session.deviceCode)
  check('user_code 解析正确', session.userCode === 'AAAA-1', session.userCode)
  check('interval 转成毫秒', session.intervalMs === 3000, String(session.intervalMs))
  check('expires 转成毫秒', session.expiresInMs === 900000, String(session.expiresInMs))
  const body = fetchImpl.calls[0].body
  check('表单带 action=begin', body.includes('action=begin'), body)
  check('表单带 archetype', body.includes('archetype=PersonalAgent'), body)
  check('表单带 auth_method', body.includes('auth_method=client_secret'), body)
  check('表单带 request_user_info', body.includes('request_user_info=open_id'), body)
  check('默认打国内域名', fetchImpl.calls[0].url.startsWith(FEISHU_DOMAIN), fetchImpl.calls[0].url)
}

console.log('\n[3] begin 缺字段要报错')
{
  let threw = false
  try {
    await beginRegistration({ fetchImpl: fakeFetch([{ body: { user_code: 'X' } }]) })
  } catch {
    threw = true
  }
  check('没有 device_code 时抛错', threw)
}

console.log('\n[4] poll 状态机')
{
  const pending = await pollRegistration({ domain: FEISHU_DOMAIN, deviceCode: 'dc', fetchImpl: fakeFetch([{ status: 400, body: { error: 'authorization_pending' } }]) })
  check('pending（HTTP 400 也算正常状态）', pending.status === 'pending', JSON.stringify(pending))

  const slow = await pollRegistration({ domain: FEISHU_DOMAIN, deviceCode: 'dc', fetchImpl: fakeFetch([{ status: 400, body: { error: 'slow_down' } }]) })
  check('slow_down', slow.status === 'slow_down')

  const denied = await pollRegistration({ domain: FEISHU_DOMAIN, deviceCode: 'dc', fetchImpl: fakeFetch([{ body: { error: 'access_denied' } }]) })
  check('拒绝', denied.status === 'failed' && denied.reason.includes('拒绝'), JSON.stringify(denied))

  const expired = await pollRegistration({ domain: FEISHU_DOMAIN, deviceCode: 'dc', fetchImpl: fakeFetch([{ body: { error: 'expired_token' } }]) })
  check('过期', expired.status === 'failed' && expired.reason.includes('过期'), JSON.stringify(expired))

  const success = await pollRegistration({
    domain: FEISHU_DOMAIN,
    deviceCode: 'dc',
    fetchImpl: fakeFetch([{ body: { client_id: 'cli_abc', client_secret: 'sec', user_info: { open_id: 'ou_1' } } }]),
  })
  check('成功拿到凭据', success.status === 'success' && success.appId === 'cli_abc' && success.appSecret === 'sec', JSON.stringify({ ...success, appSecret: '***' }))
  check('带回安装者 open_id', success.openId === 'ou_1', success.openId)

  const empty = await pollRegistration({ domain: FEISHU_DOMAIN, deviceCode: 'dc', fetchImpl: fakeFetch([{ body: {} }]) })
  check('空响应视为 pending', empty.status === 'pending')
}

console.log('\n[5] 区域切换')
{
  const toLark = await pollRegistration({ domain: FEISHU_DOMAIN, deviceCode: 'dc', fetchImpl: fakeFetch([{ body: { user_info: { tenant_brand: 'lark' } } }]) })
  check('飞书账号扫到国际版 → 切 larksuite', toLark.status === 'switch' && toLark.domain === LARK_DOMAIN, JSON.stringify(toLark))

  const toFeishu = await pollRegistration({ domain: LARK_DOMAIN, deviceCode: 'dc', fetchImpl: fakeFetch([{ body: { user_info: { tenant_brand: 'feishu' } } }]) })
  check('国际版账号扫到飞书 → 切回', toFeishu.status === 'switch' && toFeishu.domain === FEISHU_DOMAIN, JSON.stringify(toFeishu))

  const same = await pollRegistration({ domain: LARK_DOMAIN, deviceCode: 'dc', fetchImpl: fakeFetch([{ body: { error: 'authorization_pending', user_info: { tenant_brand: 'lark' } } }]) })
  check('已在正确域名时不反复切换', same.status === 'pending', JSON.stringify(same))
}

console.log('\n[6] 成功响应缺 open_id 要报错')
{
  let threw = false
  try {
    await pollRegistration({ domain: FEISHU_DOMAIN, deviceCode: 'dc', fetchImpl: fakeFetch([{ body: { client_id: 'a', client_secret: 'b' } }]) })
  } catch {
    threw = true
  }
  check('抛错而不是写入半套凭据', threw)
}

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)

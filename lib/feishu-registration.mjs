/**
 * 飞书应用注册（设备码流程，RFC 8628）。
 *
 * 流程只有两步，都打同一个端点：
 *
 *   begin   POST <domain>/oauth/v1/app/registration
 *           action=begin & archetype=PersonalAgent & auth_method=client_secret
 *           & request_user_info=open_id
 *        → { device_code, verification_uri_complete, user_code, interval, expires_in }
 *
 *   poll    POST 同一端点，action=poll & device_code=<...>
 *        → { error: "authorization_pending" }      继续等
 *          { error: "slow_down" }                  间隔 +5s
 *          { client_id, client_secret, user_info:{ open_id } }   成功
 *          { error: "access_denied" | "expired_token" }          失败
 *
 * 关键在于：**授权用的是扫码者自己的身份**，调用方不需要预先注册任何应用，
 * 也不需要携带 client_id。用户扫一下，飞书就把新建应用的凭据交还。
 *
 * 国内用 accounts.feishu.cn，国际用 accounts.larksuite.com。若 poll 返回
 * user_info.tenant_brand 与当前域名不一致，需要切换域名后立即重试（这是服务端
 * 只发一次的提示）。
 */

export const FEISHU_DOMAIN = 'https://accounts.feishu.cn'
export const LARK_DOMAIN = 'https://accounts.larksuite.com'
export const REGISTRATION_PATH = '/oauth/v1/app/registration'

/** 给二维码 URL 加上飞书期望的遥测参数，并可用 name 预填应用名。 */
export function decorateVerificationUrl(raw, { source = 'dsh-im-bridge', name = '' } = {}) {
  const url = new URL(raw)
  url.searchParams.set('from', 'sdk')
  url.searchParams.set('tp', 'sdk')
  url.searchParams.set('source', 'go-sdk/' + source)
  if (name) url.searchParams.set('name', name)
  return url.toString()
}

async function postForm(fetchImpl, domain, form) {
  const response = await fetchImpl(domain.replace(/\/$/, '') + REGISTRATION_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  const text = await response.text()
  if (!text) throw new Error('registration: 空响应 (HTTP ' + response.status + ')')
  try {
    // 设备码流程用 HTTP 400 携带 authorization_pending，所以先解析再判断状态码。
    return JSON.parse(text)
  } catch {
    throw new Error('registration: 无法解析响应 (HTTP ' + response.status + '): ' + text.slice(0, 200))
  }
}

/**
 * 开始一次注册会话。
 *
 * @param {{domain?: string, fetchImpl?: Function, name?: string, source?: string}} options
 * @returns {Promise<{deviceCode: string, verificationUrl: string, userCode: string, intervalMs: number, expiresInMs: number, domain: string}>}
 */
export async function beginRegistration(options = {}) {
  const { domain = FEISHU_DOMAIN, fetchImpl = globalThis.fetch, name = '', source = 'dsh-im-bridge' } = options
  const body = await postForm(fetchImpl, domain, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  })
  if (body.error) throw new Error('registration: ' + body.error + (body.error_description ? ' — ' + body.error_description : ''))
  if (!body.device_code) throw new Error('registration: 响应里没有 device_code')
  if (!body.verification_uri_complete) throw new Error('registration: 响应里没有 verification_uri_complete')
  return {
    deviceCode: body.device_code,
    verificationUrl: decorateVerificationUrl(body.verification_uri_complete, { source, name }),
    userCode: body.user_code ?? '',
    intervalMs: (Number(body.interval) > 0 ? Number(body.interval) : 5) * 1000,
    expiresInMs: (Number(body.expires_in) > 0 ? Number(body.expires_in) : 600) * 1000,
    domain,
  }
}

/**
 * 轮询一次。
 *
 * @returns {Promise<{status: 'pending'|'slow_down'|'success'|'failed'|'switch', ...}>}
 */
export async function pollRegistration({ domain, deviceCode, fetchImpl = globalThis.fetch }) {
  const body = await postForm(fetchImpl, domain, { action: 'poll', device_code: deviceCode })

  // 区域不匹配：服务端只提示一次，必须立刻用新域名重试。
  const brand = body.user_info?.tenant_brand
  if (brand === 'lark' && !domain.startsWith(LARK_DOMAIN)) {
    return { status: 'switch', domain: LARK_DOMAIN }
  }
  if (brand === 'feishu' && !domain.startsWith(FEISHU_DOMAIN)) {
    return { status: 'switch', domain: FEISHU_DOMAIN }
  }

  if (body.client_id && body.client_secret) {
    const openId = body.user_info?.open_id
    if (!openId) throw new Error('registration: 成功响应缺少 open_id')
    return { status: 'success', appId: body.client_id, appSecret: body.client_secret, openId }
  }

  if (body.error === 'authorization_pending') return { status: 'pending' }
  if (body.error === 'slow_down') return { status: 'slow_down' }
  if (body.error === 'access_denied') return { status: 'failed', reason: '用户拒绝授权' }
  if (body.error === 'expired_token') return { status: 'failed', reason: '授权已过期，请重新开始' }
  if (!body.error) return { status: 'pending' } // 授权跳转期间的空响应
  return { status: 'failed', reason: body.error + (body.error_description ? ' — ' + body.error_description : '') }
}

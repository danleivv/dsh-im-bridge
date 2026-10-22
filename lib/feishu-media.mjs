/**
 * 发送文件、图片、视频到飞书。
 *
 * 飞书发媒体的流程是两步：先把文件上传换成 key，再用 key 发消息。
 *
 *   图片  POST im/v1/images  → image_key → msg_type: "image"
 *   视频  POST im/v1/files   → file_key  → msg_type: "media"（可带封面 image_key）
 *   音频  POST im/v1/files   → file_key  → msg_type: "audio"（仅支持 opus）
 *   文件  POST im/v1/files   → file_key  → msg_type: "file"
 *
 * 限制：图片 ≤ 10 MB，文件/视频 ≤ 30 MB，且不能为空文件。
 *
 * 分类与载荷构造是纯函数，便于测试；真正上传走 createMediaSender()。
 */
import { createReadStream, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.tif', '.tiff', '.heic'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v'])
const AUDIO_EXT = new Set(['.opus', '.ogg'])

/** 飞书 im/v1/files 的 file_type 枚举里，只有这几种文档类型有专属值。 */
const DOC_FILE_TYPE = { '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc', '.xls': 'xls', '.xlsx': 'xls', '.ppt': 'ppt', '.pptx': 'ppt' }

export const IMAGE_LIMIT_BYTES = 10 * 1024 * 1024
export const FILE_LIMIT_BYTES = 30 * 1024 * 1024

/**
 * 判断一个文件该走哪条上传与消息路径。
 *
 * @param {string} filePath
 * @returns {{kind: 'image'|'video'|'audio'|'file', msgType: string, fileType?: string, limitBytes: number}}
 */
export function classifyFile(filePath) {
  const ext = extname(String(filePath)).toLowerCase()
  if (IMAGE_EXT.has(ext)) return { kind: 'image', msgType: 'image', limitBytes: IMAGE_LIMIT_BYTES }
  if (VIDEO_EXT.has(ext)) return { kind: 'video', msgType: 'media', fileType: 'mp4', limitBytes: FILE_LIMIT_BYTES }
  if (AUDIO_EXT.has(ext)) return { kind: 'audio', msgType: 'audio', fileType: 'opus', limitBytes: FILE_LIMIT_BYTES }
  return { kind: 'file', msgType: 'file', fileType: DOC_FILE_TYPE[ext] ?? 'stream', limitBytes: FILE_LIMIT_BYTES }
}

/** 上传前校验：存在、非空、未超限。返回字节数。 */
export function checkUploadable(filePath, limitBytes) {
  let stat
  try {
    stat = statSync(filePath)
  } catch {
    throw new Error('文件不存在: ' + filePath)
  }
  if (!stat.isFile()) throw new Error('不是普通文件: ' + filePath)
  if (stat.size === 0) throw new Error('不能发送空文件: ' + filePath)
  if (stat.size > limitBytes) {
    throw new Error('文件过大（' + (stat.size / 1024 / 1024).toFixed(1) + ' MB），上限 ' + (limitBytes / 1024 / 1024) + ' MB: ' + basename(filePath))
  }
  return stat.size
}

/**
 * 构造发消息的 data 字段。
 *
 * @param {{kind: string, msgType: string, fileKey?: string, imageKey?: string, coverKey?: string, fileName?: string}} input
 */
export function buildMediaMessage(input) {
  const { kind, msgType, fileKey, imageKey, coverKey, fileName } = input
  if (kind === 'image') {
    if (!imageKey) throw new Error('图片消息缺少 image_key')
    return { msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) }
  }
  if (kind === 'video') {
    // 视频用 media，可选封面；没有封面也能发，客户端显示默认图。
    if (!fileKey) throw new Error('视频消息缺少 file_key')
    return { msg_type: 'media', content: JSON.stringify({ file_key: fileKey, ...(coverKey ? { image_key: coverKey } : {}) }) }
  }
  if (!fileKey) throw new Error('文件消息缺少 file_key')
  return { msg_type: msgType, content: JSON.stringify({ file_key: fileKey, ...(fileName ? { file_name: fileName } : {}) }) }
}

/**
 * 创建发送器。
 *
 * @param {{client: object, log?: Function}} options
 */
export function createMediaSender({ client, log = () => {} }) {
  async function uploadImage(filePath) {
    const response = await client.im.image.create({
      data: { image_type: 'message', image: createReadStream(filePath) },
    })
    const key = response?.image_key ?? response?.data?.image_key
    if (!key) throw new Error('图片上传失败: ' + JSON.stringify(response).slice(0, 200))
    return key
  }

  async function uploadFile(filePath, fileType) {
    const response = await client.im.file.create({
      data: { file_type: fileType, file_name: basename(filePath), file: createReadStream(filePath) },
    })
    const key = response?.file_key ?? response?.data?.file_key
    if (!key) throw new Error('文件上传失败: ' + JSON.stringify(response).slice(0, 200))
    return key
  }

  /**
   * 发送一个文件到聊天。
   *
   * @param {{chatId: string, filePath: string, coverPath?: string}} input
   * @returns {Promise<{messageId: string, kind: string, bytes: number}>}
   */
  async function send({ chatId, filePath, coverPath }) {
    const classification = classifyFile(filePath)
    const bytes = checkUploadable(filePath, classification.limitBytes)
    log('uploading ' + classification.kind + ' ' + basename(filePath) + ' (' + (bytes / 1024).toFixed(0) + ' KB)')

    let imageKey
    let fileKey
    let coverKey
    if (classification.kind === 'image') {
      imageKey = await uploadImage(filePath)
    } else {
      fileKey = await uploadFile(filePath, classification.fileType)
      if (classification.kind === 'video' && coverPath) {
        checkUploadable(coverPath, IMAGE_LIMIT_BYTES)
        coverKey = await uploadImage(coverPath)
      }
    }

    const payload = buildMediaMessage({ kind: classification.kind, msgType: classification.msgType, fileKey, imageKey, coverKey })
    let response
    try {
      response = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, ...payload },
      })
    } catch (error) {
      // SDK 对非 2xx 直接抛异常，错误码在 error.response.data 里
      throw new Error('发送失败 ' + describeSendError(error))
    }
    if (response?.code && response.code !== 0) {
      throw new Error('发送失败 ' + describeSendError({ response: { data: response } }))
    }
    const messageId = response?.data?.message_id ?? ''
    log('sent ' + classification.kind + ' to ' + chatId + ' (' + messageId + ')')
    return { messageId, kind: classification.kind, bytes }
  }

  return { send, classifyFile, checkUploadable }
}

/**
 * 把飞书的错误码翻译成能直接照做的说明。
 *
 * 230001 / 230002 是发媒体时最常见的两种失败，而且都不是"文件有问题"：
 *
 *   230001 invalid receive_id —— receive_id 不是本应用可达的会话（常见于占位值，如 oc_gateway_test）
 *   230002 bot not in chat   —— 这个会话属于**另一个应用**；飞书 chat_id 按应用隔离
 *
 * 后者最容易被误判成"机器人没权限"，其实是"你把老机器人那侧的 chat_id 拿来用了"。
 */
export function describeSendError(error) {
  const data = error?.response?.data ?? {}
  const code = data.code ?? null
  const raw = data.msg ?? error?.message ?? String(error)
  const base = 'code=' + (code ?? '?') + ' ' + raw
  if (code === 230001) {
    return base + '\n  → receive_id 不是本应用可达的会话：检查是否用了占位值（如 oc_gateway_test），' +
      '或改用本机器人最近收到消息的那个 chat_id（见 ~/.dsh-im-bridge/last-chat.json）'
  }
  if (code === 230002) {
    return base + '\n  → 这个会话属于**另一个飞书应用**（chat_id 按应用隔离）。' +
      '同一会话在老机器人那边是另一个 chat_id；请用本机器人自己的会话，' +
      '或在 gateway.json 设置 defaultChat 指向本机器人的私聊'
  }
  if (code === 234003 || /file size|too large/i.test(raw)) {
    return base + '\n  → 超过上限：图片 10 MB，其他 30 MB'
  }
  return base
}

/**
 * 媒体发送测试（不联网）。
 *
 * 分类错、载荷错、上限错，都只会在真机上表现为“文件发不出去”或“发出去打不开”。
 *
 * Run: node test/feishu-media.test.mjs
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifyFile, checkUploadable, buildMediaMessage, createMediaSender, IMAGE_LIMIT_BYTES, FILE_LIMIT_BYTES } from '../lib/feishu-media.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'ccdsh-media-'))

console.log('\n[1] 分类')
for (const [file, kind, msgType] of [
  ['a.png', 'image', 'image'],
  ['a.JPG', 'image', 'image'],
  ['a.gif', 'image', 'image'],
  ['a.mp4', 'video', 'media'],
  ['a.mov', 'video', 'media'],
  ['a.opus', 'audio', 'audio'],
  ['a.pdf', 'file', 'file'],
  ['a.docx', 'file', 'file'],
  ['a.zip', 'file', 'file'],
  ['noext', 'file', 'file'],
]) {
  const c = classifyFile(file)
  check(file + ' → ' + kind, c.kind === kind && c.msgType === msgType, JSON.stringify(c))
}

console.log('\n[2] 上传类型映射')
check('pdf 用 pdf 类型', classifyFile('x.pdf').fileType === 'pdf', classifyFile('x.pdf').fileType)
check('xlsx 归到 xls', classifyFile('x.xlsx').fileType === 'xls', classifyFile('x.xlsx').fileType)
check('未知扩展名用 stream', classifyFile('x.bin').fileType === 'stream', classifyFile('x.bin').fileType)
check('mp4 用 mp4 类型', classifyFile('x.mp4').fileType === 'mp4')
check('opus 用 opus 类型', classifyFile('x.opus').fileType === 'opus')

console.log('\n[3] 上限')
check('图片上限 10MB', classifyFile('a.png').limitBytes === IMAGE_LIMIT_BYTES, String(classifyFile('a.png').limitBytes))
check('文件上限 30MB', classifyFile('a.zip').limitBytes === FILE_LIMIT_BYTES, String(classifyFile('a.zip').limitBytes))

console.log('\n[4] 校验')
{
  const empty = join(dir, 'empty.md')
  writeFileSync(empty, '')
  let threw = false
  try { checkUploadable(empty, FILE_LIMIT_BYTES) } catch (error) { threw = /空文件/.test(error.message) }
  check('空文件被拒', threw)

  let missing = false
  try { checkUploadable(join(dir, 'nope.md'), FILE_LIMIT_BYTES) } catch (error) { missing = /不存在/.test(error.message) }
  check('不存在的文件被拒', missing)

  const big = join(dir, 'big.bin')
  writeFileSync(big, Buffer.alloc(2048))
  let tooBig = false
  try { checkUploadable(big, 1024) } catch (error) { tooBig = /过大/.test(error.message) }
  check('超限被拒', tooBig)

  const ok = join(dir, 'ok.md')
  writeFileSync(ok, 'hello')
  check('正常文件返回字节数', checkUploadable(ok, FILE_LIMIT_BYTES) === 5)
}

console.log('\n[5] 载荷构造')
{
  check('图片载荷', JSON.parse(buildMediaMessage({ kind: 'image', msgType: 'image', imageKey: 'ik' }).content).image_key === 'ik')
  const video = buildMediaMessage({ kind: 'video', msgType: 'media', fileKey: 'fk', coverKey: 'ck' })
  check('视频用 media 且带封面', video.msg_type === 'media' && JSON.parse(video.content).image_key === 'ck', video.msg_type)
  const videoNoCover = buildMediaMessage({ kind: 'video', msgType: 'media', fileKey: 'fk' })
  check('视频可以没有封面', JSON.parse(videoNoCover.content).image_key === undefined)
  const doc = buildMediaMessage({ kind: 'file', msgType: 'file', fileKey: 'fk', fileName: '报告.pdf' })
  check('文件带文件名', doc.msg_type === 'file' && JSON.parse(doc.content).file_name === '报告.pdf', doc.msg_type)
  let threw = false
  try { buildMediaMessage({ kind: 'image', msgType: 'image' }) } catch { threw = true }
  check('缺 key 时报错', threw)
}

console.log('\n[6] 发送流程（假 client）')
{
  const calls = []
  const client = {
    im: {
      image: { create: async ({ data }) => { calls.push({ up: 'image', type: data.image_type }); return { image_key: 'img-key' } } },
      file: { create: async ({ data }) => { calls.push({ up: 'file', type: data.file_type, name: data.file_name }); return { file_key: 'file-key' } } },
      message: { create: async ({ data }) => { calls.push({ send: data.msg_type, content: data.content, to: data.receive_id }); return { code: 0, data: { message_id: 'om_1' } } } },
    },
  }
  const sender = createMediaSender({ client })

  const png = join(dir, 'p.png')
  writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
  const r1 = await sender.send({ chatId: 'oc_1', filePath: png })
  check('图片先上传再发送', calls[0].up === 'image' && calls[1].send === 'image' && r1.messageId === 'om_1', JSON.stringify(calls))

  const pdf = join(dir, 'd.pdf')
  writeFileSync(pdf, 'pdf-bytes')
  await sender.send({ chatId: 'oc_2', filePath: pdf })
  const upload = calls.find((c) => c.up === 'file' && c.name === 'd.pdf')
  const send = calls.at(-1)
  check('文件用 pdf 类型上传', upload?.type === 'pdf', JSON.stringify(upload))
  check('文件消息发到指定聊天', send.send === 'file' && send.to === 'oc_2', JSON.stringify(send))

  // 失败路径：API 返回错误码要抛出
  const badClient = { im: { ...client.im, message: { create: async () => ({ code: 230002, msg: 'bot not in chat' }) } } }
  let threw = false
  try {
    await createMediaSender({ client: badClient }).send({ chatId: 'oc_x', filePath: pdf })
  } catch (error) {
    threw = /230002/.test(error.message)
  }
  check('发送错误码被抛出', threw)
}

rmSync(dir, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)

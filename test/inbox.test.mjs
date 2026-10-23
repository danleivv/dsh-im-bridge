/**
 * 收件箱测试：文件名消毒是安全边界，必须逐条钉死。
 *
 * Run: node test/inbox.test.mjs
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  sanitizeFileName,
  uniquePath,
  dayDir,
  resolveInboxDir,
  saveAttachment,
  asImagePayload,
  INBOX_DIR_NAME,
  MAX_IMAGE_BYTES,
} from '../lib/inbox.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

console.log('\n[1] 文件名消毒：目录成分必须消失')
{
  check('反斜杠路径', sanitizeFileName('..\\..\\Windows\\evil.txt') === 'evil.txt', sanitizeFileName('..\\..\\Windows\\evil.txt'))
  check('正斜杠路径', sanitizeFileName('/etc/passwd') === 'passwd', sanitizeFileName('/etc/passwd'))
  check('盘符路径', sanitizeFileName('C:\\Users\\x\\a.md') === 'a.md', sanitizeFileName('C:\\Users\\x\\a.md'))
  check('纯 ..', sanitizeFileName('..') === 'file', sanitizeFileName('..'))
  check('空串', sanitizeFileName('') === 'file', sanitizeFileName(''))
  check('null', sanitizeFileName(null) === 'file', sanitizeFileName(null))
}

console.log('\n[2] 非法字符与保留名')
{
  check('冒号星号问号', sanitizeFileName('a:b*c?.txt') === 'abc.txt', sanitizeFileName('a:b*c?.txt'))
  check('控制字符', sanitizeFileName('a\u0000b\u001fc.txt') === 'abc.txt', sanitizeFileName('a\u0000b\u001fc.txt'))
  check('保留名 CON', sanitizeFileName('CON.txt').startsWith('_CON'), sanitizeFileName('CON.txt'))
  check('保留名 nul', sanitizeFileName('nul').startsWith('_nul'), sanitizeFileName('nul'))
  check('普通名不变', sanitizeFileName('报表-2026.xlsx') === '报表-2026.xlsx', sanitizeFileName('报表-2026.xlsx'))
}

console.log('\n[3] 超长名截断但保留扩展名')
{
  const long = 'x'.repeat(300) + '.png'
  const result = sanitizeFileName(long)
  check('长度受控', result.length <= 96, String(result.length))
  check('扩展名还在', result.endsWith('.png'), result.slice(-6))
}

console.log('\n[4] 同名不覆盖')
{
  const dir = mkdtempSync(join(tmpdir(), 'inbox-test-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'first')
    const next = uniquePath(dir, 'a.txt')
    check('生成 a-1.txt', next.endsWith('a-1.txt'), next.split(/[\\/]/).pop())
    writeFileSync(next, 'second')
    check('再撞生成 a-2.txt', uniquePath(dir, 'a.txt').endsWith('a-2.txt'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n[5] 目录解析')
{
  check('优先用配置', resolveInboxDir({ configured: 'D:\\x', cwd: 'D:\\proj', home: 'C:\\h' }) === 'D:\\x')
  check('否则落在 cwd', resolveInboxDir({ cwd: 'D:\\proj', home: 'C:\\h' }) === join('D:\\proj', INBOX_DIR_NAME), resolveInboxDir({ cwd: 'D:\\proj', home: 'C:\\h' }))
  check('都没有才用 home', resolveInboxDir({ home: 'C:\\h' }) === join('C:\\h', INBOX_DIR_NAME))
  check('默认目录名是隐藏目录', INBOX_DIR_NAME.startsWith('.'), INBOX_DIR_NAME)
  const dir = dayDir('C:\\inbox', new Date('2026-03-05T10:00:00'))
  check('按日期分目录', dir.endsWith('2026-03-05'), dir)
}

console.log('\n[6] 落盘')
{
  const root = mkdtempSync(join(tmpdir(), 'inbox-save-'))
  try {
    const saved = saveAttachment({ inboxDir: root, fileName: '..\\..\\note.txt', buffer: Buffer.from('hello'), now: new Date('2026-01-02T00:00:00') })
    check('写进了日期目录', saved.path.includes('2026-01-02'), saved.path)
    check('文件名被消毒', saved.path.endsWith('note.txt'), saved.path)
    check('内容正确', readFileSync(saved.path, 'utf8') === 'hello')
    check('字节数正确', saved.bytes === 5, String(saved.bytes))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log('\n[7] 图片判定')
{
  const ok = asImagePayload({ mediaType: 'image/jpeg', bytes: 1000, buffer: Buffer.from('x') })
  check('jpeg 可注入', ok?.mediaType === 'image/jpeg' && typeof ok.data === 'string')
  check('png 可注入', asImagePayload({ mediaType: 'image/png', bytes: 1000, buffer: Buffer.from('x') }) !== null)
  check('heic 不注入', asImagePayload({ mediaType: 'image/heic', bytes: 1000, buffer: Buffer.from('x') }) === null)
  check('超大图不注入', asImagePayload({ mediaType: 'image/png', bytes: MAX_IMAGE_BYTES + 1, buffer: Buffer.from('x') }) === null)
  check('空类型不注入', asImagePayload({ mediaType: '', bytes: 1, buffer: Buffer.from('x') }) === null)
}

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)

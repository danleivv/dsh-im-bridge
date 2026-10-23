/**
 * 权限目录归一化测试。
 *
 * 这个 bug 的现场：宿主返回 { options: [...] }，实现当成数组去 Object.values，
 * 于是权限卡片里只剩一个选项。所以这里把三种真实形态都钉住。
 *
 * Run: node test/permissions.test.mjs
 */
import { normalizePresets, readableName } from '../lib/permissions.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

console.log('\n[1] 宿主的真实形态：{ options: [...] }')
{
  const catalog = {
    defaultPreset: 'danger-full-access',
    defaultOptions: [{ value: 'danger-full-access', name: 'danger-full-access' }],
    options: [
      { value: 'danger-full-access', name: 'danger-full-access' },
      { value: 'workspace-write', name: 'workspace-write' },
      { value: 'read-only', name: 'read-only', description: '只读' },
    ],
  }
  const result = normalizePresets(catalog)
  check('解析出全部 3 项', result.length === 3, JSON.stringify(result.map((item) => item.id)))
  check('用 value 当 id', result[0].id === 'danger-full-access', result[0].id)
  check('保留 description', result[2].description === '只读', String(result[2].description))
}

console.log('\n[2] 兼容其它形态')
{
  check('数组 + id', normalizePresets([{ id: 'a', name: 'A' }])[0]?.id === 'a')
  check('字符串数组', normalizePresets(['x', 'y']).length === 2, JSON.stringify(normalizePresets(['x', 'y'])))
  check('只有 defaultOptions', normalizePresets({ defaultOptions: [{ value: 'z' }] })[0]?.id === 'z')
  check('空输入', normalizePresets(null).length === 0)
  check('无 options 的对象', normalizePresets({ defaultPreset: 'x' }).length === 0)
  check('坏项被丢掉', normalizePresets({ options: [{}, { value: 'ok' }] }).length === 1, JSON.stringify(normalizePresets({ options: [{}, { value: 'ok' }] })))
}

console.log('\n[3] 名字与 id 相同的判定')
{
  check('name=id 时返回 null（用我们的标签）', readableName({ id: 'read-only', name: 'read-only' }) === null)
  check('name 不同则用它', readableName({ id: 'read-only', name: '仅可查看' }) === '仅可查看')
  check('没名字返回 null', readableName({ id: 'x' }) === null)
}

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)

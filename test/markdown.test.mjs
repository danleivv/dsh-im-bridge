/**
 * markdown → plain text tests.
 *
 * The failure this prevents is visible to the user on every single message: Feishu
 * text messages do not render markdown, so `## 标题` and `**加粗**` arrive with their
 * markers intact. The agent writes markdown constantly, so "looks broken" is the
 * default state without this conversion.
 *
 * Run: node test/markdown.test.mjs
 */
import { markdownToText, stripInline, toLarkMd } from '../lib/markdown.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}
const eq = (label, actual, expected) => check(label, actual === expected, JSON.stringify(actual) + (actual === expected ? '' : ' ≠ ' + JSON.stringify(expected)))

console.log('\n[1] 标题：去掉井号，保留文字')
eq('h1', markdownToText('# 标题一'), '标题一')
eq('h2', markdownToText('## 二级标题'), '二级标题')
eq('h3 降级为项目符号', markdownToText('### 三级'), '• 三级')
check('没有残留 #', !markdownToText('## 有井号').includes('#'))

console.log('\n[2] 行内强调：去星号，保留文字')
eq('加粗', markdownToText('这是 **重点** 内容'), '这是 重点 内容')
eq('斜体', markdownToText('这是 *斜体* 内容'), '这是 斜体 内容')
eq('三重强调', markdownToText('***全中***'), '全中')
eq('删除线', markdownToText('~~删掉~~'), '删掉')
eq('下划线加粗', markdownToText('__粗__'), '粗')
check('没有残留 **', !markdownToText('**x**').includes('*'))

console.log('\n[3] 行内代码')
eq('反引号', markdownToText('执行 `pwsh` 命令'), '执行 pwsh 命令')
check('没有残留反引号', !markdownToText('`code`').includes('`'))

console.log('\n[4] 链接与图片')
eq('链接保留地址', markdownToText('[文档](https://a.b/c)'), '文档（https://a.b/c）')
eq('裸链接不重复', markdownToText('[https://a.b](https://a.b)'), 'https://a.b')
eq('图片', markdownToText('![图](https://a.b/i.png)'), '图（https://a.b/i.png）')

console.log('\n[5] 代码块：去掉围栏，保留内容（缩进两格）')
const code = markdownToText('```js\nconst a = 1\n**不是加粗**\n```')
check('去掉了 ```', !code.includes('```'), JSON.stringify(code))
check('保留了代码内容', code.includes('const a = 1'), JSON.stringify(code))
check('代码块内不做强调处理', code.includes('**不是加粗**'), JSON.stringify(code))
check('标注了语言', code.includes('〔js〕'), JSON.stringify(code))

console.log('\n[6] 表格：去掉竖线和分隔行')
const table = markdownToText('| 工具 | 数量 |\n|---|---|\n| pwsh | 3 |\n| read | 5 |')
check('没有竖线', !table.includes('|'), JSON.stringify(table))
check('没有分隔行', !/---/.test(table), JSON.stringify(table))
check('表头还在', table.includes('工具') && table.includes('数量'), JSON.stringify(table))
check('数据还在', table.includes('pwsh') && table.includes('3'), JSON.stringify(table))

console.log('\n[7] 列表与引用')
eq('无序列表', markdownToText('- 第一\n- 第二'), '• 第一\n• 第二')
eq('有序列表', markdownToText('1. 第一\n2. 第二'), '1. 第一\n2. 第二')
eq('引用', markdownToText('> 引用内容'), '│ 引用内容')
eq('分隔线', markdownToText('---'), '————————')
check('复选框', markdownToText('- [x] 做完').includes('☑'))

console.log('\n[8] 中文表格对齐（CJK 占两列）')
const cjk = markdownToText('| 名称 | 值 |\n|---|---|\n| 中文 | 1 |\n| ab | 2 |')
const lines = cjk.split('\n')
check('两行数据都保留', lines.filter((l) => l.trim()).length === 3, JSON.stringify(lines))

console.log('\n[9] 边界：不能崩、不能丢内容')
eq('空串', markdownToText(''), '')
eq('纯文本原样', markdownToText('就是一句话'), '就是一句话')
eq('null', markdownToText(null), '')
eq('下划线不是强调', stripInline('snake_case_name'), 'snake_case_name')
check('连续空行被压缩', !markdownToText('a\n\n\n\nb').includes('\n\n\n'))
eq('数学星号不被吃掉', stripInline('2 * 3 = 6'), '2 * 3 = 6')

console.log('\n[10] toLarkMd：保留 lark_md 支持的语法，压平不支持的')
{
  check('保留粗体', toLarkMd('这是 **重点**').includes('**重点**'), toLarkMd('这是 **重点**'))
  check('保留链接', toLarkMd('[文档](https://a.b)').includes('[文档](https://a.b)'), toLarkMd('[文档](https://a.b)'))
  check('标题转成粗体', toLarkMd('## 结论') === '**结论**', toLarkMd('## 结论'))
  const table = toLarkMd('| a | b |\n|---|---|\n| 1 | 2 |')
  check('表格用 │ 分隔（不靠空格对齐）', table.includes('a │ b') && table.includes('1 │ 2'), JSON.stringify(table))
  check('表格不出现竖线 |', !table.includes('|'), JSON.stringify(table))
  check('表格有分隔行', table.includes('─────'), JSON.stringify(table))
  const quote = toLarkMd('> 引用内容')
  check('引用不再用 > （lark_md 不认）', !quote.includes('>') && quote.includes('│ 引用内容'), JSON.stringify(quote))
  check('代码块去围栏', !toLarkMd('```js\nconst a = 1\n```').includes('```'), JSON.stringify(toLarkMd('```js\nconst a = 1\n```')))
  check('行内代码去反引号', !toLarkMd('用 `pwsh` 跑').includes('`'), toLarkMd('用 `pwsh` 跑'))
  check('列表用项目符号', toLarkMd('- 一').includes('• 一'), toLarkMd('- 一'))
  check('空串安全', toLarkMd('') === '')
}
console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)

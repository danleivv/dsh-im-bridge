/**
 * 进度卡片测试：窗口、状态、节流。
 *
 * 这是"长任务期间能不能看到它在动"的唯一依据，渲染错了比没有更糟。
 *
 * Run: node test/progress-card.test.mjs
 */
import {
  createProgress,
  recordToolCall,
  recordToolResult,
  recordNote,
  renderProgressText,
  renderProgressCard,
  shouldUpdate,
  summariseArgs,
  formatElapsed,
  PROGRESS_ROWS,
  PROGRESS_MIN_INTERVAL_MS,
} from '../lib/progress-card.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''))
  if (!ok) failures++
}

console.log('\n[1] 时长格式化')
check('秒', formatElapsed(5000) === '5s', formatElapsed(5000))
check('分秒', formatElapsed(90000) === '1m30s', formatElapsed(90000))
check('小时', formatElapsed(3720000) === '1h02m', formatElapsed(3720000))

console.log('\n[2] 参数摘要')
check('取 command', summariseArgs('pwsh', JSON.stringify({ command: 'ffmpeg -i a.mp4' })) === 'ffmpeg -i a.mp4')
check('取 path', summariseArgs('read', JSON.stringify({ path: 'a/b.json' })) === 'a/b.json')
check('压平换行', !summariseArgs('pwsh', '{"command":"a\\nb"}').includes('\n'))
check('超长截断', summariseArgs('pwsh', JSON.stringify({ command: 'x'.repeat(200) })).length <= 52)

console.log('\n[3] 窗口只显示最近 5 条')
{
  const p = createProgress(7)
  check('窗口大小常量', PROGRESS_ROWS === 5, String(PROGRESS_ROWS))
  for (let i = 1; i <= 8; i++) recordToolCall(p, { name: 'pwsh', callId: 'c' + i, args: JSON.stringify({ command: 'job' + i }) })
  const text = renderProgressText(p, { now: p.startedAt + 60000 })
  check('只出现最近 5 条', ['job4', 'job5', 'job6', 'job7', 'job8'].every((j) => text.includes(j)) && !text.includes('job1 '), JSON.stringify(text.split('\n').slice(2, 8)))
  check('底部标出省略数量', /共 8 条（省略 3 条）/.test(text), JSON.stringify(text.split('\n').at(-1)))
}

console.log('\n[4] 状态标记')
{
  const p = createProgress(3)
  recordToolCall(p, { name: 'read', callId: 'a', args: '{"path":"x"}' })
  recordToolResult(p, { callId: 'a' })
  recordToolCall(p, { name: 'pwsh', callId: 'b', args: '{"command":"slow"}' })
  recordNote(p, '子 agent 调研')
  const running = renderProgressText(p, { now: p.startedAt + 30000 })
  check('完成的用 ✓', running.includes('✓ read'), JSON.stringify(running.split('\n')[2]))
  check('进行中的用 ▶ 且标"进行中"', /▶ pwsh .*进行中/.test(running), JSON.stringify(running.split('\n')[3]))
  check('note 用 ·', running.includes('· 子 agent 调研'), JSON.stringify(running.split('\n')[4]))

  p.finished = true
  const final = renderProgressText(p, { now: p.startedAt + 45000, final: true })
  check('结束态头部为 ✅ 完成', /✅ 完成/.test(final), final.split('\n')[0])
  check('未结束的工具标"未完成"', /未完成/.test(final), JSON.stringify(final.split('\n')[3]))
  check('结束态不再显示"更新于"', !final.includes('更新于') && !final.includes('刚刚更新'), JSON.stringify(final.split('\n').at(-1)))
}

console.log('\n[5] 节流')
{
  const p = createProgress(1)
  check('没建卡时立刻更新', shouldUpdate(p, Date.now()) === true)
  p.messageId = 'om_x'
  p.lastRenderAt = Date.now()
  check('刚更新过则跳过', shouldUpdate(p, Date.now()) === false)
  check('超过间隔才更新', shouldUpdate(p, Date.now() + PROGRESS_MIN_INTERVAL_MS + 10) === true)
}

console.log('\n[6] 卡片结构')
{
  const p = createProgress(2)
  recordToolCall(p, { name: 'pwsh', callId: 'z', args: '{"command":"x"}' })
  const card = renderProgressCard(p)
  check('schema 2.0', card.schema === '2.0', card.schema)
  check('单 markdown 元素', card.body.elements.length === 1 && card.body.elements[0].tag === 'markdown', JSON.stringify(card.body.elements.map((e) => e.tag)))
  check('开启 update_multi（可原地更新）', card.config.update_multi === true)
  check('内容含轮次与耗时', /第 2 轮/.test(card.body.elements[0].content))
}

console.log('\n[7] 边界')
{
  check('空进度不炸', renderProgressText(null) === '')
  const p = createProgress(1)
  recordToolResult(p, { callId: 'nope' })
  check('没有对应调用的结果被忽略', p.entries.length === 0)
  const done = createProgress(1)
  done.finished = true
  recordToolCall(done, { name: 'late', callId: 'x', args: '{}' })
  check('结束后的调用不再记录', done.entries.length === 0)
}

console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'))
process.exit(failures === 0 ? 0 : 1)

/**
 * 中英文案。
 *
 * 只覆盖"人看得到"的文字：飞书里的回复、进度卡、错误提示。
 * 日志与代码注释不翻译——日志是给维护者看的，翻成英文反而让排障变难。
 *
 * 新增文案的规矩：先在 zh 里加，再在 en 里加同一个 key；
 * 缺 key 时回退到中文，绝不会露出 key 名。
 */

/** 支持的语言。value 是内部标识，label 是配置里给用户看的。 */
export const LANGUAGES = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

/** 配置里可能出现的各种写法都收一下，避免用户填了 English 却不生效。 */
export function normalizeLanguage(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === '' ) return 'zh'
  if (raw === 'en' || raw === 'english' || raw === 'en-us' || raw === 'en_us' || raw === '英文') return 'en'
  return 'zh'
}

const zh = {
  // ---- 指令说明
  'help.title': '**可用指令**',
  'help.status': '- `/status`（旧写法 `?status`）：是否在跑、后台任务、子 agent、排队数、当前模型',
  'help.stop': '- `/stop`：停止当前正在跑的轮次',
  'help.model': '- `/model`：列出可用模型；`/model 2` 或 `/model provider/model` 切换（**下一轮生效**）',
  'help.progress': '- `/progress`：拉取当前这一轮的完整事件列表（卡片只显示最近 5 条）',
  'help.progressToggle': '- `/progress on` / `/progress off`：开关进度卡片',
  'help.help': '- `/help`：这条说明',
  'help.tail': '其它消息照常发给 agent；句首 `#` 表示排队到当前轮结束，不加则忙时插入当前轮。',

  // ---- 自检
  'status.title': '**dsh-im-bridge 自检**',
  'status.ipc': ({ pid, bound, clients }) =>
    '- 插件 pid `' + pid + '`，IPC ' + (bound ? '已监听' : '**未监听**') + '，客户端 ' + clients,
  'status.target': ({ target }) => '- 目标会话 `' + target + '`',
  'status.unresolved': '未解析',
  'status.liveYes': '是',
  'status.liveNo': '否（会尝试 resume，需要 agentOptions）',
  'status.live': ({ live }) => '- 是否 live：' + live,
  'status.running': ({ running }) => '- 是否正在跑：' + running,
  'status.yes': '是',
  'status.no': '否',
  'status.queue': ({ count }) => '- 排队中：' + (count ? count + ' 条（等这一轮结束）' : '无'),
  'status.model': ({ model }) => '- 模型：' + model,
  'status.lastTurn': ({ turn }) => '- 上一轮 turn：`' + turn + '`',
  'status.allow': ({ list }) => '- 白名单：`' + list + '`',
  'status.pluginError': ({ error }) => '- ⚠ 插件通讯失败：`' + error + '`',
  'status.contextDead': ({ error }) => '- ❌ **插件上下文已失效**：`' + error + '`',
  'status.contextDeadHint': '  → 端口被上一个插件实例占着，注入一定失败。**请重启桌面 App**。',
  'status.jobsNone': '- 正在运行的后台任务：无',
  'status.jobsHeader': ({ count }) => '- 正在运行的后台任务（' + count + '）：',
  'status.jobLine': ({ kind, label, elapsed }) => '  - `' + kind + '` ' + label + ' — 已运行 ' + elapsed,
  'status.subagentsHeader': ({ count }) => '- 正在运行的子 agent（' + count + '）：',
  'status.subagentLine': ({ name, elapsed }) => '  - ' + name + ' — 已运行 ' + elapsed,
  'status.readFail': ({ error }) => '- ⚠ 读取运行状态失败：`' + error + '`',
  'status.modelUnknown': '未知（发 /model 查看）',

  // ---- /model
  'model.empty': '没有发现可用模型。检查 provider 的凭据（`dsh-feishu-setup`，或 DSH 设置里的账号）。',
  'model.title': '**可用模型**',
  'model.current': ({ provider, model }) => '当前默认：`' + provider + ' / ' + model + '`',
  'model.currentMark': '  ← 当前',
  'model.more': ({ count }) => '（还有 ' + count + ' 个未列出，可用 /model provider/model 直接指定）',
  'model.hint': '发 `/model 2` 切换（或 `/model provider/model`）。切换对**下一轮**生效。',
  'model.badIndex': ({ max }) => '编号超出范围（1–' + max + '）。发 `/model` 看列表。',
  'model.notFound': ({ name }) => '没找到模型「' + name + '」。发 `/model` 看列表。',
  'model.switched': ({ provider, model }) => '已切到 `' + provider + ' / ' + model + '`，下一轮生效。',
  'model.busyNote': '（当前这一轮仍用旧模型）',
  'model.switchFailed': ({ error }) => '切换失败：' + error,

  // ---- /stop
  'stop.idle': '当前没有在跑的轮次。',
  'stop.ok': '已停止当前轮。',
  'stop.failed': ({ error }) => '停止失败：' + error,
  'stop.unknownReason': '原因未知',

  // ---- /progress
  'progress.enabled': '已开启进度消息：长任务会出现一张会滚动的进度卡片。',
  'progress.disabled': '已关闭进度消息：长任务期间不再推送进度卡片。回复不受影响。',
  'progress.usage': '用法：`/progress`（拉取当前进度）、`/progress on`、`/progress off`。',
  'progress.none': '当前没有进行中的任务。',
  'progress.title': ({ turn, total }) => '**第 ' + turn + ' 轮 · 完整事件（共 ' + total + ' 条）**',
  'progress.running': '进行中',
  'progress.done': '完成',
  'progress.line': ({ time, name, summary, status, seconds }) =>
    '- ' + time + '  ' + name + '  ' + summary + '  · ' + status + ' · ' + seconds + 's',
  'progress.empty': '（还没有事件）',
  'progress.footer': '卡片只显示最近 5 条；这条消息是完整列表。',
  'progress.noArgs': '（无参数）',

  // ---- 回复与排队
  'ack.defer': '已收到，等当前这一轮结束后发送',
  'ack.steer': '已接收消息，当前工具调用结束后响应',
  'ack.emptyPrefix': ({ prefix }) => '（' + prefix + ' 后面要有内容）',
  'ack.queued': '还在跑上一轮，这条会排在后面。',
  'reply.empty': '（这一轮没有文字输出）',
  'reply.failed': ({ error }) => '❌ 桥接失败：' + error,

  // ---- 进度卡片
  'card.working': ({ turn, elapsed }) => '🔄 正在处理（第 ' + turn + ' 轮 · 已 ' + elapsed + '）',
  'card.complete': ({ turn, elapsed, total }) =>
    '✅ 完成（第 ' + turn + ' 轮 · 共 ' + elapsed + ' · ' + total + ' 条）',
  'card.running': ' · 进行中',
  'card.unfinished': ' · 未完成',
  'card.noArgs': '（无参数）',
  'card.total': ({ total }) => '共 ' + total + ' 条',
  'card.totalOmitted': ({ total, hidden }) => '共 ' + total + ' 条（省略 ' + hidden + ' 条）',
  'card.justNow': '刚刚更新',
  'card.updatedAgo': ({ elapsed }) => '更新于 ' + elapsed + '前',
}

const en = {
  'help.title': '**Commands**',
  'help.status': '- `/status` (or `?status`): what is running, background jobs, subagents, queue, current model',
  'help.stop': '- `/stop`: stop the running turn',
  'help.model': '- `/model`: list models; `/model 2` or `/model provider/model` to switch (**takes effect next turn**)',
  'help.progress': '- `/progress`: full event list for the current turn (the card shows the latest 5 only)',
  'help.progressToggle': '- `/progress on` / `/progress off`: turn the rolling progress card on or off',
  'help.help': '- `/help`: this message',
  'help.tail': 'Anything else goes to the agent. A leading `#` queues it until the running turn ends; without it, it is injected mid-turn.',

  'status.title': '**dsh-im-bridge self-check**',
  'status.ipc': ({ pid, bound, clients }) =>
    '- plugin pid `' + pid + '`, IPC ' + (bound ? 'listening' : '**not listening**') + ', clients ' + clients,
  'status.target': ({ target }) => '- target session `' + target + '`',
  'status.unresolved': 'unresolved',
  'status.liveYes': 'yes',
  'status.liveNo': 'no (will try to resume; needs agentOptions)',
  'status.live': ({ live }) => '- live: ' + live,
  'status.running': ({ running }) => '- running a turn: ' + running,
  'status.yes': 'yes',
  'status.no': 'no',
  'status.queue': ({ count }) => '- queued: ' + (count ? count + ' (waiting for this turn)' : 'none'),
  'status.model': ({ model }) => '- model: ' + model,
  'status.lastTurn': ({ turn }) => '- last turn: `' + turn + '`',
  'status.allow': ({ list }) => '- allowlist: `' + list + '`',
  'status.pluginError': ({ error }) => '- ⚠ plugin call failed: `' + error + '`',
  'status.contextDead': ({ error }) => '- ❌ **plugin context is dead**: `' + error + '`',
  'status.contextDeadHint': '  → the port is held by a previous plugin instance, so injection will fail. **Restart the desktop app.**',
  'status.jobsNone': '- background jobs: none',
  'status.jobsHeader': ({ count }) => '- background jobs (' + count + '):',
  'status.jobLine': ({ kind, label, elapsed }) => '  - `' + kind + '` ' + label + ' — running ' + elapsed,
  'status.subagentsHeader': ({ count }) => '- subagents (' + count + '):',
  'status.subagentLine': ({ name, elapsed }) => '  - ' + name + ' — running ' + elapsed,
  'status.readFail': ({ error }) => '- ⚠ failed to read activity: `' + error + '`',
  'status.modelUnknown': 'unknown (send /model)',

  'model.empty': 'No models found. Check the provider credentials (`dsh-feishu-setup`, or the account in DSH settings).',
  'model.title': '**Available models**',
  'model.current': ({ provider, model }) => 'Current default: `' + provider + ' / ' + model + '`',
  'model.currentMark': '  ← current',
  'model.more': ({ count }) => '(' + count + ' more not listed; use /model provider/model to pick one)',
  'model.hint': 'Send `/model 2` to switch (or `/model provider/model`). It takes effect **next turn**.',
  'model.badIndex': ({ max }) => 'Out of range (1–' + max + '). Send `/model` to see the list.',
  'model.notFound': ({ name }) => 'No model named "' + name + '". Send `/model` to see the list.',
  'model.switched': ({ provider, model }) => 'Switched to `' + provider + ' / ' + model + '`; takes effect next turn.',
  'model.busyNote': ' (this turn still uses the old model)',
  'model.switchFailed': ({ error }) => 'Switch failed: ' + error,

  'stop.idle': 'No turn is running.',
  'stop.ok': 'Stopped the current turn.',
  'stop.failed': ({ error }) => 'Stop failed: ' + error,
  'stop.unknownReason': 'unknown reason',

  'progress.enabled': 'Progress messages on: long turns get a card that updates in place.',
  'progress.disabled': 'Progress messages off: no progress card during long turns. Replies are unaffected.',
  'progress.usage': 'Usage: `/progress` (current progress), `/progress on`, `/progress off`.',
  'progress.none': 'Nothing is running right now.',
  'progress.title': ({ turn, total }) => '**Turn ' + turn + ' · all events (' + total + ')**',
  'progress.running': 'running',
  'progress.done': 'done',
  'progress.line': ({ time, name, summary, status, seconds }) =>
    '- ' + time + '  ' + name + '  ' + summary + '  · ' + status + ' · ' + seconds + 's',
  'progress.empty': '(no events yet)',
  'progress.footer': 'The card shows the latest 5 only; this message is the full list.',
  'progress.noArgs': '(no arguments)',

  'ack.defer': 'Got it — will send after the current turn finishes',
  'ack.steer': 'Got it — will answer once the current tool call finishes',
  'ack.emptyPrefix': ({ prefix }) => '(' + prefix + ' needs something after it)',
  'ack.queued': 'Still running the previous turn; this one is queued behind it.',
  'reply.empty': '(this turn produced no text)',
  'reply.failed': ({ error }) => '❌ Bridge failed: ' + error,

  'card.working': ({ turn, elapsed }) => '🔄 working (turn ' + turn + ' · ' + elapsed + ')',
  'card.complete': ({ turn, elapsed, total }) =>
    '✅ done (turn ' + turn + ' · ' + elapsed + ' · ' + events(total) + ')',
  'card.running': ' · running',
  'card.unfinished': ' · unfinished',
  'card.noArgs': '(no arguments)',
  'card.total': ({ total }) => events(total),
  'card.totalOmitted': ({ total, hidden }) => events(total) + ' (' + hidden + ' hidden)',
  'card.justNow': 'updated just now',
  'card.updatedAgo': ({ elapsed }) => 'updated ' + elapsed + ' ago',
}

/** 英文单复数只在 events 这一处出现，简单处理即可。 */
const events = (count) => count + ' event' + (Number(count) === 1 ? '' : 's')

const MESSAGES = { zh, en }

/**
 * 造一个翻译函数。
 * 缺 key 时回退中文，再缺就返回 key 本身——宁可露出 key，也不静默变成空串。
 */
export function createTranslator(language) {
  const lang = normalizeLanguage(language)
  return (key, vars) => {
    const entry = MESSAGES[lang]?.[key] ?? MESSAGES.zh[key]
    if (entry === undefined) return key
    return typeof entry === 'function' ? entry(vars ?? {}) : entry
  }
}

# 开发文档

面向修改本插件的人。使用者请回到 [README](../README.md)。

## 架构

```
飞书 ⇄ 插件（跑在 DSH Host 进程内）⇄ 会话
       └─ 长连接（不需要公网地址）
```

注入只能由宿主进程内的插件完成：外部进程没有写入 live 会话的能力。因此飞书侧的一切最终都回到
插件内部调用 `agent.followup()` / `agent.steer()`，也正因为如此才能做到"插入正在跑的那一轮"。

## 模块

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 插件本体：会话白名单、注入、事件扇出、本地 IPC、进程内网关装配 |
| `lib/gateway-core.mjs` | 与平台无关的策略层：去重、轮次归属、忙时插入、消息分片 |
| `lib/feishu-transport.mjs` | 唯一的平台适配层：长连接、收发、表情、消息解析 |
| `lib/feishu-payload.mjs` | 出站载荷：卡片 2.0 / 卡片 1.0 / 纯文本 |
| `lib/markdown.mjs` | markdown → 纯文本（`replyFormat: "text"` 时使用） |
| `lib/plugin-ipc.mjs` | 到插件的 IPC 客户端（诊断工具使用） |
| `lib/seen-store.mjs` | 持久化事件去重 |
| `bin/dsh-feishu-gateway.mjs` | 独立网关（可选）；当 `gateway.json` 里 `enabled: true` 时拒绝启动 |

新增平台只改传输层与 `startGateway()` 里的装配，策略层不需要改动。

## 领域概念

| 概念 | 含义 |
|---|---|
| session | 一条持久化对话，id 形如 `session-<uuid>`，桌面与手机共享 |
| turn / step | 一轮包含若干步；一步是一次模型调用及其工具调用 |
| followup | 排到下一轮执行 |
| steer | next-step 输入，在当前这一步结束后被接纳 |
| watermark | 注入时记录的轮次号，用于判断哪个 `turn/end` 属于这次注入 |
| composition | agent 的工具集，由 preset 通过 `agentPresets.mount()` 组装 |
| projection | 会话的派生状态，例如当前 preset，通过 `sessionQuery` 读取 |

## 契约

以下是宿主与平台行为决定的约束，修改实现时需要保持。

**注入载荷**

- 必须包含 `role` 与 `id`。宿主把载荷原样存为 `agent/inbox/spliced` 并在之后折叠进
  `user/message`，不会补齐字段。
- 每次注入使用新的 `id`，不可跨轮复用。

**会话激活**

- 恢复会话使用 `ctx.agents.resume({ resumeSessionId, agentOptions, setup })`。
  - 键名是 `resumeSessionId`。
  - `setup` 负责安装工具集与模型选择；缺少它，agent 能对话但工具不可用。
  - `agentOptions` 优先取 `agentDefaultModel.currentSelection()`，配置值仅作兜底。
- 工具集按 preset 组装：`presets.resolve(presetId)` 后经 `presets.mount(agentCtx, id)` 安装；
  preset 从会话 projection 读取。

**事件与归属**

- 只把轮次号大于注入时记录的 watermark 的 `turn/end` 视为该次注入的回复。
- 事件去重需要持久化：平台会重投未确认的事件，而进程可能重启。

**平台接入**

- 一个飞书应用只允许一条长连接。同一个应用上运行两个消费者会导致事件分发不确定。
- 飞书的 `text` 消息不渲染 markdown；需要格式时使用卡片 2.0 的 `markdown` 元素。
- **不要用 `im.message.get` / `im.message.list` 的内容判断卡片是否渲染成功。** 读接口返回的是给
  API 读者的简化预览：卡片 2.0 会显示成「请升级客户端」占位符，而手机与桌面客户端实际都渲染
  正常。据此判定"降级"会把好用的卡片误换成纯文本（已实证）。
- 卡片 1.0 的 `lark_md` 只支持粗体、斜体、删除线、链接；表格与代码块需要卡片 2.0。

**输出格式（表格）**

- Agent 一律输出**标准 GFM 表格**：表头行 +
  `|---|---|` 分隔行。桌面端直接渲染；插件在传输层把表格提升为卡片 2.0 的原生 `table` 组件。
  不要为两端写两种格式。
- **不要用空格对齐伪造表格**：两端的渲染器都会折叠连续空格，列会散掉。
- 飞书 `markdown` 组件本身**不渲染表格**（官方文档明确），必须走 `table` 组件；单张卡片最多
  5 个表格，超出部分降级为对齐文本。
- 单元格保持单行、简短；多段说明放在表格外。单元格内可用 `**粗体**`、`` `代码` ``、链接
  （`lark_md` 支持），但不能放换行或多层列表。

**长任务进度（`lib/progress-card.mjs`）**

- 一条消息 + 固定 5 行窗口 + `im.message.patch` 原地更新；逐条发消息会刷屏，卡片没有滚动容器。
- 只在**自己发起的轮次**里跟踪（`state.inFlight`），桌面端发起的轮次不碰。
- 节流：最快每 1.5s 一次，另有 10s 心跳刷新"已运行多久"；只显示工具调用与子 agent 等可读事件。
- **不显示推理原文**：内部推理噪音大且可能带业务数据，只显示"思考中"。
- 轮次结束时就地变成完成态（未结束的工具标「未完成」，不谎报状态）。
- 进度卡失败只记日志，绝不影响正式回复。

**进程与配置**

- 本地 IPC 端口可能被上一个插件实例短暂占用，绑定需要带退避重试。
- `hello` 需要一并返回服务上下文的可用性，便于外部判断实例是否仍可用。
- `config.json` 每次请求重读；`gateway.json` 仅启动时读取。
- 凭据读取顺序：`FEISHU_APP_ID` / `FEISHU_APP_SECRET` 环境变量优先，其次 `gateway.json`。
  不要让密钥出现在命令行参数或对话内容里。

## 本地开发

修改本插件时用本地链接安装，改完代码重启 DSH 即可生效（ESM 模块会被缓存）。

编辑当前 profile（`~/.dsh/profiles/<name>/package.json`），两处都要有：

```json
{
  "dependencies": {
    "dsh-im-bridge": "link:/path/to/dsh-im-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-im-bridge"]
    }
  }
}
```

`dsh.profile.bundles` 决定该组合包是否挂载；`dependencies` 里的 `link:` 让 DSH 直接读仓库目录。
面板里的安装流程只接受 git 仓库、tarball 与 npm 包名，本地目录需要手工写这两处。

## 测试

全部测试不需要飞书，也不需要 DSH 在运行：

```bash
npm test
```

| 套件 | 覆盖 |
|---|---|
| `test/dry-run.mjs` | 插件：注入、白名单、热配置、steer、resume、工具进度、进程内适配器 |
| `test/gateway-core.test.mjs` | 策略层：去重、轮次归属、忙时插入、分片、表情、markdown |
| `test/markdown.test.mjs` | markdown → 纯文本 |
| `test/feishu-payload.test.mjs` | 出站载荷与卡片选用规则 |
| `test/feishu-parse.test.mjs` | 飞书消息解析 |
| `test/seen-store.test.mjs` | 持久化去重 |

需要真实环境的验证：

```bash
node test/gateway-live.mjs                     # 对真实插件的集成测试（只使用配置里的测试会话）
node tools/steer-probe.mjs                     # 验证 next-step 注入
node tools/send-test-card.mjs --chat oc_xxx    # 确认卡片渲染效果
```

## 发布

1. `npm test` 通过。
2. `npm pack --dry-run` 确认 `files` 覆盖 `lib/`、`bin/`、`tools/`、`docs/`。
3. 确认仓库内没有会话 id、应用凭据与本机路径。
4. 更新 `CHANGELOG.md` 与 `package.json` 版本号。
5. `npm publish`，或打 tag 供 `github:` 方式安装。

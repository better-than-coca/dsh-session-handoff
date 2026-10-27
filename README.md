# dsh-session-handoff

上下文接近上限时，把当前会话摘要出来，开一个新会话接着做。旧会话一个字节都不改，随时可以回去查原文。

## 它做什么

1. 每次请求前读上下文压力（宿主 `contextPressure` 投影）。
2. 到 `askRatio` 时注入一条提示，同时助手消息下面的按钮亮起小圆点。
3. 你点按钮（或让模型调 `session_handoff(action:"handoff")`），插件排队到本轮结束后执行：把当前会话**可见的上下文**交给摘要器，产出一份交接摘要，存进 `~/.dsh/handoff/pending.json`。
4. 摘要落盘后，插件用**宿主的会话控制器**（New Session 按钮走的同一个 `sessionController`）开一个**全新会话**（同一个工作目录），发出第一条消息 `继续`。宿主的第一轮钩子在那条消息之前插入摘要，并记下 `~/.dsh/handoff/<新会话 id>.json` 指向旧会话。浏览器那半只负责在结果出来后切过去。
5. 旧会话的上下文、窗口占用、日志：**全部原样保留**。

新会话走宿主自己的 `sessionController.create` + `.prompt`，不是插件拼一个空壳塞进列表。所以它出现得正常、能继续聊、能再交接；插件也不需要在宿主里伪造会话，也不依赖浏览器有没有网关客户端。开没开成会写进 `/status` 的 `followUp` 字段（`opened` / `create-failed` / `prompt-failed` / `unavailable` / `no-cwd` / `manual`）。

**不动手也能兜住**：如果这次运行的环境里没有那条通道（例如命令行部署），或者你关掉了设置里的「自动开新会话」，摘要就停在 `pending.json` 里等你手动开新对话取走，行为和 0.4.x 一样。

## 界面

**交接按钮**：每条助手消息下方的动作行里一个 28px 图标按钮，和复制、重试那排同级。四种状态：

| 状态 | 外观 | 含义 |
|---|---|---|
| 空闲 | 灰色图标 | 压力没到 `askRatio`，点了也能手动交接 |
| 该交接了 | 图标右上角一个圆点，悬停显示「上下文 N% · 点这里交接」 | 压力过了 `askRatio` |
| 进行中 | 转圈 | 摘要正在生成 |
| 已完成 | 对勾 | 摘要已挂起；开新会话的流程在后台跑完 |

`mode: off` 时按钮变暗不响应。`dryRun: true` 时点击只回一句「这是演练，没有副作用」。

**设置页**：左侧栏面板列表里的「会话交接」，排在记忆系统、技能管理之后。面板顶部是实时压力条，下面两组控件：

- 触发：`mode`、`askRatio`、`autoRatio`、`noticeCooldownMs`
- 行为：`dryRun`、`maxHandoffsPerSession`、`includeHistoryTool`、`autoOpenSession`

**改动即时生效**，不用重启、不用重开会话：`includeHistoryTool` 关掉的下一步，工具表里就没有 `handoff_history` 了。点「恢复默认」等于删掉设置文件，回到 profile patch 的值。

## 设置

设置页写的是 `%USERPROFILE%\.dsh\dsh-session-handoff\settings.json`，**不碰** profile 里的 `cordis.patch.yml`——插件永不改写宿主配置文件这条不变。

优先级：`DEFAULTS` < `cordis.patch.yml` < `settings.json`。删掉这个文件即回到 patch 的值。

| 键 | 控件范围 | 默认 | 含义 |
|---|---|---|---|
| `mode` | ask / auto / off | `ask` | `off` 只留手动按钮和工具 / `ask` 到阈值提示 / `auto` 到阈值直接做 |
| `askRatio` | 0.30–0.90 | `0.55` | 提示与亮圆点的压力比 |
| `autoRatio` | 0.50–0.95 | `0.75` | auto 模式直接执行的比，强制高于 `askRatio` |
| `noticeCooldownMs` | 1–60 分钟 | `10` 分钟 | 两次提示的最小间隔 |
| `dryRun` | 开 / 关 | `true` | 开时一律不产生副作用 |
| `maxHandoffsPerSession` | 1–5 | `1` | 同一会话最多交接次数 |
| `includeHistoryTool` | 开 / 关 | `true` | 是否注册 `handoff_history` |
| `autoOpenSession` | 开 / 关 | `true` | 摘要落盘后自动开新会话、注入摘要并切过去 |

两个键只在 patch 里改，面板不暴露：`minRatio`（0.30，低于此比拒绝交接）、`summarizeTimeoutMs`（180000，摘要请求超时）。

**实测口径**：`askRatio` 0.40 / `autoRatio` 0.55。40% 以上交接还能保住「接着干活」需要的状态，压缩比大约 90:1；想要逐条保真得压到 10% 以内，那时摘要几乎等于原文复制，没有意义。

## HTTP 路由

浏览器那半（按钮、设置页）碰不到实时的 Agent，只能请宿主那半代劳，所以有 3 条路径、4 个方法：

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/dsh-session-handoff/status` | GET | 压力、能否交接、有没有挂起的摘要；可带 `?sessionId=` |
| `/api/dsh-session-handoff/handoff` | POST | 排队交接；body `{sessionId}` 可省 |
| `/api/dsh-session-handoff/settings` | GET / POST | 读设置 / 写设置（`{values:{...}}` 或裸对象，`{reset:true}` 清空） |
| `/api/dsh-session-handoff/attach` | POST | 把一个已有会话挂到它所属的工作区（`{sessionId, cwd}`），修「会话存在但侧栏不显示」 |

同一路径只能注册一个 handler（宿主按 path 建索引，后注册的直接被丢弃），所以 `/settings` 是一个 handler 内部按 method 分派。请求体上限 4096 字节。

## 工具

- `session_handoff(action:"status")`：压力、能否交接、上次交接结果。
- `session_handoff(action:"handoff")`：请求交接，本轮结束后生成摘要并挂起。
- `session_handoff(action:"cancel")`：丢弃还没被使用的摘要。
- `handoff_history(query | seq | source, before, after, limit)`：`source:"self"` 读本会话，`source:"parent"` 读旧会话日志。

## 新旧会话各是什么

| | 旧会话 | 新会话 |
|---|---|---|
| 上下文 | 不变（还占着原来的比例） | 只有一份摘要 |
| 日志 | 完整，是检索源 | 从零开始，没有旧对话副本 |
| 之后能否再交接 | 看 `maxHandoffsPerSession` | 能（它不是 fork 出来的） |

需要旧细节时，在新会话里调 `handoff_history({ query: "关键词", source: "parent" })`，它直接读旧会话的日志文件。

## 摘要与路线卡

**摘要**：直接复用宿主压缩器那套输入（`session.surface.nodes` + `deriveEventMessage`），只换指令，要求 Exact Facts 段逐条保留标识符／常量／错误码。**只调 `summarize()`，不提交**——所以旧会话不会出现压缩事件。

**标识符索引**：摘要生成后扫一遍被遮蔽的原文，把「反复出现、但摘要没提」的标识符补成清单（≤24 条）。模型挑哪些事实全凭运气，这一步补运气之外的兜底，不额外发请求。实测同一次 41 万 tokens 的日志：24 条 / 603 字符 / 约 251 tokens。

**分三档**（按压缩比）：

| 压缩比 | 路线卡口径 |
|---|---|
| ≤ 30:1 | 摘要优先，不确定时再核对 |
| 30–80:1 | 事实可直接答，归属／逐字引用先核对 |
| > 80:1 | 函数名／常量／错误码／路径必须先查原文 |

**压缩比口径**：`(outputTokens - reasoningTokens) / shadowedTokenCount`。`outputTokens` 含模型看不见的 reasoning，直接用它会把比算小、让模型过度信任骨架摘要。

## 安全边界

- 不压缩、不改写、不删除任何会话历史；唯一写入是 `~/.dsh/handoff` 下自己的记录和 `settings.json`。
- 子代理会话、没有日志的空会话直接拒绝。
- 摘要失败、日志读不到时，不产生半成品：不创建任何会话，不留半个 pending。
- 所有监听器自己吞异常，交接失败不会中断当前对话。
- 不写任何配置文件；不在宿主上加 disable。
- 3 条路由只读状态、写自己的记录，没有任何一条能改到会话内容。

## 安装 / 回滚

npm 上的名字是 `@better-than-coca/dsh-session-handoff`。装进桌面端 profile 分两步：

1. `profiles/desktop/package.json` 的 `dependencies` 加 `"@better-than-coca/dsh-session-handoff": "^0.5.3"`，`dsh.profile.bundles` 数组末尾加同名条目。
2. 在 profile 目录跑 `pnpm install`，重启桌面端。

**别用 `link:` 指向本地源码目录。** pnpm 会把这种依赖建成 junction，Node 按真实路径解析，从源码目录里找不到 profile 里的 `@deepseek-ai/*` 宿主包 —— 表现是插件显示「已启用」，但助手消息下没有按钮、左侧栏也没有设置页。安装目录必须是真实副本，不能是符号链接。

要在本机改源码调试，用 `install.ps1`：它把 `lib`、`client.js`、`package.json`、`cordis.patch.yml` 复制（不是链接）到 `node_modules\@better-than-coca\dsh-session-handoff`。

启用：`profiles/desktop/cordis.patch.yml` 里 `id: session-handoff` 的 `disabled` 改 `false`。

测试（5 个套件、216 条断言；自动建沙箱与宿主包 stub）：

```powershell
cd E:\dsh\dsh-session-handoff
node test\run.mjs
```

回滚：`cordis.patch.yml` 里 `disabled` 改回 `true`，或从 `dependencies` 删掉后重跑 `pnpm install`。设置文件留在原地不影响。

## 已知限制

- 交接要在这个会话**当前进程里活着**（跑过至少一轮）。宿主的上下文只存在于 Agent 里，重启后一次都没跑过的会话读不到，按钮会直接提示「先发一句话」。
- 自动开新会话依赖宿主的 `sessionController` 与旧会话的工作目录；拿不到任一样时退回手动流程，按钮上会写原因（见 `followUp.code`）。
- 自动切到新会话需要浏览器端的 `uiWorkspace`；没有它时新会话照样建好、照样跑起来，只是要你自己在左侧列表里点一下。
- 侧栏只列**工作区自己的** `sessionIds`。0.5.2 及更早建的交接会话只传了 `cwd`、没挂工作区，所以能打开却不显示；用 `POST /attach` 挂一次即可恢复。
- 摘要生成 + 新会话开好大约要十几秒到几分钟（取决于旧会话多大）；这段时间按钮显示转圈，超时 4 分钟后退回手动流程，摘要不会丢。
- 手动开新对话仍然可用：等待中的摘要不限时，谁先到谁取走。
- 取走点是**新会话第一轮的第一步**（宿主 `turn === 1`）。若那个会话已经聊过一轮才发现有等待中的摘要，只能再开一个新对话；`pending.json` 会一直等着，不超时。
- 新会话的检索依赖旧会话日志文件存在；日志被删掉，`source:"parent"` 就查不到。
- 摘要本身仍有损：压缩比高于 80:1 时，具体常量基本只剩骨架 + 索引，细节靠 `source:"parent"` 回查。
- 面板里的压力条每几秒拉一次 `/status`；宿主没有实时推送接口，所以数字不是逐 token 跳动。

## 版本

- `0.5.3`（2026-10-28）：交接会话挂进工作区。0.5.2 只传 `cwd` 创建，宿主不会把它挂到工作区，结果是会话能跑、界面也能打开，但侧栏里找不到。现在先按目录 `resolveByPath` 拿 `workspaceId` 再建，建完再补一次 `attachSession`；另加 `POST /attach` 用于捞回已经存在的孤儿会话。
- `0.5.2`（2026-10-28）：把「开新会话」从浏览器那半搬到宿主那半，直接调 `sessionController.create` + `.prompt`；浏览器只负责导航。结果写进 `/status.followUp`，按钮按结果说话。0.5.0 的浏览器方案在你这套环境里没成功（点了按钮只落盘摘要、没有新会话）。
- `0.5.1`（2026-10-28）：区分「会话休眠」和「没有活着的会话」。重启后没跑过一轮的会话点击时返回 `session-dormant`，按钮提示先发一句话，不再给含糊的 `no live session`。
- `0.5.0`（2026-10-28）：点按钮后不再需要手动开新对话。摘要落盘后由浏览器那半调宿主的 `session.create` + `session.prompt` 开新会话、发第一条消息并切过去；设置页加了「自动开新会话」开关。
- `0.4.1`（2026-10-27）：加助手消息动作行的交接按钮和左侧栏设置页（7 个参数，即时生效）；修「新会话取不到摘要」——宿主把用户这条消息**在 pre-step 之后**才写进日志，旧判定要求日志里已有 1 条真人消息，导致第一轮永远不注入，改用宿主传入的 `turn` 判定（`turn === 1` 且日志里没有 `assistant/message`）。
- `0.4.0`（2026-10-27）：改为「摘要挂起 + 你在新对话取走」。插件不再预先建会话（blank 会被隐藏、也写不进去）。
- `0.3.1`／`0.3.0`：尝试交接时直接建会话并写入；实测宿主不让写，改用 0.4.0 的挂起方案。
- `0.3.0`（2026-10-27）：改为「真新会话」。旧会话不再被压缩，新会话不再复制旧对话；检索改走 `source:"parent"`。
- `0.2.0`：修正压缩比口径（扣除 reasoning tokens），加确定性标识符索引。
- `0.1.0`：fork 方案（压缩父会话后前缀复制）。

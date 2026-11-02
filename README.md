# personal-bot：任何 Agent 都能用的知识库

把聊天里有用的结论存进飞书多维表格，换 Agent、换设备，资料都能接着用；还可以用微信 ClawBot 随时查询。

- **换 Agent 找不到资料**：WorkBuddy、Codex、Claude Code 等都按同一份规范读写，不必反复介绍自己。
- **换设备查不了**：资料、联系人、项目和任务放在飞书，电脑和手机都能查。
- **多人协作不同步**：共享同一张表，进度和任务实时可见，需要提醒时进入通知队列。

默认一个人就能用。只接知识库需要 Python 3.9+，无需安装 Python 依赖；微信聊天是可选进阶功能，需要 Node.js 22+ 和一个 Anthropic 兼容模型接口。

## 第一步：飞书后台

1. 进入 [飞书开放平台](https://open.feishu.cn/)，创建**企业自建应用**。
2. 在「凭证与基础信息」页找到 **App ID** 和 **App Secret**。把它们留在本地，不要发到公开聊天或仓库。
3. 进入「权限管理」，开通**查看、评论、编辑和管理多维表格**权限；在「版本管理与发布」创建版本并发布。组织若要求管理员审核，请等审核完成。
4. 回到飞书的**云文档**，新建一个空的**多维表格**。请从云文档创建，避免从「知识库」创建导致链接与授权路径不同。
5. 在表格右上角「…」→「更多」→「添加文档应用」，选刚创建的应用，授予**可编辑**权限。
6. 从多维表格链接复制 `/base/` 后面、下一个 `/` 或 `?` 前的那一串，作为**表格 ID**（环境变量名为 `FEISHU_BITABLE_APP_TOKEN`）。

应用权限、版本发布、文档应用授权三个步骤都要完成。网页里自己能编辑，不代表应用也能编辑。

## 第二步：发给你的 Agent

复制下面这段话，填上你的称呼；三个凭证通过你信任的本地配置方式单独提供。

```text
请阅读这个仓库：https://github.com/Gordoncs/personal-bot 的 README.md 和 knowledge-base/AGENTS.md，帮我把它接入我的飞书多维表格。我的称呼是：____。
飞书 App ID、App Secret、表格 ID 我会单独提供，请写进本地环境变量，不要写进任何文件或提交记录，也不要在回复或日志中回显。
先运行 python3 knowledge-base/kb.py doctor 和 python3 knowledge-base/kb.py init --name 我的称呼 预览，我确认后再加 --yes 建表。
以后我说「同步到知识库」，你就按 AGENTS.md 的流程整理、列清单、确认后写入。
```

Agent 需要这三个本地环境变量：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_BITABLE_APP_TOKEN`。不要把真实值放进上面的可复制文本、代码、截图或提交记录。

首次建表只要：

```sh
python3 knowledge-base/kb.py doctor
python3 knowledge-base/kb.py init --name 我的称呼
# 审阅预览后执行
python3 knowledge-base/kb.py init --name 我的称呼 --yes
```

`init` 会创建固定的七张表，并在「资料」写入一条「欢迎使用」。重复运行会跳过已有内容，补齐缺失字段和单选选项，从不删除或改名。成员 ID 自动为 `m1`、`m2`；第一个成员默认是你。多人可加 `--member 成员乙 成员丙`，也可指定 `--member 成员乙:writer`。有结构冲突时会停下，提示你核实。

| 表 | 保存什么 |
|---|---|
| 资料 | 个人信息、工作、学习、生活资料；含分类、标签和来源 |
| 联系人 | 关系、公司/身份、联系方式和备注 |
| 项目 | 状态、最新进展和下一步 |
| 成员 | 成员名称、ID、别名 |
| 任务 | 标题、负责人、状态、截止日期和追加备注 |
| 进度 | 每人每天的进展 |
| 通知 | 等待微信实例投递的提醒 |

你以后在飞书里手动添加的其他表也能作为知识表查询和同步。表结构以 `kb.py schema` 的实际输出为准。[命令参考](knowledge-base/README.md) · [Agent 写入规范](knowledge-base/AGENTS.md)

## 日常怎么用

直接对已经接入的 Agent 说：

- 「把刚才确定的结论同步到知识库，先列清单给我看。」
- 「帮我查一下某位联系人的联系方式。」
- 「把这个任务记下来，负责人是我，截止下周五。」
- 「更新这个项目的下一步：周三之前整理资料。」
- 「查一下我最近三天的进度。」

通过 Agent 同步时，先查询、再列出新增/更新清单，确认后写入并回读。没有记录的内容会如实说明，不会自动编造。

## 进阶：微信扫码聊天

需要一台**常开的电脑或服务器**、微信里的 **ClawBot 插件**以及模型 API key。你的微信账号需要已获得 ClawBot 功能并启用插件。账号支持情况以微信实际界面为准。

在项目目录运行：

```sh
npm install
cp .env.example .env
# 在本地编辑 .env 后：
npm run login
# 在终端展示的登录流程中用微信扫码
npm start
```

`.env` 仅用于你自己的本地 BOT 实例，不要提交。也可通过进程环境注入全部配置。只接入 Agent 知识库时无需创建 `.env`。

配置示例已在 [.env.example](.env.example) 中：

- `STORE=feishu`：使用已由 `kb.py init` 建好的飞书表。`STORE=json` 可离线试用本地资料、任务、进度与通知。
- `OWNER=`：留空默认取成员表第一位；多人时必须填自己的**成员 ID**。`OWNER_NAME` 是本地 JSON 首次生成单人成员时使用的称呼。
- `BOT_NAME`：可选的助理名称。
- `OPENCLAW_STATE_DIR`：本实例独立的微信登录目录，例如 `./data/weixin`。不能使用默认的 `~/.openclaw` 或与 `DATA_DIR` 互相嵌套。
- `ANTHROPIC_API_KEY`：模型服务商的 key。默认示例为 DeepSeek 的 Anthropic 兼容接口：`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`、`LLM_MODEL=deepseek-flash`、`LLM_THINKING=disabled`。
- `OUTBOX_POLL_SECONDS=30`：通知队列轮询间隔。排队成功并不等于微信已送达。

微信主动推送受 **24 小时消息窗口**限制：接收方需要先向自己的 BOT 发消息，窗口过期可能无法主动送达；再次发消息后可重试。程序只在发送成功后标记送达，失败会保留排队记录。

`/help` 查看能力，`/whoami` 查看当前成员 ID，`/reset` 清空本地聊天历史。也可用 `npm run chat` 在终端聊天，或 `npm run ask -- "问题"` 做只读查询。

## 多人共享

共同维护一个飞书多维表格，运行一次 `kb.py init --name 你的称呼 --member 成员乙 --yes` 添加成员和人员选项。成员也可以重复增补，已有 ID、名称和别名不会被覆盖。

每个人各自运行一个 BOT 实例，扫码登录自己的微信，设置自己的 `OWNER`。每个实例使用独立的 `OPENCLAW_STATE_DIR` 和 `DATA_DIR`；共享飞书凭证需要彼此信任，也可分别授权各自的应用。给别人派任务会排队通知，给自己派任务不会生成通知。JSON 模式的成员来自本地 `data/store/members.json`，不具备跨设备共享能力，也不提供 JSON 到飞书迁移功能。

飞书写入不提供跨实例事务锁；多人同时创建任务有编号冲突的可能，请避免同一时刻并发派任务，并用表格核实编号。

## 安全提醒

密钥只保存在本地环境或本地 `.env`，不要提交到 Git。不要在知识库保存密码、验证码、证件号、银行卡、API key 等敏感内容；共享表里的内容会对获得授权的成员和 Agent 可见。调用模型查询时，相关资料会发送给你配置的模型服务商。

`kb.py` 没有删除命令，只有 `init` 可以建表、加字段和补选项。日常同步必须先确认清单再执行 `apply --yes`。微信中明确要求记录、更新或派任务时，BOT 会直接调用工具执行，请核对回复和表格。

## FAQ

**提示无权限怎么办？**

依次检查：App ID/Secret 是否来自同一个应用 → 多维表格权限是否开通 → 是否创建版本并发布 → 是否给这个表格添加了文档应用并授予可编辑 → 表格 ID 是否复制正确。然后运行 `python3 knowledge-base/kb.py doctor`。doctor 只读检查，不能代替实际写入权限验证。

**表格是在「知识库」里建的怎么办？**

推荐回到云文档新建一个空多维表格并重新授权，用它的 `/base/` 链接接入。不要直接把 `/wiki/` 后面的值当表格 ID。本工具不自动解析知识库节点或移动正式数据。

**已经有同名表怎么办？**

`init` 只补缺失字段和选项，不改主字段、类型或表名。doctor 报结构冲突时，先在飞书中核实；使用一个全新的空多维表格通常最省事。

**是否需要微信、模型 key 才能同步？**

不需要。`kb.py` 本身只调用飞书 API；你已有的 Agent 负责理解对话。只有启用这个项目的聊天 BOT 才需要模型 key。

## 开发与验证

```sh
npm run typecheck
npm run selftest
python3 -I knowledge-base/test_kb.py
# 真实 API 检查：只操作每轮随机生成的 测试_pb_<随机>_ 表，finally 清理并核对正式表
KB_ONLINE_TEST=1 python3 -I knowledge-base/test_kb.py
npm run feishu:check
STORE=feishu npm run smoke
```

在线测试需要可编辑和管理测试表的权限，不运行微信登录或启动。Smoke 最多调用模型接口两次。模板定义唯一来源为 [schema.json](knowledge-base/schema.json)，自测比较 Python 和 TypeScript 的实际加载结果。

本项目按 [MIT License](LICENSE) 开源。

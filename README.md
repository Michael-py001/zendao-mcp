# ZenTao MCP Server

基于 [Model Context Protocol](https://modelcontextprotocol.io/) 的服务器，让 LLM（Claude / GPT / 各类 AI 客户端）
通过禅道（ZenTao）的 REST API 读写项目、执行、任务，以及产品、项目集与 Bug。

- **传输方式**：stdio（`stdout` 是 JSON-RPC 专用通道，日志一律走 `stderr`）
- **API 版本**：禅道 API 2.0（`/api.php/v2`），可配置回落 v1
- **技术栈**：TypeScript + `@modelcontextprotocol/sdk` + `zod` + `axios` + `zentao-api`（官方动作注册表）
- **认证方式**：账号密码自动换取 REST Token，401 自动重换
- **工具数**：16 个（**通用层 3**：`modules` / `help` / `call`，覆盖官方 `zentao-api@0.9.3` 的 **43 模块 × 365 动作**；**手写兜底 13**：官方给不了的实例特有能力 + 从官方 0.5.0 移植的 `link` / `read_attachment`）

> 2026-11-21 已升级 `zentao-api` 0.7.0 → **0.9.3**（动作 229 → 365），并移植官方 CLI 0.5.0 的两个能力：`zendao_link`（页面链接生成/解析）与 `zendao_read_attachment`（从 URL/HTML/fileID 读取任意对象附件）。低版本禅道实例上，超出其版本的动作仍会被门槛拦下 —— 用 `zendao_modules` 查看当前实例实际可用数。

---

## 一行命令装到本机 AI 客户端（推荐）

发布到 npm 后，在**自己的电脑上**执行（不需要 clone 仓库、不需要先装依赖）：

```bash
npx -y @michael_py001/zendao-mcp init
```

安装后会在各 agent 配置里新增一个 `zentao-cli` 条目，凭证直接写进该条目的 `env`：

```json
{
  "mcpServers": {
    "zentao-cli": {
      "command": "npx",
      "args": ["-y", "@michael_py001/zendao-mcp", "mcp"],
      "env": {
        "ZENTAO_URL": "http://zen.example.com/zentaomax",
        "ZENTAO_ACCOUNT": "your-account",
        "ZENTAO_PASSWORD": "your-password"
      }
    }
  }
}
```

⚠️ **凭证是明文写进 agent 配置的**，字段名与官方 CLI 一致，方便复制粘贴；
这些文件常被提交到 git，请确认自己没有把含密码的配置加进仓库。
安装器同时把凭证缓存在 `~/.zendao-mcp/.env`（权限 600）作为下次复用的默认值。
写入前自动备份、同目录原子替换；用 `jsonc-parser` 定点插入，Trae / CodeBuddy / Cline 常见的
JSONC 注释与尾随逗号会原样保留，只遇到真正非法的配置文件才报错退出。

**可自动写入配置的 25 个 agent**：WorkBuddy、Claude Code、Claude Desktop、Cursor、Codex CLI、
OpenCode、Gemini CLI、VS Code / Copilot、Windsurf、Cline、Roo Code、Kilo Code、Zed、
GitHub Copilot CLI、Kiro CLI、Continue、Qwen Code、Antigravity、Trae、CodeBuddy、
Droid (Factory)、Augment Code、Qoder、Devin CLI、Amp。

另外对齐 [skills CLI 的 agent 名单](https://github.com/vercel-labs/skills/blob/main/docs/agents.md)，
支持 57 个仅手工配置的 agent（Goose、Warp、OpenHands、Lingma/通义灵码、Qoder CN、Trae CN、
Junie、iFlow CLI 等）——它们只公开了 skills 目录、没有可靠的 MCP 配置格式，
`-a <id>` 选中后会打印可直接复制的启动命令，**不会猜路径写文件**。
完整 ID 清单用 `--list-agents` 查看。

非交互 / CI 用法：

```bash
npx -y @michael_py001/zendao-mcp init --list-agents  # 全部 agent ID
npx -y @michael_py001/zendao-mcp init -a claude-code -a cursor -y
npx -y @michael_py001/zendao-mcp init -a goose -y             # 手工配置指引
npx -y @michael_py001/zendao-mcp init --dry-run               # 只看计划，不写文件
npx -y @michael_py001/zendao-mcp doctor                       # 检查安装状态
```

写入 agent 配置的启动命令是 `npx -y @michael_py001/zendao-mcp mcp`（`serve` 保留为兼容别名）。
各宿主的根键不同（`mcpServers` / `servers` / `mcp` / `context_servers` / TOML），安装器会自动选。
WorkBuddy 额外需要在连接器中心右上角点「信任」才会加载自定义 MCP。

从源码开发时用 `npm run build && node dist/cli.js init`，效果相同。

> 从 1.1.x 升级：配置条目名由 `zendao` 改为 `zentao-cli`，启动参数由 `serve` 改为 `mcp`，
> 并新增 `env` 凭证。重新跑一次 `init` 即可写入新条目；旧的 `zendao` 条目可在 agent 设置里删除。

---

## 快速开始（从源码运行）

**环境要求**：Node.js **≥ 18**（本项目在 Node 20 / 22 / 24 上验证过）；Windows / macOS / Linux 均可。
**不需要 clone 任何官方仓库** —— 官方 26 模块 / 229 个动作的定义来自 npm 依赖 `zentao-api`。

**三步装好**：

```bash
# 1) 装依赖 + 编译
npm install
npm run build

# 2) 配置凭证（最小配置：站点地址 + 账号 + 密码）
cp .env.example .env      # 然后填 ZENTAO_BASE_URL / ZENTAO_ACCOUNT / ZENTAO_PASSWORD

# 3) 自检：真实走一遍 MCP 协议并调用一次工具
npm run verify
```

`npm run verify` 正常时的样子（**数字随你的实例变化**，下面是 MAX8.2 的实例输出）：

```
✅ 1) initialize     -> zendao-mcp-server v1.0.0 (协议 2024-11-05)
✅ 2) tools/list     -> 12 个工具（通用层 3 + 手写兜底 9）
✅ 3) tools/call     -> zendao_modules 成功，实例版本 max8.2，注册表 26 模块 / 229 动作，当前实例可用 106 个
✅ 4) stdout 洁净    -> 无非 JSON 输出，协议通道正常
```

> 💡 想知道**你这台实例**到底能打哪些接口？跑一次 `npm run probe:smoke`（**只读**，只发 `GET`），
> 它会逐个动作实测并产出兼容性矩阵 → [`docs/instance-compatibility-matrix.md`](./docs/instance-compatibility-matrix.md)。

**接入到 AI 客户端**（WorkBuddy / Cursor / VS Code / Codex / Claude Desktop…）请看
👉 **[MCP-SETUP.md](./MCP-SETUP.md)**

---

## 先搞懂禅道的数据结构

禅道有**两条**并行的分层线，工具的归属参数就藏在这里面：

```
① 交付线（做需求 / 干活）
项目集 program
   └── 项目 project
          └── 执行 execution（迭代 sprint / 阶段 stage / 看板 kanban）
                 └── 任务 task

② 产品线（报 Bug / 提需求）
项目集 program
   └── 产品 product
          ├── Bug
          └── 需求 story
```

两条线各有各的坑：

- **任务挂在「执行」下，不是「项目」下。** 所以查任务、建任务都必须先拿到 `executionID`
  （`zendao_call { module: "execution", action: "list" }` 查，可按项目过滤）。
  不存在「全局任务列表」这种东西 —— 顶层 `GET /tasks` 在真实实例上返回 404。
- **Bug 挂在「产品」下，不是「项目」下。** 所以查 Bug、建 Bug 要先拿到 `productID`
  （`zendao_call { module: "product", action: "list" }` 查）。`zendao_list_bugs` 也支持
  `scope` + `scopeID` 指定 `products` / `projects` / `executions` 范围，不传则「逐产品合并」出全库。
- **项目集（program）只有列表接口**，详情端点 `/programs/{id}` 在真实实例上返回 404。

---

## 认证

禅道 API 2.0 需要先换 Token：`POST {baseUrl}/api.php/v2/users/login`，之后用 `Token` 请求头访问。
本项目**内置了这个流程**，你只要在 `.env` 里填账号密码：

```env
ZENTAO_BASE_URL=http://zen.example.com/zentaomax
ZENTAO_ACCOUNT=你的账号
ZENTAO_PASSWORD=你的密码
```

程序启动时自动换取 Token 并缓存在内存，遇到 401 会丢弃旧 Token、重换、重试一次。

凭证按「**账号密码 → 静态 `ZENTAO_TOKEN` → 官方 `zentao-cli` 的登录态**」优先级自动挑选。
已在本机 `zentao login` 过的同事可以**不配 `.env` 的认证项**直接跑（只读官方 profile store，不写用户目录）。

> ⚠️ 第三条路只带 **Token**（store 不存密码），而禅道 REST Token 有寿命
> （由实例的 `serverConfig.expiredTime` 决定，本项目的参考实例是 **4 小时**），
> 所以它**不能自动续期** —— 临时用很方便，长期无人值守请用第一种账号密码。

关于 API 版本差异、`ZENTAO_BASE_URL` 怎么填、以及为什么**不要**用 `账号:zentaosid` 那套旧方案，
详见 [MCP-SETUP.md 第二节](./MCP-SETUP.md#二认证方式)。

---

## 多站点与多版本

本项目里**没有任何编译期写死的实例信息** —— 换站点、换禅道版本，**同一份构建**直接可用。

### 多站点：改地址就能跑

| 你要做的事 | 怎么做 |
| --- | --- |
| 指向另一个禅道站点 | 改 `ZENTAO_BASE_URL`（填**站点根**；写成 `/zentao/index.php` 或 `/api.php/v2` 也会被自动剥回根） |
| 站点带上下文路径 | `http://host/zentao`、`http://host/zentao/`、`http://host/zentao/index.php` 都能识别 |
| 回落 API v1（极老版本） | `ZENTAO_API_VERSION=v1`（默认 `v2`，也会自动嗅探地址里的线索） |
| 自签证书 | `ZENTAO_INSECURE=1` |
| 内网站点 + 出网代理 | **内网地址自动直连**（10/8、172.16/12、192.168/16、127/8、localhost 一律 `proxy: false`），一般不用配 |
| 前置服务器掐断 PUT/DELETE | **动作端点**（`/bugs/{id}/resolve` 这类）自动改用 POST；`update` / `delete` 没有 POST 版本，如实报错、不降级 |
| 同时连多个站点 | 每个站点各起一个 MCP 服务实例、各用一份 `.env`（凭证与站点天然隔离） |

凭证有**三种来源**，按优先级自动挑：**账号密码 → 静态 `ZENTAO_TOKEN` → 官方 `zentao-cli` 的登录态**。
已在本机 `zentao login` 过的同事**不配认证项**也能直接跑（只读官方 profile store，不写用户目录）。
完整变量表与说明见 [`.env.example`](./.env.example)。

### 多版本：一份构建，跨版本自适应

版本适配**全部发生在运行时**，依据是官方注册表里每个动作声明的 `minVersion`：

| 环节 | 做法 |
| --- | --- |
| 实例版本探测 | `src/sdk/version.ts`：匿名 `?mode=getconfig` 探测 + 进程内缓存；探不到**不阻断**，可用 `ZENTAO_VERSION` 兜底 |
| 动作可用性 | 交给 `zentao-api` 注册表按 `minVersion` 判定（四条产品线 `open` / `biz` / `max` / `ipd` 全覆盖） |
| 门槛不满足时 | **说人话**：`需 max8.5（当前实例 max8.2）`，并给出下一步建议，而不是一句看不懂的失败 |

效果（**同一份构建**）：

| 实例版本 | `zendao_modules` 可见动作 |
| --- | --- |
| **MAX8.2** | **106** 个（注册表 365 个里，其余动作的门槛更高） |
| **MAX8.5+** | 门槛在**调用时**判，高版本动作自动放行；`my` 模块、`doc` 模块等随版本解锁 |

（2026-11-21 起注册表从 229 → **365** 动作；当前 max8.2 实例实测可见数仍为 106 —— `verify` 输出会写明实际值。）

⚠️ 最容易被记错的一点：**官方 CLI 的版本门槛，不是本项目的门槛**。
本项目走 REST 直连，不受官方 CLI 的注册 / 拦截规则约束 —— 官方被 max8.5 拒掉的功能，
这里常常**照样能打**（例如 `/my/work` 的 13 种 mode、`bug confirm`、`issue` / `risk` / `meeting` 列表）。
详见 [docs/official-module-parity.md](./docs/official-module-parity.md)。

> 🔍 **想验证你自己的实例**：`npm run probe:modules-sdk`（官方全量清单与门槛，只读）
> + `npm run probe:smoke`（逐个只读动作实测 → 兼容性矩阵）。

---

## 可用工具（16 个）

### ⭐ 通用层：3 个工具覆盖官方全部 365 个动作（先看这里）

| 工具名 | 作用 | 状态 |
| --- | --- | --- |
| `zendao_modules` | 列出**当前实例实际可用**的模块与动作（按禅道版本自适应） | ✅ |
| `zendao_help` | 查某个动作的**完整参数表**（类型 / 必填 / 枚举 / 中文说明 + 调用示例） | ✅ |
| `zendao_call` | **执行任意官方动作**：`{ module, action, params }` | ✅ |

这三个工具由**官方 `zentao-api` 注册表驱动**，覆盖官方 CLI 的全部 **26 个模块 / 229 个动作**
（产品、项目、执行、需求、任务、Bug、版本、发布、测试、反馈、工单、计划、地盘、文档…）。
路径拼接、参数类型强转、分页字段、结果提取、版本门槛全部交给官方 SDK —— 我们只做错误中文化与结果呈现。

**标准三步走**：

```
zendao_modules                                  ← 有哪些动作？（按实例版本过滤）
zendao_help { module: "bug", action: "list" }   ← 参数怎么传？
zendao_call { module: "bug", action: "list", params: { productID: 7 } }
```

⚡ **为什么会自动适配你的禅道版本**：官方每个动作都带 `minVersion`
（开源版 / 企业版 / 旗舰版 / IPD 版**四条产品线**），SDK 在调用时按**实例自报的版本**逐条判定 ——
同一份构建，8.2 实例少几个动作、8.5 实例全都有，**不需要任何编译期分支**。
完整说明（含各版本可用动作数）见 [多站点与多版本](#多站点与多版本)。

某个动作报「版本不支持」**不是配置错误**，而是该禅道版本确实没这个能力 —— 用 `zendao_modules` 看替代动作。

> **原来那 24 个「一工具一动作」的封装去哪了？**
> P1 收敛时删掉了（`list_projects` / `get_project` / `create_task` / `create_bug` / `resolve_bug` /
> `list_stories` / `list_builds` …），但**能力一个都没少**，只是改由通用层表达：
> `zendao_call { module: "project", action: "list" }`。保留的 9 个手写工具只负责
> **官方给不了的实例兜底能力**（全库 Bug 合并、附件直取、`/my/work` 地盘、`/my/effort` 工时日志、
> 账号→人名字典、批量建任务）。
>
> 常用动作的新旧写法对照见 [MCP-SETUP.md 第五节](./MCP-SETUP.md#五可用工具12-个)。

### 手写兜底层：官方给不了的 11 个

#### Bug（4 个）

| 工具名 | 作用 | 状态 |
| --- | --- | --- |
| `zendao_list_bugs` | Bug 列表（按产品 / 范围 / 状态 / 严重程度 / 关键词过滤，**含跨产品全库合并**） | ✅ |
| `zendao_get_bug` | Bug 详情（可选带操作历史） | ✅ |
| `zendao_get_bug_attachments` | **Bug 附件（截图）**：从 steps 里捞出并把图下载到本地，返回可直开的绝对路径 | ✅ |
| `zendao_list_my_bugs` | **我的 Bug**（按身份：指派给我 / 我创建 / 我解决 / 我最后修改） | ✅ |

#### 地盘 / 任务 / 人员（7 个）

| 工具名 | 作用 | 状态 |
| --- | --- | --- |
| `zendao_list_my_work` | **我的任务 / 我的需求 / 我的待办 / 我的 Bug**（用 `mode` 切换） | ✅ |
| `zendao_list_my_efforts` | **我的日志（工时）**：工作内容 / 日期 / 工时，可按服务端口径或任意日期区间筛 | ✅ |
| `zendao_fill_efforts` | **填日志（工时）**：支持**自定义日志**（不挂任务）、自动推断最新迭代；默认只预览 | ⚠️ **写操作** |
| `zendao_delete_effort` | **删日志**：写错后的收尾手段；删挂任务的日志会连带回滚工时 | ⚠️ **写操作·不可撤销** |
| `zendao_get_task` | **任务详情**（可选带操作历史；默认把账号补上人名） | ✅ |
| `zendao_list_users` | 用户字典（**账号 → 人名**） | ✅ |
| `zendao_batch_create_tasks` | 批量创建任务（≤50，分批并发） | ⚠️ **写操作** |

**「我接下来要干什么」用 `zendao_list_my_work`**：默认口径是「指派给我 + 未关闭」，一次请求约 1 秒，
数据源与网页「我的地盘」是同一个接口。其中「我的任务 / 我的需求 / 我的待办」是官方 CLI 在本实例给不了的
（官方 `/my/tasks`、`/my/stories`、`/my/todos` 全是 404，整个 `my` 模块要 max8.5）；
`mode: "bug"` 与 `zendao_list_my_bugs` 有重叠，后者在身份（opened/resolved/edited/any）、含已关闭、
按产品筛这三件事上更全，按需选用。

**「我这个月填了多少工时」用 `zendao_list_my_efforts`**：数据源是 `GET /my/effort`
（与网页「地盘 → 日志」同一通路）。**官方 CLI 完全没有这个能力** —— 模块清单里就没有 `effort`，
官方 SDK 里也搜不到这个词。时间口径两套可叠加：
① `type` 服务端预设（`all` / `today` / `yesterday` / `thisweek` / `lastweek` / `thismonth` / `lastmonth`）；
② `date`（单日）或 `begin` / `end`（区间）—— **本地过滤**。
⚠️ 两个实测坑：网页上那个 `date=20261015` 参数经 api.php/v2 之后**彻底失效**
（`begin`/`end`/`start`/`dateFrom`… 共 16 种参数名一律被静默忽略），所以区间由本工具自行裁剪；
另外服务端对不支持的 `type` 取值**不报错、只回 0 条**，于是「0 条」有歧义，结果里会提示换 `all` 复核。

**查「我待处理的 Bug」直接用 `zendao_list_my_bugs`**，默认口径是「指派给我 + 未关闭」，
走服务端「地盘」接口（与网页「我的地盘 → Bug」同一通路），**一次请求、约 1 秒**。
注意禅道里「我」有四种身份（`assignedTo` / `openedBy` / `resolvedBy` / `lastEditedBy`），用 `role` 切换 ——
这四种的数据量可能相差极大（某实例 `your-account` 是 6 / 0 / 321 / —），只查默认口径容易漏掉一大半，
详见 [MCP-SETUP.md](./MCP-SETUP.md#怎么查我待处理的-bug)。

**「全库 Bug」为什么还得手写**：因为**没有「一次拿到全库 Bug」的接口** ——
全局 `GET /bugs` 不带 `productID` 时只返回某一个产品，而 `GET /products` 又会漏掉 `shadow=1` 的影子产品。
所以 `zendao_list_bugs` 的「全库」范围是**逐产品遍历合并**出来的（含影子产品），
首次约 10 秒、之后走 5 分钟缓存。但**「我的 Bug」有专门的接口**（`GET /my/work`），不必走这条慢路。
详情见 [MCP-SETUP.md 第六节第 4 条](./MCP-SETUP.md#六典型坑与实例行为实测)。

**`zendao_list_users` 通常不必手动调**：`list_my_work` / `get_task` / `list_bugs` 以及通用层的 `zendao_call`
默认就会把 `assignedTo` 这类账号补上 `xxxName` 字段（人名来自地盘接口自带的 `users` 字典）——
因为 `GET /users` 与 `/users/{id}` 在部分实例**都是 404**。

> ⚠️ **写操作**：`zendao_batch_create_tasks`、`zendao_fill_efforts`、`zendao_delete_effort`，
> 以及通用层的 `zendao_call`（当 `action` 是
> `create` / `update` / `delete` / `close` / `resolve` / `activate` … 时）会**真的往禅道写数据**。
> 其余 11 个工具都是只读的。

**「自动填日志」怎么用**：`zendao_fill_efforts` 是唯一能写**自定义日志**（`objectType=custom`，
不挂任务）的工具 —— 禅道 REST 完全没有这条通路（`/efforts` 系列全 404，DELETE 被 HTTP 层掐断），
本工具改走网页批量录入表单，所以能做到纯接口写入。三步走：

1. 先 `dryRun`（默认值）看预览：日期 / 工时 / 挂什么对象 / **自动推断出的迭代**
2. 确认后 `dryRun: false` 真写，工具会**回查**并把落库的日志 ID 带回来
3. 写错了用 `zendao_delete_effort` 删掉

迭代（执行）不需要手填：任务/Bug 自动沿用它自己所属的执行；只给 `projectID` 时，
按「进行中 + 开始时间最晚」挑该项目的当前迭代。⚠️ 这个能力需要
`ZENTAO_ACCOUNT` + `ZENTAO_PASSWORD`（网页登录必须有明文密码，Token 和官方 CLI 的 profile 都用不了）。

### 几个通用约定

| 事项 | 说明 |
| --- | --- |
| 通用数据处理参数 | 手写列表工具支持 `pick`（摘字段）、`sort`（本地排序）、`orderBy`（服务端排序）；通用层另有 `filter` / `search` / `limit` / `page` / `recPerPage` |
| `filter` / `search` 的边界 | 只在**列表类**动作上生效；单对象（`get`）动作会静默忽略 —— 返回值里会给出提示 |
| `filter` 表达式 | `status:active,pri<=2` 风格（借鉴官方 CLI），支持 `:` `!=` `>` `<` `>=` `<=` `~` `!~`；**字符串 = 一个 AND 组，数组元素 = OR 组** |
| 富文本 | 禅道的 `desc` / `spec` 存的是 HTML，自动转 Markdown |
| 中文标签 | 文本摘要里会把 `status` / `pri` / `severity` 这类枚举翻成中文（**只改文本，不动 `structuredContent` 的键**） |

**结构化返回（`structuredContent`）的形状**：

- 列表类：`{ <复数资源>: [...], total, page, limit, pageTotal }`；
- 详情类：**单键容器** `{ project | execution | task | product | bug | story | <资源>: { ...实体 } }`，完整实体放在容器里。

为什么不把实体字段摊平到顶层？因为 MCP 客户端会用 `outputSchema` 校验结构化返回，而 zod object 默认带
`additionalProperties: false` —— 禅道实体有 **40~92 个字段**、且随版本漂移，白名单写多少个都不够，
一摊平就会被判定为「多余属性」，工具直接报 InvalidParams。`pick` 裁的就是容器里的那个对象。

参数与枚举值清单见 [MCP-SETUP.md 第五节](./MCP-SETUP.md#五可用工具11-个)。

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 编译到 `dist/` |
| `npm run start` | 运行编译产物 |
| `npm run dev` | 用 ts-node 直接跑源码 |
| `npm run verify` | **MCP 接入自检**：握手 + 列工具 + 真实调用一次 |
| `npm run verify:live` | **真机验收**：真客户端列工具 schema + **61 个只读用例** + ajv 校验（**改完工具 / `outputSchema` 必跑**） |
| `npm run test:auth` | 认证逻辑单测（纯离线，用本机 mock 服务器） |
| `npm run test:unit` | 纯函数单测（离线） |
| `npm run probe:cli` | 官方 CLI 在目标实例上的能力边界（只读） |
| `npm run probe:tools` | 列出本项目当前暴露的 MCP 工具 |
| `npm run probe:endpoints` | 目标实例的 REST 端点可达性矩阵（只读，**判断「能不能做」的权威依据**） |
| `npm run probe:modules-sdk` | **官方「模块 × 动作 × 版本门槛」清单（SDK 内省，推荐）** —— 直读 `zentao-api` 注册表，**不需要 clone 官方仓库**，还带 `method` / `path` |
| `npm run probe:official-modules` | 同上的 **markdown 模式**（读官方仓库 `docs/command-reference.md`，需先 clone）；两条路互为交叉验证 |
| `npm run probe:my-work` | `/my/work` 的 mode 支持性与数据区分度 |
| `npm run probe:smoke` | **全量只读动作冒烟扫描** → 产出「本实例兼容性矩阵」（只读；结果见 `docs/instance-compatibility-matrix.md`） |
| `npm run clean` | 清空 `dist/` |
| `npm test` | 跑全部 Jest（**13 套件 / 253 用例**，见下方「测试与验证」） |

---

## 项目结构

```
zendao-mcp/
├── src/
│   ├── index.ts            # 入口：加载配置 → 连禅道 → 注册工具 → 启动 stdio 服务
│   ├── client.ts           # 禅道 HTTP 客户端（v1/v2 双版本、认证、重试、401 自动重换 Token、
│   │                       #   PUT/DELETE 方法覆盖）
│   ├── config.ts           # 配置加载、baseUrl 规范化、API 版本解析、方法覆盖策略
│   ├── sdk/                # 官方 zentao-api 的接入层（通用层的地基）
│   │   ├── loader.ts       #   ESM 惰性单例（CJS 里用真 import() 加载纯 ESM 包）
│   │   ├── client-adapter.ts  # 鸭子类型传输适配器：复用本项目 axios（401 重登 / 代理 / 中文错误）
│   │   ├── version.ts      #   实例版本探测（匿名 getconfig）+ SDK 全局策略
│   │   ├── errors.ts       #   SDK 错误码 → 中文人话 + 下一步建议
│   │   └── index.ts        #   getSdkRuntime()：一处拿到 sdk / adapter / version / call
│   ├── tools/              # 12 个 MCP 工具的实现与注册（index.ts）
│   │   ├── sdkModules.ts / sdkHelp.ts / sdkCall.ts   # ⭐ 通用层三工具（官方 26 模块 / 229 动作）
│   │   ├── getBugs.ts              # Bug 列表 / 详情（含跨产品全库合并）
│   │   ├── getMyBugs.ts            # 我的 Bug（四种身份 + 含已关闭 + 按产品筛）
│   │   ├── getBugAttachments.ts    # Bug 附件（截图）下载：steps → fileID → 静态直取 → 本地文件
│   │   ├── getMyWork.ts            # 我的地盘四合一：Bug / 任务 / 需求 / 待办（mode 切换）
│   │   ├── getTask.ts              # 任务详情（可选操作历史 + 账号补人名）
│   │   ├── getUsers.ts             # 用户字典（账号 → 人名；官方 /users 是 404）
│   │   ├── batchCreateTasks.ts     # 批量创建任务（逐条 + 分批并发，禅道无原生批量接口）
│   │   └── index.ts        # 工具注册、schema、注解
│   ├── types/              # 类型定义（entities / batch / cache / MCP 结果类型）
│   ├── utils/
│   │   ├── logger.ts       # 日志（走 stderr）
│   │   ├── cache.ts        # LRU 缓存（单调 accessSeq 定序，避免同毫秒并列）
│   │   ├── response.ts     # 禅道响应解析（列表 / ID 字典归一化 + pager 归一化）
│   │   ├── labels.ts       # 字段名与枚举值的中文标签（SDK 字典 + 硬编码枚举表）
│   │   ├── filter.ts       # 官方 CLI 风格的 filter 表达式（status:active,pri<=2）
│   │   ├── products.ts     # 产品清单（含影子产品）+ 全库 Bug 逐产品合并
│   │   ├── myWork.ts       # 服务端「地盘」接口 /my/work（四种 mode + users 字典 + 账号补人名）
│   │   ├── attachments.ts  # Bug 附件解析：fileID 正则 / 服务器路径 → 静态 URL / 魔数嗅探 / 安全文件名
│   │   ├── fields.ts       # pick 字段摘取 / sort 排序
│   │   ├── format.ts       # 展示层格式化（工时单位归一等）
│   │   └── html.ts         # 禅道富文本 HTML → Markdown
├── tests/                  # Jest 测试（见下方警告）
├── scripts/
│   └── verify-mcp.js       # npm run verify 用的自检探针（⚠️ 手写 JSON-RPC，不做 ajv 校验）
├── docs/                   # official-module-parity（完整对照表）· porting-candidates（移植决策与进度）
│                           #   · vs-official-zentao-cli（能力差异总述）
│                           #   · instance-compatibility-matrix（本实例兼容性矩阵，自动生成）
├── .workbuddy/skills/zentao-cli-parity/
│   │                       # 对标 / 移植评估 skill：7 个探针脚本（官方 CLI 能力边界、工具清单、
│   │                       #   REST 端点可达性、真机验收、官方模块清单提取（SDK 内省 / md 双模式）、
│   │                       #   /my/work mode 扫描、全量只读动作冒烟），
│   │                       #   见该目录的 SKILL.md
├── MCP-SETUP.md            # ← 接入指南
├── MCP_TESTING_GUIDE.md    # 验证与测试指南
├── .env.example            # 环境变量模板
└── example-config.json     # 客户端配置示例
```

---

## 设计说明：参考禅道官方 CLI

工具层的几处设计参考了禅道官方命令行工具
[easysoft/zentao-cli](https://github.com/easysoft/zentao-cli)（及其底层 SDK
[zentao-api](https://github.com/easysoft/zentao-api)）：

1. **端点与参数以官方 API 定义为准** —— 任务走 `/executions/{executionID}/tasks`，
   状态靠 `start` / `finish` / `close` / `activate` 动作推进，而不是凭感觉拼一个 `/tasks`。
2. **通用数据处理参数** —— `pick` 摘字段、`sort`/`orderBy` 排序，避免把四十几个字段全塞给模型。
3. **工具注解（annotations）** —— 标注 `readOnlyHint` / `destructiveHint`，让客户端能做安全提示。
4. **富文本转 Markdown** —— 禅道的 `desc` / `spec` 存的是 HTML，自动转 Markdown 提升可读性、省 token。
5. **`filter` 表达式**（`utils/filter.ts`）—— 借鉴官方 CLI 的
   `--filter status:active,pri<=2,title~登录` 语法，支持 `:` `!=` `>` `<` `>=` `<=` `~` `!~`。
6. **Bug 模块 12 个动作全量覆盖** —— 官方 SDK 的 Bug 模块有
   `list / modules / create / get / update / updateModule / delete / deleteModule / activate / close / confirm / resolve`
   十二个动作，本项目现在通过通用层（`zendao_call { module: "bug", action: … }`）**全部可达**
   （P1 之前是 12 个手写工具，收敛后由通用层接管，能力没有减少）。
   端点与必填项（如 `resolve` 的 `resolution`）按官方 SDK 对齐；
   其中 `update` / `delete` / `modules` / `updateModule` / `deleteModule` 在**部分实例**
   受传输层限制或版本门槛影响不可用，见下文「禅道 REST API 的五个典型坑」第一、五条。

> 📊 **三份对比文档的分工：**
> - **[docs/official-module-parity.md](./docs/official-module-parity.md)** —— **完整对照表**：
>   官方 26 模块 × 229 个动作，逐个标注版本门槛、REST 实测结果、本项目覆盖情况，
>   以及「缺口分三档」（可直接移植 / 受阻 / 无路）。**判断「某个功能能不能做」看这份。**
> - **[docs/porting-candidates.md](./docs/porting-candidates.md)** —— **移植决策与实施进度**：
>   该做什么、优先级、做到哪了。**决定「下一步做什么」看这份。**
> - **[docs/vs-official-zentao-cli.md](./docs/vs-official-zentao-cli.md)** —— 能力差异总述：
>   该不该继续维护本项目、什么时候该考虑退役。
>
> ⚠️ 最需要记住的一点：**官方 CLI 的版本门槛，不是本项目的门槛**。本项目走 REST 直连，
> 所以「官方被 max8.5 拒掉」的功能（`my` 全部、`bug confirm`、`issue`/`risk`/`meeting` 列表）
> 反而常常是本项目的机会 —— 详见对照表第一节。
>
> 复现用的探针脚本在 `.workbuddy/skills/zentao-cli-parity/`（**全部只读**）：
> `npm run probe:modules-sdk`（官方全量清单与门槛，直读 SDK 注册表，**不需要 clone 官方仓库**）·
> `npm run probe:cli`（官方 CLI 侧边界）· `npm run probe:tools`（本项目 MCP 工具清单）·
> `npm run probe:smoke`（**全量只读动作冒烟扫描**，产出本实例兼容性矩阵
> → [`docs/instance-compatibility-matrix.md`](./docs/instance-compatibility-matrix.md)，自动生成、别手改）。

---

## 禅道 REST API 的五个典型坑

下面五条是使用禅道 REST API 时**反复出现**的问题 —— 属于**通性**，不是某台实例的怪癖。
括号里的实测结论来自本项目的参考实例（MAX8.2 + nginx 前置）；**你换到别的实例，行为可能不同**，
以 `npm run probe:smoke` 在你那台实例上实测出的
[兼容性矩阵](./docs/instance-compatibility-matrix.md) 为准。

### 一、PUT / DELETE 被掐断，而且「方法覆盖」救不了 —— 顺带两个实锤

实测本项目的目标实例，前置 Web 服务器会在 **HTTP 层直接拒绝** `PUT` / `DELETE` ——
连接被 `ECONNRESET` 掐掉，连响应体都不给。（`PATCH` 能到达应用层但路由不认。）

> ⚠️ **本节原先写过「应用层是好的，`POST + X-HTTP-Method-Override: PUT` 能转发到动作端点」—— 这个结论是错的，已修正。**
> 逐项实测：`_method` 放 query、放 body、`X-HTTP-Method-Override` 请求头，**三者在实例上全部无效**，
> 请求原样以 `POST` 落到应用层。当初看着像「生效」，是因为
> **Bug 的动作端点本来就能用 POST 直接调** —— 自欺欺人了一轮。

真相是这两条：

**① 动作端点认「路径」，不认方法。**

`POST /bugs/{id}/{action}` 本来就能直达动作，不需要任何方法覆盖。

> ⚠️ **更正（2026-11-20 复测）：路径里的 ID 是生效的。**
> 本节原先写「处理器只认 body 里的 ID，路径里的 ID 会被丢掉」，据此得出
> `POST /bugs/{id}/confirm {}` 会报 `Bug does not exist.`。复测推翻了这条：
> 路径 ID 不存在时同样报 `Bug does not exist.`，说明这个报错来自**路径匹配**，不是「没读 body」。
> 实测 `POST /api.php/v2/bugs/2011223/resolve`（body 不带 `bugID`）直接返回
> `{"status":"success","message":"保存成功"}`。
> 结论：**路径里的 ID 必须对**，body 里再带不带 `bugID` 都能成功。

**② 改 / 删本身没有 POST 版本，硬发会掉进建单路由。** `POST /bugs/{id}`（不带动作）会走进「建单」分支
（报 `Product does not exist.`），可能造出脏数据。所以通用层对 `update` / `delete` 一律
**刻意不降级成 POST**：传输层拒绝就如实报错并给指引 —— 宁可不做，也不写脏数据。

**③ SDK 那条路曾经漏掉整个降级（2026-11-20 修复）。** `client.put()` 有降级逻辑，但
`zendao_call` 走的是 `SdkClientAdapter.request()` → `client.requestRaw()`，**直接发原生 PUT**，
把降级整条绕过去了 —— 于是「读一切正常、改状态必失败」。现在适配器补上了
`requestWithActionFallback()`：动作端点 PUT 失败（连接被 RST，或代理回 502）就改用 POST 重发。

**④ 内网地址默认不走代理。** 本机 `HTTP_PROXY` 指向本地代理而 `NO_PROXY` 没含禅道网段时，
代理对 GET/POST 放行、**对 PUT 回 502**，症状与 ③ 一样但错误码不同（`ERR_BAD_RESPONSE` 而非
`ECONNRESET`）。现在 10/8、172.16/12、192.168/16、127/8、localhost 一律 `proxy: false`。

`ZENTAO_METHOD_OVERRIDE` 仍保留（`auto` 默认 / `always` / `never`），但既知方法覆盖在本实例无效，
它只是「换到别的实例也许有用」的兼容开关：

| 取值 | 行为 |
| --- | --- |
| `auto`（默认） | 先发真实方法；被传输层拒绝时改用覆盖重发一次，并记住本实例的偏好 |
| `always` | 所有 PUT/DELETE 一律走覆盖（已确认实例不支持原生方法时用） |
| `never` | 永不覆盖（调试原生方法时用） |

判定「被拒绝」的条件刻意收紧 —— 只看连接被重置 / `socket hang up` / HTTP 405 / 501。
禅道 2.0 的业务失败往往是 **HTTP 200 + `status:"fail"`**，这类**不会**被误判成方法问题。
回归测试见 `tests/auth/auth-config.test.ts` 里的「PUT/DELETE 方法覆盖」一组，
以及 `tests/unit/sdk-action-put-fallback.test.ts`（适配器降级 + 内网直连）。

**一句话记住：动作（resolve / close / activate）走 `POST /bugs/{id}/{action}`，适配器会自动降级；改 / 删本身在本实例做不了，去网页上做。**

### 二、没有接口能一次拿到「全库 Bug」

- 全局 `GET /bugs` **不带 `productID` 时只返回某一个产品**（本实例固定产品 9），
  且 `pager.recTotal` 也谎报成该产品的条数。
- `GET /products` 会**漏掉 `shadow=1` 的影子产品**（项目型产品）——
  本实例的 `2000076 电网储能工程造价分析系统` 就是这样：
  34 个产品里没有它，但它下面有 33 条 Bug。

两者叠加，全库 3767 条 Bug 一度只能看到 766 条，且恰好漏掉了当前账号那 6 条待处理 Bug。
现在「全局」范围由 `src/utils/products.ts` 的 `fetchAllBugs()` **逐产品遍历合并**
（产品清单取 `/products` ∪ `/bugs` 的 `products` 字典，含影子产品），并发 12、缓存 5 分钟。
回归测试见 `tests/auth/bug-list.test.ts`。

> **但「我的 Bug」有专门接口** —— `GET /api.php/v2/my/work?mode=bug&type=assignedTo`
> （就是网页 `m=my&f=work&mode=bug&type=assignedTo` 背后的那个）。
> 所以 `zendao_list_my_bugs` 默认口径是 **1 次请求约 1 秒**，不用走上面那条慢路。
> 封装见 `src/utils/myWork.ts`。

### 三、Bug 附件：不在 `files` 字段里，但可以零认证直取

本实例的 Bug **几乎条条都是「见图」型**（复现步骤正文只有一句话，信息全在截图里），
而 `zendao_get_bug` 返回的 `steps` 转成 Markdown 后只剩 `![](/zentaomax/index.php?m=file&f=read&t=png&fileID=…)`
—— 模型知道有图，但拿不到图。链路实测如下：

1. **Bug 实体的 `files` 字段恒为空数组**，截图是贴在「重现步骤」富文本里的，
   `<img src="/zentaomax/index.php?m=file&f=read&t=png&fileID=2016187">`。
   → 附件清单只能正则捞 `fileID`（同一个正则也覆盖 `<a href=…fileID=…>` 这类非图片附件）。
2. **`GET /api.php/v2/files/{id}` 是有效端点**（端点地图里原本没有），返回
   `{ file: { id, title, extension, size, addedBy, objectType, objectID }, status: "success" }`。
   ⚠️ **`size` 字段装的其实是服务器绝对路径，不是字节数**：
   `/opt/zbox/app/zentaomax/www/data/upload/1/202609/09171606076498e3`
   （存储文件名**没有扩展名**，真名在 `title` 里）。
3. 去掉 `…/www/` 前缀拼成 `{站点根}/data/upload/…` → **200 + 真图片，不需要任何认证**。

> 🔓 也就是说 **`data/upload/**` 是个匿名可读的静态目录** —— 只要知道那串随机存储名，
> 谁都能把附件拿走。内网环境风险有限，但**附件在保密意义上等于公开的**，值得知会一声。
> 前台 `m=file&f=read` 一律 302 跳登录页（登录页里没有 `verifyRand`，md5 与明文都试过），走不通。

封装见 `src/tools/getBugAttachments.ts` + `src/utils/attachments.ts`，
回归测试见 `tests/unit/bug-attachments.test.ts`。

### 四、ID 字典的顺序会被 JavaScript 规范化（列表整个颠倒）

禅道 v2 的部分列表接口返回的**不是数组，而是「ID 字典」**（`{ "2010523": {...}, … }`），
`/my/work` 与不带 `productID` 的 `/bugs` 都是这个形态。而 **ECMA-262 规定：对象的
「数组索引键」（0 ≤ n < 2³²−1 的整数字符串）在属性枚举中排在最前，且按数值升序** ——
于是 `JSON.parse` 那一刻，字典键的插入顺序（= 服务端的排序结果）被永久规范化成升序，
`Object.keys` / `Object.values` / `for...in` 全都拿不回来（`JSON.parse` 的 reviver 也救不了，
它拿到的 `this` 已经是规范化后的对象）。

实测证据（同一个响应）：服务端原始文本是 `2010523, 2010521, …, 2010511`，
同一条数据 `JSON.parse` 后再 `Object.values()` 就变成 `2010511, …, 2010523` ——
**表现是「我的待处理 Bug」列表与网页顺序整个颠倒，而且不报错**。

解法是 `src/utils/response.ts` 的 `restoreDictOrder()`：用服务端自报的 `orderBy`
把字典的值重排一次（缺省 `id_desc`，即禅道列表页的默认口径）。这不是凭空发明顺序，
而是把服务端已经排好、被 JS 吃掉的那层顺序重新算出来。两个边界：

- **数组天然保序，一律不动**（单产品 Bug、任务、项目返回的都是数组，服务端已经排好了）；
- 逐产品合并出来的结果**必须显式排序** —— 并发拉取 + Map 插入顺序，本来就没有确定顺序。

回归测试见 `tests/unit/dict-order.test.ts`（17 个用例，其中一条直接拿真实响应**文本**
走一遍 `JSON.parse`，复现完整受害链路）。

### 五、动作表单纯「整体替换」，少传一个字段就是清空它

这是本轮补 `confirm` 时才真正踩明白的：Bug 的动作端点**不是 `PATCH` 语义**，
它拿表单**覆盖整条记录** —— 你没提交的字段会被当成「置空」。

实测代价：给 Bug `2010511` 做 `confirm` 时只传了 `{bugID, status:"active"}`，
结果 `type` 从 `codeerror` 被清成空串、`assignedTo` 也被抹掉了（后来用工具重新补回）。

现在通用层（`zendao_call` 的 `update`）由官方 SDK 的 `autoFillUpdateParams()` 兜这一层：
**先 GET 当前对象 → 用现值补齐未显式传入的字段 → 再提交** ——
思路与 P1 之前手写的 `buildActionBody()` 完全一致，都是为了防「PUT 整体替换清空字段」。

> 回归测试见 `npm run verify:live`：61 条只读用例里有专门断言「单对象动作会忽略 `filter`」的一条，
> 并对所有工具的 `structuredContent` 顶层键与声明的 `outputSchema` 做 **ajv 校验**
> （`npm run verify` 探针不做这层校验，得靠它兜）。

---

## 测试与验证

**`npm test` 全绿（13 套件 / 253 用例）。其中 4 个套件 / 33 用例会连真机 —— 但全部只读。**

| 套件 | 用例 | 连真机 | 说明 |
| --- | --- | --- | --- |
| `tests/auth/auth-config.test.ts` | 61 | | 认证、配置、凭证来源优先级（含官方 CLI profile store）、PUT/DELETE 方法覆盖 |
| `tests/auth/bug-list.test.ts` | 38 | | Bug 列表口径与四种身份过滤 |
| `tests/unit/bug-attachments.test.ts` | 39 | | 附件解析（纯函数 + 端到端） |
| `tests/unit/dict-order.test.ts` | 17 | | ID 字典顺序还原 |
| `tests/unit/cache.test.ts` | 4 | | LRU 缓存 |
| `tests/unit/profile-store.test.ts` | 32 | | 官方 CLI profile store **只读**访问（路径 / 容错 / 选择 / 有效期推算） |
| `tests/error-handling/network-errors.test.ts` | 4 | | 网络错误与重试（替换 axios adapter，不打网络） |
| `tests/error-handling/api-errors.test.ts` | 6 | ✅ | 禅道业务错误映射 |
| `tests/tools/batch-create-tasks.test.ts` | 6 | | 批量建任务（**用假 client 保证不真写**） |
| `tests/startup.test.ts` | 15 | ✅ | 启动链路 |
| `tests/integration/e2e.test.ts` | 5 | ✅ | 跨工具只读数据流 |
| `tests/integration/mcp-server.test.ts` | 7 | ✅ | 子进程起真实 MCP 服务 + 只读调用 |

> ⚠️ 全绿的代价是那 4 个套件会**连真实禅道**（只读）；其余 8 个套件完全离线，
> 用本机 mock 或替换 axios adapter。

**两条验收命令，别混用**：

| 命令 | 校验什么 | 什么时候跑 |
| --- | --- | --- |
| `npm run verify` | 握手 + 列工具 + 真实调用一次（**手写 JSON-RPC，不做 ajv 校验**） | 改完接入配置 |
| `npm run verify:live` | **真客户端** 走 `tools/list` + 61 个只读用例，并对 `structuredContent` 做 **ajv 校验** | **改完工具或 `outputSchema` 必跑** |

> ⚠️ `npm run verify` 验不出「结构化返回与 schema 不匹配」这类问题（2026-09-15 那批详情类工具全炸就是这么漏过去的）。
> 改动了 `outputSchema` 或 `structuredContent` 时，必须跑 `npm run verify:live` —— 它用的是宿主同款 SDK
> （`@modelcontextprotocol/sdk` 的 `Client` + `StdioClientTransport`），会拿 `outputSchema` 真校验一遍。

详见 [MCP_TESTING_GUIDE.md](./MCP_TESTING_GUIDE.md) 与 [tests/README.md](./tests/README.md)。

---

## 安全

- `.env` 与 `.env.*` 已在 `.gitignore` 中忽略（只放行 `.env.example`），**不要手动提交**。
- 仓库历史上曾有 `fetch-token.sh` **明文硬编码真实账号密码**，位于仓库根目录，**已删除**。
  若本仓库曾经 push 过，凭据应视为已外泄，**建议修改禅道密码**。
- `tests/README.md`、`openspec/` 里出现的 `s000001` / `q1w2E#R$` 是原作者的**占位示例**，不是真实凭据。

---

## 许可

ISC

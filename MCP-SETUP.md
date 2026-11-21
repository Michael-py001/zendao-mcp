# 禅道 MCP 接入指南

把本项目的 MCP 服务器接进任意支持 MCP 的 AI 客户端（WorkBuddy / Cursor / VS Code / Codex / Claude Desktop…），
让 AI 能直接读写禅道的项目、执行、任务，以及产品、项目集与 Bug。

- **推荐安装**：`npx -y @michael_py001/zendao-mcp init`（自动检测并写入各 agent 配置）
- **服务入口**：`npx -y @michael_py001/zendao-mcp mcp`（stdio，无需本地 clone 仓库）
- **凭证来源**：agent 配置里的 `env`：`ZENTAO_URL` / `ZENTAO_ACCOUNT` / `ZENTAO_PASSWORD`
- **API 版本**：**禅道 API 2.0**（`{站点根}/api.php/v2`）
- **工具数量**：14 个（**通用层 3**：`modules` / `help` / `call`，覆盖官方 26 模块 × 229 个动作；**手写兜底 11**：官方给不了的实例特有能力）

> ⚠️ 按当前配置方案，凭证以明文写进 agent 配置。请勿把含凭证的配置提交到 git。
> 从源码手动运行时，服务也会读取 `.env`（`ZENDAO_ENV_FILE` 可显式指定真实凭证文件）。

---

## 一、先搞懂禅道的数据结构（否则工具会用错）

这是踩过坑之后最重要的一条认知。禅道有**两条**并行的分层线：

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

**任务挂在「执行」下，不是挂在「项目」下。** 由此推出两条硬规则：

1. 查任务必须给 `executionID`，**不存在「全局任务列表」**。本实例上顶层的
   `GET /api.php/v2/tasks` 直接返回 404。
2. 建任务同样要给 `executionID`（不是 `project`）。

**Bug 挂在「产品」下，不是挂在「项目」下。** 同理：

1. 查 Bug 优先给 `productID`（不知道就先调 `zendao_call { module: "product", action: "list" }`）。
2. 建 Bug 必须给 `productID` + `title`。

⚠️ **两条线会「同名配对」——这是最容易懵的地方，也正是「影子产品」的由来。**

禅道在建项目时会**自动为它配一个「项目型产品」**（`shadow=1`，`/products` 列表接口会把它
隐藏掉），项目的需求 / Bug 都挂在这个产品下。于是同一个业务系统会同时有**两个 ID**：

| 实体 | ID | 在哪能看到 |
| --- | --- | --- |
| 项目（交付线） | `2000546` | 网页「项目」菜单 → 打开项目详情 |
| 项目型产品（产品线） | `2000076` | Bug 页面的产品下拉框；**不在 `/products` 列表里** |

两者**同名**「电网储能工程造价分析系统」、同属项目集 `1000578`。
所以：**查这个项目的 Bug 要用产品 ID `2000076`，不是项目 ID `2000546`。**

所以典型调用链是：

```
call project list                          → 拿到项目 id
  ↓
call execution list { projectID }          → 拿到执行 id（executionID）
  ↓
call task list { executionID }             → 拿到任务
call task create { name, executionID }     → 建任务

call product list                          → 拿到产品 id
  ↓
zendao_list_bugs { productID }             → 拿到 Bug（手写工具，含全库合并）
call bug create { productID, title }       → 建 Bug
  ↓
call bug resolve { bugID, resolution }     → 解决 Bug
```

> 上面 `call xxx` 是 `zendao_call { module: "xxx", action: "…" }` 的简写 —— 完整写法与
> 24 个旧工具名的对照见第五节开头的「常用动作：旧工具名 → 通用层写法」表。
> 只有 `zendao_list_bugs` 等 8 个手写工具需要单独记。

> 原实现把任务工具写成 `GET /api.php/v1/tasks` + `project` 参数，在这个实例上必然 404。
> 现已按官方 API 定义全部修正。

### 项目集（program）只有列表接口

`zendao_call { module: "program", action: "list" }` 打的是 `GET /programs`。注意两点本实例的真实行为：

1. **详情端点 `/programs/{id}` 返回 404** —— 所以官方注册表里 `program` 的 `get` 在这个实例上不可用。
2. `/programs` 返回的数组**混装了项目**（`type === 'project'` 的条目也在里面），且服务端分页不可信。
   ⚠️ P1 之前的手写工具会按 `type === 'program'` 过滤掉项目、改本地分页并注明剔除了多少条；
   **通用层不做这层加工** —— 拿到结果后请自己按 `type` 过一遍（或配 `filter`）。

---

## 二、认证方式

禅道 API 2.0 的标准姿势是**两步**：

```bash
# 1) 用账号密码换 Token
curl -X POST "http://zen.example.com/zentaomax/api.php/v2/users/login" \
  -H "Content-Type: application/json" \
  -d '{"account":"你的账号","password":"你的密码"}'
# → {"status":"success","token":"<redacted-token>","user":{...}}

# 2) 带着 Token 访问业务接口（Token 是请求头，不是 Cookie、不是 query 参数）
curl "http://zen.example.com/zentaomax/api.php/v2/projects?recPerPage=1" \
  -H "Token: <redacted-token>"
# → {"status":"success","projects":[...],"pager":{...}}
```

本项目把第 1 步**内置**了。你只要在 `.env` 里填账号密码：

```env
ZENTAO_BASE_URL=http://zen.example.com/zentaomax
ZENTAO_ACCOUNT=你的账号
ZENTAO_PASSWORD=你的密码
```

程序启动时自动换 Token，缓存在内存里；**遇到 401 会自动丢弃旧 Token、重换、重试一次**。
所以你完全不用管 Token 什么时候过期。

### 三种凭证来源对照

程序按下表**从上到下**挑第一个可用的来源，前面的配了就不会看后面的。

| 方式 | 配置项 | 有效期 | 说明 |
| --- | --- | --- | --- |
| **账号密码（推荐）** | `ZENTAO_ACCOUNT` + `ZENTAO_PASSWORD` | 自动续期 | 程序自己调 `/api.php/v2/users/login`，401 自动重换 |
| 静态 Token | `ZENTAO_TOKEN` | 视来源而定 | 32 位 hex → 走 `Token` 请求头 |
| **复用官方 CLI 登录态** | 无需配置 | ⚠️ 有寿命（本实例 4 小时） | 装了 `zentao-cli` 并 `zentao login` 过就直接能用；**store 不存密码、无法自动续期**，见下方说明 |
| ~~`账号:zentaosid`~~ | `ZENTAO_TOKEN` | **1~5 分钟** | 旧的会话 Cookie 方案，兼容代码还在，但**不要再用了** |

#### 关于「复用官方 CLI 登录态」

本机装过官方 `zentao-cli` 并 `zentao login` 过的话，凭证会落在官方 profile store 里，本项目**只读**它：

| 项 | 值 |
| --- | --- |
| 默认路径 | `~/.config/zentao/zentao.json`（Windows：`%USERPROFILE%\.config\zentao\zentao.json`） |
| 覆盖路径 | `ZENTAO_CONFIG_FILE=<文件路径>`（与官方 CLI 用同一个环境变量，方便共用一个 store） |
| 选哪个 profile | `ZENTAO_PROFILE=<profile 标识>`；不填则用 store 里的 `currentProfile`，若唯一也自动选中 |
| 带出什么 | 只有 **Token** + 站点地址。store **不存密码**，所以这条路**不能自动续期** |

> ⚠️ **Token 有寿命：本实例 4 小时**（`serverConfig.expiredTime=14400` 秒，由签发时刻起算）。
> 实测一个两天前签发的 token 打接口是 `401 Not allowed`，而同时新 login 的 token 可用
> （且多个 token **可并存**，不存在「后签顶掉前签」）—— 所以过期才是主因。
>
> 因此这条路适合「刚刚登录过、临时用一下」；**长期无人值守请用第一种（账号密码）**。
>
> 过期时会给出**专门**的报错，直接告诉你「重新 `zentao login`」，不会让你去查 `ZENTAO_TOKEN`；
> 启动时若推算出 Token 已过期，也会先打一条 `WARN` 提醒（推算不出就不猜，交给 401 兜底）。

> ⚠️ 本项目**绝不往用户 home 目录写任何东西**（不建锁文件、不改 store、不落新 profile），
> 只有读取。store 文件损坏 / 缺 `profiles` / 里面一条都选不出来时，都会给出**说明原因**的报错，不会静默降级。

> ⚠️ 历史坑：`zentaosid` 是浏览器会话 ID，寿命只有几分钟，靠它做自动化必然反复 401。
> 这也是旧版文档里 `GETTING-TOKEN.md` / `fetch-token.sh` 那套方案失败的根本原因 —— **那套东西已经删掉了**。

### 关于 `ZENTAO_BASE_URL`

填**站点根地址**，形如 `http://host/zentaomax`。几种常见错法：

| 写法 | 结果 |
| --- | --- |
| `http://host/zentaomax` | ✅ 正确 |
| `http://host/zentaomax/` | ✅ 可以，程序会自动去掉结尾 `/` |
| `http://host/zentaomax/index.php` | ❌ 打到**前台路由**，返回登录页 HTML，报「API 请求失败」 |
| `http://host/zentaomax/api.php/v2` | ✅ 也可以，程序会嗅探出版本并剥掉这段 |

`normalizeBaseUrl()` 会自动清理结尾 `/`、`/index.php`，以及误加的 `/api.php/vX`。

### API 版本切换

默认走 **v2**（API 2.0）。如果遇到极老的禅道，可在 `.env` 里回落：

```env
ZENTAO_API_VERSION=v1
```

v1 与 v2 的差异（客户端已自动处理，列出来便于排查）：

| | v1 | v2（默认） |
| --- | --- | --- |
| 换取 Token | `POST /api.php/v1/tokens` | `POST /api.php/v2/users/login` |
| 成功响应 | 直接返回资源本体 | `{ "status": "success", ... }` |
| 失败响应 | `{ "error": "..." }` | `{ "status": "fail", "message": "..." }` |
| 分页参数 | `page` / `limit` | `pageID` / `recPerPage` |
| 总数 | `total` | `pager.recTotal` |

> 工具层对外统一用 `page` / `limit`，映射由客户端按版本自动完成。

### 全部环境变量一览

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `ZENTAO_BASE_URL` | ✅ | `http://localhost` | 站点根地址，形如 `http://host/zentaomax` |
| `ZENTAO_ACCOUNT` | ✅* | — | 登录账号（与密码成对，自动换 Token） |
| `ZENTAO_PASSWORD` | ✅* | — | 登录密码 |
| `ZENTAO_TOKEN` | 备选 | — | 静态凭证；配了账号密码时被忽略 |
| `ZENTAO_PROFILE` | 备选 | store 的 `currentProfile` | 官方 CLI profile store 里选哪个 profile（仅第三种凭证来源用得到） |
| `ZENTAO_CONFIG_FILE` | 备选 | `~/.config/zentao/zentao.json` | 官方 CLI profile store 的路径，与官方 CLI 共用同一变量 |
| `ZENTAO_API_VERSION` | — | `v2` | `v2` / `v1` |
| `ZENTAO_METHOD_OVERRIDE` | — | `auto` | PUT/DELETE 方法覆盖策略：`auto` / `always` / `never`（见第六节坑 3 —— ⚠️ 本实例上覆盖**无效**，仅作兼容开关） |
| `ZENTAO_TIMEOUT` | — | `30000` | 单次请求超时（毫秒） |
| `ZENTAO_RETRY` | — | `3` | 网络错误 / 5xx 的重试次数 |
| `ZENTAO_RETRY_DELAY` | — | `1000` | 重试间隔（毫秒） |
| `LOG_LEVEL` | — | `INFO` | `DEBUG` / `INFO` / `WARN` / `ERROR` |
| `NO_PROXY` | 视环境 | — | 若环境注入了 `HTTP_PROXY` 且禅道在内网，需把禅道主机加进来 |
| `ZENTAO_VERSION` | — | 自动探测 | 显式指定实例版本（`max8.2` / `22.0` / `biz13.0` / `ipd5.0`）。默认走匿名 `/?mode=getconfig` 探测；只在**探测被网关拦掉**时才需要手动设，设错会导致版本门槛判定整体偏移 |
| `ZENTAO_INSECURE` | — | `false` | 跳过 TLS 证书校验，供**自签证书**的内网实例使用 |
| `ZENTAO_REC_PER_PAGE` | — | `20` | 通用层（`zendao_call`）的默认每页条数 |

\* 凭证按「账号密码 → 静态 Token → 官方 CLI profile store」的优先级自动挑选，三种只需有一种可用。
装过官方 `zentao-cli` 的同事可以**零配置**直接用（见第二节）。

---

## 三、三步接入

### 第 1 步：一键安装

```bash
npx -y @michael_py001/zendao-mcp init
```

自动检测本机已装的 agent → 多选目标 → 填写禅道地址/账号/密码 → 写入各自配置。
`--list-agents` 可看全部受支持的 agent，`--dry-run` 只看计划不写文件。

### 第 2 步：确认凭证

init 会把这三项写进每个 agent 配置的 `env`：

```json
{
  "ZENTAO_URL": "http://zen.example.com/zentaomax",
  "ZENTAO_ACCOUNT": "你的账号",
  "ZENTAO_PASSWORD": "你的密码"
}
```

也可以手工填写下一节的片段。密码是明文，注意配置文件的 git 状态。

### 第 3 步：重启客户端

写完后**重启客户端**（WorkBuddy 需额外点「信任」）。用 `doctor` 检查配置是否齐全。

---

## 四、各客户端配置片段

### JSON 类客户端（Cursor / Claude Desktop / Windsurf / Cherry Studio / Claude Code…）

键名是 `mcpServers`：

```json
{
  "mcpServers": {
    "zentao-cli": {
      "command": "npx",
      "args": ["-y", "@michael_py001/zendao-mcp", "mcp"],
      "env": {
        "ZENTAO_URL": "http://zen.example.com/zentaomax",
        "ZENTAO_ACCOUNT": "你的账号",
        "ZENTAO_PASSWORD": "你的密码"
      }
    }
  }
}
```

### VS Code

**键名是 `servers`，不是 `mcpServers`** —— 这是最容易踩的坑：

```json
{
  "servers": {
    "zentao-cli": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@michael_py001/zendao-mcp", "mcp"],
      "env": {
        "ZENTAO_URL": "http://zen.example.com/zentaomax",
        "ZENTAO_ACCOUNT": "你的账号",
        "ZENTAO_PASSWORD": "你的密码"
      }
    }
  }
}
```

### Codex（TOML）

追加到 `~/.codex/config.toml` 的**文件末尾**：

```toml
[mcp_servers.zentao-cli]
command = "npx"
args = ["-y", "@michael_py001/zendao-mcp", "mcp"]
env = { ZENTAO_URL = "http://zen.example.com/zentaomax", ZENTAO_ACCOUNT = "你的账号", ZENTAO_PASSWORD = "你的密码" }
```

> ⚠️ 必须追加到真正的文件末尾。若插到别的表中间，后面的键会被**错误地吞进**这个段落里，弄坏原有配置。

### 其他客户端

| 客户端 | 配置位置 | 说明 |
| --- | --- | --- |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | 键名 `mcpServers`，改完要**完全退出**再重启 |
| Claude Code | 项目内 `.mcp.json`，或命令行 `claude mcp add` | 键名 `mcpServers` |
| Windsurf | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` | 键名 `mcpServers` |
| Cline / Roo Code | VS Code 插件设置面板 | 图形界面填 command / args，不改文件 |
| Cherry Studio | 设置 → MCP 服务器 | 图形界面添加，类型选 `stdio` |
| Trae | 设置 → MCP | 图形界面添加 |
| Continue | `%USERPROFILE%\.continue\config.json` | 字段 `mcpServers` |
| Zed | `%APPDATA%\Zed\settings.json` | 字段是 `context_servers` |

### 关于 `command` 写不写绝对路径

```json
{ "command": "node", "args": ["...dist\\index.js"] }
```

这样写**只有在客户端能继承到系统 `PATH` 时**才有效。GUI 客户端经常拿不到完整 `PATH`，
会报 `spawn node ENOENT`。**写绝对路径最稳。**

---

## 五、可用工具（12 个）

**结构**：**通用层 3 个**（覆盖官方 26 模块 / 229 个动作）+ **手写兜底层 9 个**（只做官方给不了的实例特有能力）。

### ⭐ 通用层（3 个）

| 工具名 | 作用 | 关键参数 |
| --- | --- | --- |
| `zendao_modules` | 列出当前实例**实际可用**的模块与动作 | `module?`（下钻）、`keyword?`、`includeUnsupported?` |
| `zendao_help` | 查动作的完整参数表（类型 / 必填 / 枚举 / 中文说明） | `module` `action?`（省略则列全模块）`role?` |
| `zendao_call` | 执行任意官方动作 | `module` `action` `params?` `page?` `recPerPage?` `pick?` `sort?` `limit?` `search?` `filter?` `autoFill?` `convertHtml?` `raw?` |

这三个工具由官方 `zentao-api` 的**声明式动作注册表**驱动，覆盖官方 CLI 的全部
**26 个模块 / 229 个动作**（含产品、项目、执行、需求、任务、Bug、版本、发布、测试、反馈、工单、计划、地盘、文档…），
不需要为每个动作单独写工具。

**标准三步走**：

```
zendao_modules                                  ← 有哪些动作？（按实例版本过滤）
zendao_help { module: "bug", action: "list" }   ← 参数怎么传？
zendao_call { module: "bug", action: "list", params: { productID: 7 } }
```

**几个关键约定**：

| 事项 | 说明 |
| --- | --- |
| 参数怎么传 | **平铺**在 `params` 里 —— path / query / body 字段不区分角色，例如 `{ productID: 7, pageID: 1 }` |
| 分页 | 对外用 `page` / `recPerPage`（默认每页 20）；SDK 内部会映射成 v2 的 `pageID` / `recPerPage` |
| 本地处理 | `pick` / `sort` / `limit` / `search` / `filter` 都是**在服务端结果之上做本地处理**，不额外发请求 |
| ⚠️ `filter` / `search` 的边界 | 只在**列表类**动作上生效；单对象（`get`）动作会**静默忽略** —— 返回值里会给出提示 |
| `filter` 表达式 | `status:active,pri<=2` 风格（借鉴官方 CLI），**字符串 = 一个 AND 组，数组元素 = OR 组** |
| 中文标签 | 文本摘要会把 `status` / `pri` / `severity` 这类枚举翻成中文（**只改文本，`structuredContent` 的键不变**） |
| 富文本 | 默认把 HTML 字段转 Markdown（`convertHtml: false` 可关） |
| 写操作 | `create` / `update` / `delete` / `close` 会**真的落库**；`update` 默认 `autoFill`（先取现值再提交，避免未提交字段被清空） |
| 版本门槛 | 某动作报「版本不支持」= 该禅道版本确实没这个能力，**不是配置错误**；用 `zendao_modules` 看替代动作 |
| 原始响应 | `raw: true` 返回服务端原文（不做结果提取与本地处理），排查问题时用 |

> ⚡ **能力上限随实例版本变化** —— 同一份构建在旗舰版 `max8.2` 上放行 106 个动作，
> 在 `max8.5+` / 企业版 / IPD 版上按各自产品线判定。判定依据是实例匿名自报的 `/?mode=getconfig`。

### 常用动作：旧工具名 → 通用层写法

P1 收敛时删掉了 24 个「一工具一动作」的封装，**能力一个都没少**，只是改用 `zendao_call` 表达：

| 原来的工具 | 现在的写法 |
| --- | --- |
| `zendao_list_projects` | `zendao_call { module: "project", action: "list" }` |
| `zendao_get_project` | `… { module: "project", action: "get", params: { projectID } }` |
| `zendao_create_project` | `… { module: "project", action: "create", params: { name, code, begin, end } }` |
| `zendao_list_executions` | `… { module: "execution", action: "list" }` |
| `zendao_get_execution` | `… { module: "execution", action: "get", params: { executionID } }` |
| `zendao_list_tasks` | `… { module: "task", action: "list", params: { executionID } }` |
| `zendao_create_task` | `… { module: "task", action: "create", params: { name, executionID } }` |
| `zendao_update_task_status` | `… { module: "task", action: "start" / "finish" / "close" / "activate", params: { taskID } }` |
| `zendao_list_products` | `… { module: "product", action: "list" }` |
| `zendao_get_product` | `… { module: "product", action: "get", params: { productID } }` |
| `zendao_list_programs` | `… { module: "program", action: "list" }` |
| `zendao_list_stories` | `… { module: "story", action: "list", params: { productID } }` |
| `zendao_get_story` | `… { module: "story", action: "get", params: { storyID } }` |
| `zendao_list_builds` | `… { module: "build", action: "list", params: { scope: "executions", scopeID } }` |
| `zendao_create_bug` | `… { module: "bug", action: "create", params: { productID, title } }` |
| `zendao_update_bug` | `… { module: "bug", action: "update", … }` ⚠️ 本实例 PUT 被传输层掐断 |
| `zendao_resolve_bug` | `… { module: "bug", action: "resolve", params: { bugID, resolution } }` |
| `zendao_close_bug` | `… { module: "bug", action: "close", params: { bugID } }` |
| `zendao_activate_bug` | `… { module: "bug", action: "activate", params: { bugID } }` |
| `zendao_confirm_bug` | `… { module: "bug", action: "confirm", params: { bugID, status: "active" } }` |
| `zendao_delete_bug` | `… { module: "bug", action: "delete", params: { bugID } }` ⚠️ 本实例 DELETE 被掐断 |
| `zendao_list_bug_modules` | `… { module: "bug", action: "modules", params: { productID } }` |
| `zendao_update_bug_module` | `… { module: "bug", action: "updateModule", … }` |
| `zendao_delete_bug_module` | `… { module: "bug", action: "deleteModule", … }` |

> ⚠️ **两处行为差异**（手写封装删掉后**没有**被通用层接管的附加值，用之前要知道）：
>
> 1. **项目列表的默认口径变了**：原来 `zendao_list_projects` 不传参时**默认只列「进行中」**（`browseType=doing`，
>    本地放大拉取 + 精确匹配），现在 `zendao_call { module: "project", action: "list" }` 返回**服务端默认口径**。
>    要筛状态请显式带 `filter`，或在结果上自己过一遍。
> 2. **通用层不自动补人名**：`xxxName` 字段只有 `zendao_list_my_work` / `zendao_get_task` 会补。
>    需要「账号 → 人名」时用 `zendao_list_users`，或自己取 `/my/work` 响应里的 `users` 字典。

### ⚠️ 两条端点事实（写法变了，坑没变）

⭐ **版本挂在「执行」下，不是产品 / 项目下**（2026-09-17 实测）：

| 端点 | 结果 |
| --- | --- |
| `GET /executions/{id}/builds` | ✅ 可用 |
| `GET /products/{id}/builds` | ❌ 404 |
| `GET /projects/{id}/builds` | ❌ 404 |
| `GET /builds`（全局） | ❌ 404 |

所以 `zendao_call { module: "build", action: "list" }` **必须显式给 `scope: "executions"` + `scopeID`**
（`build/list` 的路径就是 `/{scope}/{scopeID}/builds`）。
这也正是 Bug 的「影响版本」`openedBuild` / 「解决版本」`resolvedBuild` 一直只能硬填 `trunk` 的原因 ——
把这里拿到的版本 `id` 传给 `zendao_call { module: "bug", action: "create" / "resolve" }` 即可。
实测 304 个执行中 **121 个**有版本数据，但集中在「海上风电」那条线；
储能 / 技经项目下大概率没有版本，那类 Bug 继续填 `trunk` 就对了。

⚠️ **没有全局需求列表**：`GET /stories`、`/epics`、`/requirements` 在本实例**全是 404**，
所以 `zendao_call { module: "story", action: "list" }` 必须带 `productID` 或 `projectID`。
`zendao_get_bug` 返回的 `story` 字段就是**需求 ID**，可以直接丢给
`zendao_call { module: "story", action: "get", params: { storyID } }`。
（P1 之前这条断链靠手写的 `zendao_get_story` 补，现在由通用层接管。）

### 手写兜底层（9 个）—— 官方给不了的

| 工具名 | 作用 | 关键参数 |
| --- | --- | --- |
| `zendao_list_bugs` | Bug 列表（含**跨产品全库合并**） | `productID?` 或 `scope`+`scopeID`（products/projects/executions）`browseType?` `status?` `severity?` `pri?` `type?` `assignedTo?` `keyword?` `filter?` `filterMode?` `page` `limit` `orderBy?` `pick?` `sort?` |
| `zendao_get_bug` | Bug 详情 | `bugID` `includeActions?`（附操作历史）`pick?` |
| `zendao_get_bug_attachments` | **Bug 附件（截图）**下载到本地，返回可直开的绝对路径 | `bugID` |
| `zendao_list_my_bugs` | **我的 Bug**（按身份列出与当前账号相关的） | `role?`（`assigned` 指派给我 / `opened` 我创建 / `resolved` 我解决 / `edited` 我最后修改 / `any` 任一，默认 `assigned`）`includeClosed?`（默认 false = 只看待处理）`status?` `productID?` `keyword?` `page` `limit` `orderBy?` `pick?` `sort?` |
| `zendao_list_my_work` | **我的任务 / 我的需求 / 我的待办 / 我的 Bug** | **`mode`（必填：`task` / `story` / `todo` / `bug`）** `type?`（默认 `assignedTo`）`includeClosed?` `status?` `keyword?` `resolveUserNames?` `page` `limit` `sort?` `pick?` |
| `zendao_list_my_efforts` | **我的日志（工时）**——工作内容 / 日期 / 工时；官方完全没有的能力 | `type?`（服务端口径，默认 `all`：`today`/`yesterday`/`thisweek`/`lastweek`/`thismonth`/`lastmonth`）`date?`（**单日**，`20261015` 或 `2026-10-15`）`begin?` `end?`（区间）`keyword?` `orderBy?`（默认 `date_desc`）`summary?` `page` `limit` `sort?` `pick?` |
| `zendao_get_task` | **任务详情**（含描述；可选带操作历史） | `taskId` `includeActions?` `resolveUserNames?`（默认 true）`pick?` |
| `zendao_list_users` | 用户字典（**账号 → 人名**） | `keyword?` `account?` `realNameOnly?` `page` `limit` `sort?` `pick?` |
| `zendao_batch_create_tasks` | 批量创建任务（≤50，逐条 + 分批并发） | `executionID?`（统一归属）`items[]`（≤50）`options?` |

**为什么这 9 个不能交给通用层**：

- `list_bugs` 的「全库」范围要**逐产品遍历合并**（含影子产品），官方与 SDK 都只给「单范围」；
- `get_bug_attachments` —— 官方 `file` 模块**只能上传 / 改名 / 删除，不能下载**；
- `list_my_bugs` / `list_my_work` 走 `/my/work`，而官方整个 `my` 模块要 max8.5；
- `list_my_efforts` 走 `/my/effort` —— 官方注册表里**根本没有 effort 模块**（官方 SDK 里连这个词都搜不到），
  而且它的日期过滤得自己在本地下（服务端只认 `type` 预设）；
- `list_users` 补 `/users` 404 的洞（人名取自 `/my/work` 自带字典）；
- `batch_create_tasks` —— 禅道没有原生批量接口，本项目是「逐条 + 分批并发」自研。

#### `list_my_work` 的四种 mode 实测差异

`GET /my/work?mode=…` 是**同一个接口**，换 mode 就换资源：

| mode | 列表字段 | 备注 |
| --- | --- | --- |
| `bug` | `bugs` | 与 `zendao_list_my_bugs` 重叠 |
| `task` | `tasks` | 附带 `summary`（中文汇总句） |
| `story` | `stories` | 附带 `gradeGroup` / `showGrade` |
| `todo` | `todos` | 顶层是 `todos` + `date` + `waitCount` / `doingCount`，**没有 `todoCount`**；服务端忽略分页参数，本工具改走本地分页 |

`type`（身份口径）实测取值：`assignedTo` / `openedBy` / `resolvedBy` / `assignedBy` / `closedBy` / `feedbackBy`
—— **其余值会静默返回 0 而不报错**，所以结果为空时不要急着下结论。
`todo` 没有身份维度，该参数会被忽略。

⭐ 这几个工具覆盖的是**官方 CLI 在本实例给不了**的区域：
官方 `/my/tasks`、`/my/stories`、`/my/todos`、`/users`、`/users/{id}`、`/{projects|executions}/{id}/members`
**全是 404**（整个 `my` 模块要 max8.5；用户端点则压根没有实现）。

`zendao_list_users` 通常不必手动调：`zendao_list_my_work` / `zendao_get_task` 默认就会把 `assignedTo`
这类账号补上 `xxxName` 字段（人名来自 `/my/work` 响应自带的 `users` 字典，本实例 207 条，另有 `memberPairs` 106 条）。

### 怎么查「我待处理的 Bug」

直接用 `zendao_list_my_bugs`，默认口径就是「指派给我 + 未关闭」：

```
zendao_list_my_bugs                           → 我待处理的 Bug（默认，约 1 秒）
zendao_list_my_bugs { includeClosed: true }   → 连已关闭的也列出来
zendao_list_my_bugs { role: "resolved" }      → 我解决过的
zendao_list_my_bugs { productID: 9 }          → 只看某个产品
```

> 默认口径走服务端「地盘」接口，**一次请求**就返回，与网页「我的地盘 → Bug」逐条一致。

⚠️ **「我」在禅道里有四种身份，分散在不同字段上**，各自的数据量可能相差极大：

| `role` | 对应字段 | 含义 |
| --- | --- | --- |
| `assigned`（默认） | `assignedTo` | 指派给我 —— 「待处理」通常指这个 |
| `opened` | `openedBy` | 由我创建 |
| `resolved` | `resolvedBy` | 由我解决 |
| `edited` | `lastEditedBy` | 由我最后修改 |
| `any` | 以上任一个 | 与我相关 |

实测本实例（账号 `your-account`）的分布 —— 全库 **3767** 条 Bug（35 个产品）里：

| 身份 | 命中 | 其中未关闭 |
| --- | --- | --- |
| `assignedTo` 指派给我 | **6** | 6 ← 网页「待处理」的那 6 条 |
| `openedBy` 我创建 | 0 | 0 |
| `resolvedBy` 我解决 | 321 | 1 |
| `lastEditedBy` 我最后修改 | — | 1 |

这个账号既是「被指派人」也是「解决人」，只查一种身份必然漏。

因此工具在几处做了保护，避免把「查不到」误报成「没有」：

1. 结果为 0 时，返回里会写明「已扫描 N 条、匹配该身份的 M 条」；
   若是「命中了但全已关闭」，会直接提示加 `includeClosed: true`。
2. 拿不到当前账号时（用静态 `ZENTAO_TOKEN` 登录，token 里没有账号信息）**直接报错**，
   **绝不「不过滤就返回全库」** —— 那比报错危险得多。
3. 结果为 0 时，还会把**四种身份各自的命中数**一并列出，一眼就能看出
   「我是不是该换个 role 查」，省一轮来回。
4. 结果里**始终写明用了哪个数据源**（`structuredContent.source`）——
   「慢路还是快路」直接决定要不要怀疑数据完整性。

> 另外注意：本实例的 `browseType=assignedtome` 服务端**不认**（返回空集而不报错），
> 所以身份过滤一律在本地做。这条路径在 `tests/auth/bug-list.test.ts` 里有回归测试守着。

#### ✅ 首选数据源：服务端「地盘」接口 `GET /my/work`

**v2 是支持「我的待处理 Bug」的**，只是路径不叫 `/my/bugs`（那个 404）：

```
网页   index.php?m=my&f=work&mode=bug&type=assignedTo
接口   GET /api.php/v2/my/work?mode=bug&type=assignedTo
```

`mode` 选资源（`bug` / `task` / `story` / `todo`），`type` 选身份。
实测的 `type` 取值：`assignedTo` / `openedBy` / `resolvedBy` / `assignedBy` / `closedBy` / `feedbackBy`
（其余值**静默返回 0 而不报错**）。分页参数就是常规的 `pageID` / `recPerPage`，翻页可靠
（`recPerPage` 取 20 / 100 / 200 拉到的 ID 集合完全一致）。

走这条路的收益很直接：**1 次请求、约 1 秒**，而「逐产品合并」是 35 次请求、约 10 秒。
本实例默认口径的实测耗时是 **1031ms**（此前约 9700ms）。

三个实测细节，照直觉写就会踩：

| 细节 | 表现 | 处理 |
| --- | --- | --- |
| `bugs` 字段是 **ID 字典** | `{ "2010511": {...} }`，只有空结果时才退化成数组 `[]` | 统一交给 `extractList()` 归一化（`utils/response.ts`） |
| 顶层 `recTotal` **恒为 0** | 真实总数只在 `pager.recTotal`；本实例 `resolvedBy` 真实是 321 条，误读顶层会变成 0 | `extractList()` 优先取 `pager`，直接读它的 `pager.total` |
| `type` 语义**自带状态条件** | `assignedTo` 只给未关闭的（「待处理」口径），而 `resolvedBy` 会把已关闭的一并给出 | 「含已关闭」这种需求不能指望它，见下面 |

封装在 `src/utils/myWork.ts`。工具自动在两条路之间选：

| 条件 | 走哪条 | 原因 |
| --- | --- | --- |
| `role` ∈ {`assigned`,`opened`,`resolved`} 且 `includeClosed=false` 且未指定 `productID` | **快路**（`/my/work`） | 一次请求就够，结果与网页逐条一致 |
| `role=edited` | 慢路 | 「地盘」没有「最后修改」这个 tab |
| `includeClosed=true` | 慢路 | `assignedTo` tab 本身不含已关闭，拿不到 |
| `role=any` | 慢路 | 要跨四种身份取并集 |
| 指定 `productID` | 慢路（只拉那一个产品，很快） | 快路没有产品维度 |
| 实例没有 `/my/work`（老版本返回 404） | 自动回落慢路 | 不报错、不返回空，安静降级 |

#### ⚠️ 兜底数据源：全库 Bug 只能「逐产品合并」，不能用全局 `/bugs`

慢路的实现细节，也是**最容易被忽略的一环** —— 踩过一次，代价是「我的待处理 Bug」恒为 0：

| 坑 | 表现 | 处理 |
| --- | --- | --- |
| `GET /bugs` 不带 `productID` | **不是全库列表**，只返回某一个产品（本实例固定在产品 9），而且 `pager.recTotal` 也谎报成该产品的条数（766）。传 `productID=0` / `browseType=all` / `scope=all` 都无效，`productID=all` 直接报错 | 全局范围改为**逐产品遍历 `/products/{id}/bugs` 后合并去重**，见 `src/utils/products.ts` 的 `fetchAllBugs()` |
| `GET /products` 列表 | **漏掉 `shadow=1` 的影子产品**（项目型产品）。本实例就有一个：`2000076 电网储能工程造价分析系统`，34 个产品里没有它，但它下面有 33 条 Bug，**其中 6 条正是指派给当前账号的待处理 Bug** | 用 `/bugs` 响应里的 `products` 字典补齐（它包含影子产品，本实例 35 个 = 34 + 1），两个来源取并集 |

代价是首次调用要遍历所有产品（本实例约 10 秒，服务端渲染大 JSON 本身也慢），
之后 **5 分钟内走缓存**。单产品查询（传了 `productID`）不受影响，仍然只有一次请求。

> 排查这类问题的手法：拿两个数据源各数一遍再对比。
> 当时是「全局 766 条 vs 逐产品 3734 条」，差值直接把 `shadow` 过滤暴露了出来。
> 后来也是靠同一手法（「网页能看到 6 条 vs 工具说 0 条」）才发现 v2 原来有 `/my/work`。

### 通用数据处理参数（每个列表工具都支持）

| 参数 | 作用 | 示例 |
| --- | --- | --- |
| `pick` | 只返回指定字段，省 token | `"id,name,status,assignedTo"` |
| `sort` | 本地排序 | `"id:desc"`、`"deadline:asc"`（也兼容 `id_desc`） |
| `orderBy` | 服务端排序（禅道原生字段名） | `"id_desc"`、`"name_asc"` |
| `filter` | 过滤表达式（Bug 列表） | `"status:active,pri<=2,title~登录"` |

> 禅道对象动辄四五十个字段（一大半是审计字段），用 `pick` 摘取能显著降低 token 消耗。
> 描述类字段（`desc` / `spec` / `steps` 等）里的 HTML 会**自动转成 Markdown**，不必额外处理。

### 枚举值

- **项目状态** `wait` / `doing` / `done` / `suspended` / `closed`
- **执行浏览口径** `all` / `undone` / `wait` / `doing`
- **任务浏览口径** `all` / `unclosed` / `assignedtome` / `myinvolved` / `assignedbyme`
- **任务动作** `start` / `finish` / `close` / `activate`
- **任务状态**（只读，由动作推进）`wait` / `doing` / `done` / `cancel` / `closed`
- **产品状态** `normal` / `closed`
- **Bug 状态** `active` 激活 / `resolved` 已解决 / `closed` 已关闭
- **Bug 浏览口径** `all` / `unresolved` / `assignedtome`
- **Bug 类型** `codeerror` / `config` / `install` / `security` / `performance` / `standard` / `automation` / `designdefect` / `others`
- **Bug 解决方案** `fixed` / `notrepro` / `bydesign` / `duplicate` / `external` / `postponed` / `willnotfix` / `tostory`
- **严重程度 / 优先级** `pri` 1~4（1 最高）；`severity` 1~4（1 最严重）
- **访问控制** `acl` `private` / `open` / `extend`

### 状态必须靠「动作」推进

禅道**没有**直接修改 `status` 字段的接口。状态只能通过动作流转。

**任务**（`zendao_call { module: "task", action: … }`）：

| 动作 | 接口 | 必填参数 |
| --- | --- | --- |
| `start` 启动 | `POST /tasks/{id}/start` | `realStarted`（不填自动取当前时间） |
| `finish` 完成 | `POST /tasks/{id}/finish` | **`currentConsumed`**、`realStarted`、`finishedDate` |
| `close` 关闭 | `POST /tasks/{id}/close` | 无 |
| `activate` 激活 | `POST /tasks/{id}/activate` | 无 |

**Bug**（四个动作；官方定义里动作走 POST，而改 / 删走 PUT/DELETE —— 本实例只有 POST 能到达，见坑 3）：

| 动作 | 通用层写法 | 实际请求 | 必填参数 |
| --- | --- | --- | --- |
| 解决 | `zendao_call { module: "bug", action: "resolve" }` | `POST /bugs/{id}/resolve` | **`resolution`** |
| 关闭 | `zendao_call { module: "bug", action: "close" }` | `POST /bugs/{id}/close` | 无 |
| 激活 | `zendao_call { module: "bug", action: "activate" }` | `POST /bugs/{id}/activate` | 无 |
| 确认 | `zendao_call { module: "bug", action: "confirm" }` | `POST /bugs/{id}/confirm` | `status`（缺省 `active`） |

> ⚠️ 上表四个动作的**请求体必须带 `bugID`** —— 本实例的动作处理器只从 body 读对象 ID，
> 路径里的 ID 会被丢掉。通用层会按 schema 自动带上，手工 `curl` 时别忘了。
> `update`（改字段）与 `delete` 走的是**非动作端点**，本实例上做不了，见坑 3。

时间字段不填会自动补当前时间，并在返回里注明「已自动补全」。

---

## 六、典型坑与实例行为实测

实测踩到的，写在这里省得后面再摔。⚠️ **其中一部分是禅道 REST API 的通性，一部分是具体部署的行为**
（如「`filters` 被忽略」「分页字段谎报」与前置网关、实例配置有关）——
换成别的实例请以 `npm run probe:smoke` 实测出的
[兼容性矩阵](./docs/instance-compatibility-matrix.md) 为准。

### 1. `filters` 参数被完全忽略、`browseType` 只部分生效

**`filters`（服务端过滤）在本实例完全无效** —— 传 status/pri/title 各种条件，
返回值与不传**完全一致**，HTTP 200、`status: success`，既不报错也不提示。
`executions` / `tasks` 的 `browseType` 更是被静默忽略，传 `bogus` 也照样返回全量。

**已处理**：过滤模式一律改为「放大拉取 + 本地过滤 + 本地分页」，
并在输出里注明「已扫描 N 条后本地筛选」。本地过滤是幂等的 ——
服务端哪天支持了，这一步也不会改变结果。

> 补充：Bug 接口的 `browseType` **部分生效** —— 实测只有 `all` 和
> `unresolved` 有语义，而 `closed` / `resolved` 会返回 0 条
> （可库里明明有大量已关闭 Bug）。所以本项目**不暴露这几个会误导的值**，
> 要按状态筛请用 `status` 参数（本地过滤，结果可信）。
> `assignedtome` 同样不认（返回空集），已改为本地按当前账号兜底过滤。

> **但项目接口是例外，它的 `browseType` 真生效。** 实测 `GET /projects`：
> `all`=23、`undone`=17、`doing`=17、`wait`=0、乱传=0，且 `pager.recTotal` 与返回集合一致。
> 反过来，项目的 **`status` 参数被静默忽略** —— 传 `status=doing` 仍返回全部 23 条。
> **一句话记住：项目列表用 `browseType` 筛（服务端），不用 `status` 筛。**
> 走通用层就是 `zendao_call { module: "project", action: "list", params: { browseType: "doing" } }`；
> ⚠️ P1 之后**不再自动补 `browseType`**（旧手写工具默认 `doing`），不传即服务端默认口径。

### 2. 分页字段是 `pager.recTotal` 而不是 `total`，而且**会谎报**

v2 的列表响应统一长这样：

```json
{ "status": "success", "tasks": [...], "pager": { "recTotal": 8, "pageID": 1, "recPerPage": 20, "pageTotal": 1 } }
```

`extractList()` 已统一处理（同时兼容 v1 的 `total`/`limit` 和被网关包一层的形态）。
另外它还做了一件容易被忽略的事：**把「ID 字典」归一化成数组** ——
全局 `GET /bugs` 返回的不是数组而是 `{ "2010438": {...}, "2010439": {...} }`，
不归一化就会在 `products` 字典上把产品列表也当数组用。

⚠️ 但 `recTotal` **不可全信**：全局 `/bugs` 会把某个产品的条数报成「总量」
（本实例报 766，而全库其实有 3767）。别拿它当总数用。

### 3. PUT / DELETE 被掐断，而「方法覆盖」并不能救命 —— 附带两个实锤

**这是写 Bug 工具时踩到的最硬的坑。** 前置 Web 服务器会在 HTTP 层直接拒绝
`PUT` / `DELETE`：连接被 `ECONNRESET` 掐掉，不给任何响应体。
（试过 `PATCH`，能到达应用层但禅道路由不认。）

> ⚠️ **本节早先的结论错了，已修正。**
> 原文说「应用层是好的，用 `POST + X-HTTP-Method-Override: PUT` 就能转发到目标路由」，
> 并拿「返回业务校验失败」当证据。但那只能证明**请求进了动作** ——
> 而 Bug 的动作端点**本来就能用 POST 直接调**，根本不需要覆盖。
>
> 逐项实测：`_method` 放 query、放 body、`X-HTTP-Method-Override` 请求头，
> **三者在实例上全部无效**，请求原样以 `POST` 落到应用层。连 `_method=DELETE` 也一样无效。

所以真规则是这两条：

**① 动作端点认路径，不认方法；且只从 body 里读对象 ID。**
`POST /bugs/{id}/{action}` 直达动作，零覆盖也是通的 —— 代价是**路径里的 ID 会被丢掉**：

```bash
# 通：body 里有 bugID
curl -X POST .../api.php/v2/bugs/2010511/confirm -d '{"bugID":2010511}'
#    → HTTP 200 {"status":"success", ...}
# 不通：body 是空的，路径里的 2010511 被忽略
curl -X POST .../api.php/v2/bugs/2010511/confirm -d '{}'
#    → HTTP 200 {"status":"fail","message":"Bug does not exist."}
```

**② 改 / 删本身没有 POST 版本，硬发会掉进建单路由。** `POST /bugs/{id}`（不带动作）会走进「建单」分支，
报 `Product does not exist.` —— 更重要的是**它可能真的建出一条脏 Bug**。
因此 `update_bug` / `delete_bug` / 两个模块改删工具**刻意不降级成 POST**：
传输层拒绝就如实报错、给出替代方案，宁可不做也不写脏数据。

**已处理**：

- 新增 `requestNative()` —— 走原生 HTTP 方法，**永不降级**。`delete_bug` / `update_bug` /
  两个模块改删工具都改用它，从机制上堵死「掉进建单路由」。
- `update_bug` / `delete_bug` 在传输层拒绝时，`isTransportMethodRejected()` 会把它翻译成
  一句人话（「本实例的 PUT 在 HTTP 层被前置服务器掐断，方法覆盖也无效」）并给出替代路径。
- 客户端保留方法覆盖（由 `ZENTAO_METHOD_OVERRIDE` 控制），但既知它在本实例无效，
  只剩「换到别的实例也许有用」的兼容意义：

| 取值 | 行为 |
| --- | --- |
| `auto`（默认） | 先发真实方法；只在「被传输层拒绝」时改用覆盖重发一次，并把结论缓存下来 |
| `always` | 所有 PUT/DELETE 一律走覆盖 |
| `never` | 永不覆盖（调试原生方法时用） |

判定「被传输层拒绝」只看 **连接被重置 / `socket hang up` / HTTP 405 / 501** ——
刻意收紧，避免把业务报错误判成方法问题。这点很重要：**禅道 2.0 的业务失败往往是
HTTP 200 + `status:"fail"`**，如果按「响应不成功就重试覆盖」来判断，会反复瞎重试。

> 回归测试：`tests/auth/auth-config.test.ts` 里的「PUT/DELETE 方法覆盖」一组（mock 服务端复现
> 「掐断连接」「支持原生方法」「业务报错」三种行为）；而「`update` / `delete` 不降级成 POST」
> 这条由通用层（官方 SDK）保证 —— 它直发定义的方法，不做任何覆盖。
>
> **一句话记住：动作走 `POST /bugs/{id}/{action}` + body 带 `bugID`；改 / 删本身在本实例做不了，去网页上做。**

### 4. 没有任何一个接口能一次拿到「全库 Bug」

这条最隐蔽 —— 它不让工具报错，只是**让数据凭空少掉一大半**。

> 注意区分：**「全库 Bug」确实没有一次性的接口**，但**「我的 Bug」有** ——
> 就是 `GET /api.php/v2/my/work?mode=bug&type=assignedTo`（见第五节）。
> 所以查「我待处理的 Bug」是 1 次请求，查「所有人的 Bug」才需要逐产品遍历。

| 坑 | 实测表现 |
| --- | --- |
| `GET /bugs` 不带 `productID` | **只返回某一个产品**（本实例固定产品 9）的 Bug，而 `pager.recTotal` 也谎报成该产品的条数。传 `productID=0` / `browseType=all` / `scope=all` 都无效，`productID=all` 直接报错 |
| `GET /products` 列表 | **硬过滤掉 `shadow=1` 的影子产品**（禅道为项目自动生成的「项目型产品」） |

两者叠加的后果：本实例全库有 **3767** 条 Bug（35 个产品），而全局 `/bugs` 只给 **766** 条
（一个产品），`/products` 又漏掉 `2000076 电网储能工程造价分析系统`——**恰好就是
当前账号那 6 条待处理 Bug 所在的产品**。也就是说：工具曾经回一个干干净净的「0 条」。

**已处理**：新增 `src/utils/products.ts`：

- `fetchBugScopeProducts()` —— 产品清单取「`/products` 列表 ∪ `/bugs` 响应的 `products` 字典」
  的并集（后者含影子产品，本实例 35 个 = 34 + 1）
- `fetchAllBugs()` —— 逐产品遍历 `/products/{id}/bugs` 后按 id 去重合并；
  并发 12，缓存 5 分钟；部分产品拉取失败会记入 `failedProducts` 并在文案里提示

单产品查询不受影响（仍是一次请求）。全局范围首次约 10 秒 —— 慢主要在服务端渲染
（单产品 766 条就要 3.8 秒），客户端并发已开到 12（实测 396ms/请求 vs 串行 1058ms）。

> 排查手法值得记一笔：**换第二个数据源再数一遍**。
> 当时是「全局 766 vs 逐产品 3734」，差值直接把 `shadow` 过滤暴露了；
> 再逐个产品比对集合，就定位到了那个 `shadow=1` 的产品。

### 5. 动作表单纯「整体替换」，少传一个字段就是清空它

这是本轮补 `confirm` 时才真正踩明白的：**Bug 的动作端点不是 `PATCH` 语义**。
它拿整张表单**覆盖整条记录** —— 你没提交的字段会被当成「置空」。

实测代价：给 Bug `2010511` 做 `confirm` 时只传了 `{bugID, status:"active"}`，
结果 `type` 从 `codeerror` 被清成了空串、`assignedTo` 也被抹掉了（后来用工具重新补回）。

**已处理**：通用层（`zendao_call` 的 `update`）由官方 SDK 的 `autoFillUpdateParams()` 兜这一层 ——
**先 GET 当前对象 → 用现值补齐未显式传入的字段 → 再提交**。
思路与 P1 之前手写的 `buildActionBody()` 完全一致，都是为了防「PUT 整体替换清空字段」。

> 回归测试：`npm run verify:live` 的 61 条用例里，一条专门断言「单对象动作会忽略 `filter`」，
> 其余对每个工具的 `structuredContent` 顶层键与声明的 `outputSchema` 做 **ajv 校验**
> （手写 `verify` 探针不做这层校验，得靠它拦）。

---

## 七、验证接入是否成功

### 方式 1：跑内置探针（最推荐）

```bash
npm run verify
```

它以 MCP 客户端的身份走完整 JSON-RPC 流程：`initialize` → `tools/list` → 真实调用
`zendao_modules`，并检查 stdout 洁净度。**连的是真实禅道、走的是真实协议。**

### 方式 2：跑服务

```bash
npm run start
```

看到这几行说明服务本身没问题（**日志走 stderr，stdout 是 JSON-RPC 专用通道**）：

```
[INFO] 配置加载完成: http://zen.example.com/zentaomax（REST API v2）
[INFO] 连接验证成功
[INFO] 所有工具注册完成
[INFO] MCP 服务器已启动，等待连接...
```

### 方式 3：MCP Inspector（图形界面）

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

浏览器里可以逐个工具点着试。注意 Inspector 也是从**项目根**启动才读得到 `.env`。

### 方式 4：在客户端里直接问

对 AI 说「列出禅道前 5 个项目」，它应该通过通用层（`zendao_call { module: "project", action: "list" }`）
或 `zendao_list_bugs` 这类手写工具返回真实数据。
再问「项目 21 下有哪些执行」「执行 43 里有哪些任务」，验证整条链路。

---

## 八、常见问题

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 启动即报「缺少禅道认证信息」 | `.env` 不存在或没填，且本机也没有官方 CLI 登录态 | 确认项目根 `.env` 里有 `ZENTAO_ACCOUNT` / `ZENTAO_PASSWORD`，或先跑一次 `zentao login` |
| 报「ZENTAO_ACCOUNT 与 ZENTAO_PASSWORD 必须成对配置」 | 只填了一个 | 补全另一个 |
| 报「官方 CLI 的配置文件…**用不了**」 | store 路径指错 / JSON 损坏 / 缺 `profiles` 数组 | 不配 `ZENTAO_CONFIG_FILE` 走默认路径，或改用 `.env` 的账号密码；报错里会带上实际路径 |
| 报「…**无法确定用哪条** profile」 | store 里有多条且官方 CLI 没记 `currentProfile` | 用 `ZENTAO_PROFILE=<账号>` 指定（报错里会列出可选项） |
| `401 Unauthorized` | 账号密码错 / 账号无 REST 权限 | 用 `curl` 打 `POST /api.php/v2/users/login` 验证 |
| 报「API 请求失败」且响应是 HTML | `ZENTAO_BASE_URL` 带了 `/index.php` | 改成站点根地址 `http://host/zentaomax` |
| 接口 404 | API 版本不匹配或路径写错 | 确认 `ZENTAO_API_VERSION`（默认 v2）；提示信息里会带出版本与路径 |
| `spawn node ENOENT` | 客户端拿不到 `PATH` | `command` 改绝对路径 `C:\nvm4w\nodejs\node.exe` |
| 客户端里看不到工具 | 未信任 / 未重启 / 键名写错 | WorkBuddy 点「信任」；VS Code 键名是 `servers` |
| Codex 里原有服务器的配置坏了 | `[mcp_servers.zentao-cli]` 被插到了别的表中间 | 移到文件末尾，用 `python -c "import tomllib;tomllib.load(open(...,'rb'))"` 验证 |
| 客户端报 JSON 解析错误 | stdout 被日志污染 | 本项目日志已全部走 stderr；若出现说明有人把日志改回了 `console.log` |
| 提示「缺 executionID」 | 任务的归属方没给 | 先 `zendao_call { module: "execution", action: "list" }`（可按 `projectID` 过滤）拿 id |
| 任务查询返回空但明明有数据 | 服务端口径 / 本地兜底过滤生效 | 显式带上 `browseType`，或去掉过滤条件再试 |
| `task finish` 报缺 `currentConsumed` | 禅道要求必填 | 传入本次消耗工时，如 `currentConsumed: 4` |
| Bug 列表传 `browseType: closed` 返回 0 条 | 本实例这几个值没有语义 | 改用 `status: "closed"`（本地过滤） |
| Bug 创建报缺 `openedBuild` | 官方定义里它是必填 | 传 `["trunk"]` 或真实版本 ID（版本走 `build/list`，见第五节） |
| Bug 解决报「『解决方案』不能为空」 | 官方定义里 `resolution` 必填 | 传 `resolution: "fixed"` 之类的枚举值 |
| 写操作报 `ECONNRESET` / `socket hang up` | 前置 Web 服务器掐断了 PUT/DELETE | ⚠️ 方法覆盖在本实例**无效**，别指望降级能救（见第六节坑 3）。`update` / `delete` / 模块改删请去禅道网页操作；`resolve` / `close` / `activate` / `confirm` 走的是 POST，不受影响 |
| 写操作报「Bug does not exist」 | Bug ID 不存在，**或动作请求体里漏了对象 ID** | 本实例的动作处理器只认 body 里的对象 ID（路径 ID 会被丢掉）。禅道对不存在的 ID 也**不返回 404**，而是 200 + `status:"fail"`；通用层会按 schema 自动带上 |
| `bug confirm` 报「『Bug状态』不符合格式」 | `status` 只接受 `active` / `resolved` / `closed` | 传枚举内的值，如 `{ bugID, status: "active" }` |
| `bug modules` 报「端点不存在」 | 本实例没这个端点 | `GET /products/{id}/bug/modules` 需禅道 22.5+ / biz13.5+ / max8.5+ / ipd5.5+；Bug 的分类 ID 可以从 `zendao_get_bug` 的 `module` 字段读到 |
| 直接 `GET /bugs/{id}` 却 404 | 走的是全局路径 | 用 `zendao_get_bug` 或 `zendao_call { module: "bug", action: "get" }`；列表走 `/{scope}/{scopeID}/bugs` 或全局 `/bugs` |
| 工具名不存在（如 `zendao_create_bug`） | P1 已把 24 个「一工具一动作」封装收敛掉 | 改用通用层：`zendao_call { module: "bug", action: "create", … }` —— 见第五节对照表 |

---

## 九、安全须知

- **`.env` 在 `.gitignore` 里**（`.env` / `.env.*` 都被忽略，只放行 `.env.example`），不要手动提交。
- 项目历史上曾有 `fetch-token.sh` **明文硬编码真实账号密码**，位于仓库根目录。
  该文件**已删除**；但如果这个仓库曾经 push 过，凭据应当视为已外泄，**建议改密码**。
- 排查问题时不要直接把 `.env` 内容或 Token 明文贴到聊天/工单里。
- 需要人工验证认证链路时，用第二节那两条 `curl`，别把密码写进命令行历史。

---

## 十、相关文档

| 文档 | 说明 |
| --- | --- |
| `README.md` | 项目总览、开发与构建 |
| `MCP_TESTING_GUIDE.md` | 验证与测试指南（含两条验收命令的区别） |
| `tests/README.md` | 测试套件清单（13 套件 / 253 用例，标明哪些连真机） |
| `docs/official-module-parity.md` | 官方 26 模块 × 229 动作完整对照表（**判断「能不能做」看这份**） |
| `docs/porting-candidates.md` | 移植决策与实施进度（**判断「下一步做什么」看这份**） |
| `docs/instance-compatibility-matrix.md` | **本实例兼容性矩阵**：90 个只读动作逐个实测结论（自动生成，`npm run probe:smoke`） |
| `docs/vs-official-zentao-cli.md` | 与官方 CLI 的能力差异总述（要不要换官方） |
| `.env.example` | 环境变量模板（含全部可用变量） |
| `example-config.json` | 客户端配置示例 |
| `scripts/verify-mcp.js` | 内置 MCP 握手与工具调用探针 |

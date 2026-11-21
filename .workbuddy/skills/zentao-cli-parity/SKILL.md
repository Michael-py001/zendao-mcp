---
name: zentao-cli-parity
description: 对比评估官方 zentao-cli 与本项目 zendao-mcp 的能力差异，并探测「官方 CLI 与本实例 REST 端点各自给哪些能力」。当用户提到「官方 CLI 和这个项目有什么区别」「要不要换成官方 CLI」「这个项目还有必要维护吗」「还该把哪些官方功能移植过来」「下一步加什么功能」「做个模块对比 / 对照表」「官方有哪些模块」「禅道升级后重新评估」「测试用例 / 测试单 / 执行用例 / 跑用例能不能做」「通用层 / zendao_call / zendao_modules / zendao_help」「把官方全部动作迁移过来」「依赖 zentao-api / 官方 SDK」「zentao-api 装不上 / ESM 与 CJS 互操作 / tsconfig 要改 node16 吗」「对标 / 对比官方 zentao-cli」，或需要排查禅道实例的版本门槛（E2010 / E_UNSUPPORTED_ZENTAO_VERSION）、确认 PUT/DELETE 是否被传输层掐断、盘点本项目 MCP 工具清单、查询某个 REST 端点在本实例存不存在、确认 /my/work 支持哪些 mode、给本项目新增或修改 MCP 工具后需要真机验收 outputSchema 时，使用本技能。
agent_created: true
---

# 官方 zentao-cli 对标评估

用**真机实测**判断「官方 CLI 能不能替代本项目」，而不是读文档猜。

**核心认知**：两者的差异不由功能列表决定，而由**目标禅道实例**决定 ——
实例版本（如 `MAX8.2`）与前置服务器的传输层行为，会把官方 CLI 的一大片能力直接锁死。

---

## 快速开始

三条命令，把「官方能做什么 / 项目现在有什么 / 这台实例给哪些路」全测出来：

```bash
# 1) 官方 CLI 侧：版本、模块、版本门槛、只读连通性（全只读）
node .workbuddy/skills/zentao-cli-parity/scripts/probe-official-cli.mjs

# 2) 本项目侧：MCP 工具清单（需先构建）
npm run build
node .workbuddy/skills/zentao-cli-parity/scripts/probe-mcp-tools.mjs

# 3) 实例侧：REST 端点可达性矩阵（决定「哪些官方功能移植得过来」）
node .workbuddy/skills/zentao-cli-parity/scripts/probe-endpoints.mjs

# 4) 验收侧：改了工具 / outputSchema 之后，用真客户端调一遍（**改完必跑**）
npm run build
node .workbuddy/skills/zentao-cli-parity/scripts/verify-tools-live.mjs

# 5) 官方侧：提取「26 模块 / 229 动作」与版本门槛（线 A + 线 B）
#    ⭐ 推荐 SDK 内省模式 —— 直读 `zentao-api` 注册表，**不需要 clone 官方仓库**
node .workbuddy/skills/zentao-cli-parity/scripts/extract-official-modules.mjs --sdk \
  --out=.workbuddy/tmp/official-modules-sdk.json
#    （md 模式仍保留，位置参数传官方仓库的 command-reference.md，用于交叉验证）

# 6) 专项：`/my/work` 的 mode 全取值扫描 + 数据区分度验证
node .workbuddy/skills/zentao-cli-parity/scripts/probe-my-work-modes.mjs

# 7) 全量：把注册表里**每一个只读动作**都打一遍 → 本实例兼容性矩阵（只读；结果见 docs/instance-compatibility-matrix.md）
npm run build
node .workbuddy/skills/zentao-cli-parity/scripts/probe-smoke-matrix.mjs
```

也可以直接用 npm script：

```bash
npm run probe:cli              # 官方 CLI 在目标实例上的能力边界
npm run probe:tools            # 本项目当前暴露的 MCP 工具
npm run probe:endpoints        # 目标实例的 REST 端点可达性矩阵
npm run probe:official-modules # 官方模块 × 动作 × 版本门槛（md 模式，需先 clone 官方仓库）
npm run probe:modules-sdk      # 同上但走 SDK 内省（**推荐**，不需要官方仓库）
npm run probe:my-work          # /my/work 的 mode 支持性与数据区分度
npm run probe:smoke            # 全量只读动作冒烟扫描 → 本实例兼容性矩阵
npm run verify:live            # 真机验收：工具调用 + outputSchema 校验（改完代码必跑）
```

> 想回答「**该往本项目里加什么功能**」这个问题时，看的是脚本 3 —— 官方有没有不重要，
> **这台实例的 REST 端点给不给**才重要。
>
> ⚠️ 但注意脚本 1 的口径：它测的是「**官方 CLI** 在本实例上能跑哪些动作」（含官方自己的版本门槛）。
> 本项目走 REST 直连，**不受官方门槛约束** —— 两者常有错位，完整对照见
> `docs/official-module-parity.md`。

---

## 脚本 1：`probe-official-cli.mjs`

探测官方 CLI 的**能力边界**。全程只读，不会写禅道数据。

### 它做什么

1. 取官方 CLI 版本 + 服务器版本（`zentao version`）
2. 抓各模块 `--help`，解析出「操作 + 最低版本门槛」四元组
   （`22.0 / biz13.0 / max8.0 / ipd5.0`），**按服务器所属系列自动判定通过还是拒绝**
3. 跑几条只读列表查询验证连通性
4. 汇总「被版本拒绝」与「版本通过但会被传输层掐断」两组操作

### 参数

| 参数 | 说明 |
| --- | --- |
| `--modules=bug,task,story` | 要分析的模块（默认 `bug,task,story,my,file,todo`） |
| `--modules=ALL` | 分析全部 26 个业务模块（慢，约 26 次 `--help`） |
| `--out=<path>` | 报告写入文件（相对项目根）；不传则输出到 stdout |
| `--json=<path>` | 结构化结果写入文件（含 `blocked` / `allowed` / `actions`） |
| `--sample-product=<id>` | 指定样本产品验证「已知范围」能查到（如用影子产品 `2000076`） |
| `--cli="npx -y zentao-cli@0.3.0"` | 指定 CLI 调用方式（默认自动探测本机 `zentao`，没有就回落 npx） |
| `--quiet` | 不输出进度 |

### 怎么读报告

报告第 3 节的表格有三态：

| 标记 | 含义 | 处置 |
| --- | --- | --- |
| `通过` | 版本门槛满足 | 还需看有没有传输层警告 |
| `**版本拒绝**` | 官方 CLI 主动报 `E2010` | 这个实例上**根本用不了** |
| `⚠️ 走 PUT/DELETE，本实例会被传输层掐断` | 版本通过，但发出去会被前置服务器 `ECONNRESET` | 结果同「不可用」 |

**「版本通过」不等于「能用」** —— 必须同时看传输层警告。

---

## 脚本 2：`probe-mcp-tools.mjs`

用宿主同款 SDK（`Client` + `StdioClientTransport`）起真客户端连 `dist/index.js`，
走完整 MCP 握手后列 `tools/list`。

比 `scripts/verify-mcp.js` 更接近真实客户端 —— 后者是手写 JSON-RPC，不做 ajv 校验。

| 参数 | 说明 |
| --- | --- |
| `--out=<path>` / `--json=<path>` | 输出到文件 |
| `--call=zendao_modules` | 顺带调一次只读工具验证连通性 |

> ⚠️ 改过 `src/` 之后必须先 `npm run build`，否则测的是旧 `dist`。
> （这条踩过：`src/` 已把环境变量从 `ZENDTAO_*` 改名成 `ZENTAO_*`，但 `dist/` 没重编译，
> 于是探针加载的仍是旧拼写、连 Token 都换不到。）

---

## 脚本 3：`probe-endpoints.mjs`

探测**目标实例的 REST 端点可达性**，用来判断「某个官方功能值不值得移植进本项目」。

### 为什么需要它

官方 CLI/SDK 的 26 个模块按「禅道标准版能力」定义，但一个具体实例能不能用，取决于两张网：

1. 前置 Web 服务器（会不会掐断 PUT/DELETE）；
2. 禅道版本门槛（官方 CLI 用 `E2010` 把关，本项目只能靠实测）。

所以「官方有这个功能」≠「这个实例给这条路」。

### ⭐ 判定口径（关键，别用 `status < 400` 那套）

禅道对**不存在的对象**返回的是 HTTP 200 + `{status:'fail'}`，**不是** 404；
只有**路由本身不存在**才给 404。所以：

| HTTP | 含义 | 记作 |
| --- | --- | --- |
| 404 | 路由不存在 | ❌ 该功能在本实例没路 |
| 200 + `success` | 路由存在且有数据 | ✅ 可用 |
| 200 + `fail` | 路由存在，只是当前参数没有对应对象 | ✅ **仍然算可用** |
| 200 + **HTML** | 「伪 200」：请求被回落到前端路由、返回登录页 | ❌ **实为无此路由**（只看状态码会被骗） |

把 `fail` 当失败会让「需求详情」「任务详情」这类端点被误判为不存在。
反过来，把「伪 200」当成功会把不存在的路由当成可用 —— `/testresults`、`/testruns` 就是这么骗人的（2026-09-18 踩到）。

### 参数

| 参数 | 说明 |
| --- | --- |
| `--out=<path>` / `--json=<path>` | 报告 / 结构化结果写入文件 |
| `--group=my,build,story` | 只探指定分组（分组名见报告标题） |
| `--product=2000076` `--project=2000546` `--execution=92` | 指定取样 ID；不传则自动取列表第一项 |
| `--concurrency=5` | 并发数（默认 5） |

### 怎么用它的结论

报告末尾的「**预期与实测不一致的点**」是最有价值的部分 —— 那里暴露的是
**「看着应该有、实际没有」**或反过来的端点，也就是最容易踩空的假设。

### 踩坑记录

- **别用 `probeEndpoint()` 那种 `status < 400` 的判定**：禅道对不存在的对象返回 200，
  会把「没这个路由」误判成「有」，结论全反。
- **「伪 200」要单独识别**：路由不存在时前置服务器会回落到前端路由，返回 **200 + 登录页 HTML**。
  它不是 404，只看状态码会当成「有路由」。脚本里按错误信息里的
  `不是 JSON` / `登录页` / `text/html` 判定（2026-09-18 踩到：`/testresults`、`/testruns` 一开始全被判成了 exists）。
- **偶发 403 不是权限问题**：探 `/testcases/{id}/run` 时曾蹦出一次 403 `Not allowed（权限不足）`，
  看着像「路由存在但没权限」。连测 16 次（8 串行 + 8 并发）**全 404** → 那是**一次性伪影**
  （同账号并发下 token 重登窗口的老毛病）。别顺着 403 去追「申请权限」，先重测确认稳定性。
- **要静音 client 的 logger**：探针故意打一批 404，默认 logger 会连堆栈一起刷屏，
  把报告淹掉。脚本里传了个鸭子类型的静默 logger。
- **`.env` 要自己读一遍**：`dist/config.js` 里的 dotenv 按 `__dirname/../.env` 找，
  从 skill 脚本里跑未必命中；自己读完再 import 项目模块最稳（顺便把目标主机加进 `NO_PROXY`）。
- **只读探测写路由用「空 body + 不存在的 ID」**：想判断 `POST /xxx` 路由是否存在，
  一律传 `{}` 和幽灵 ID（如 `99999999`），靠「必填校验失败 / 父对象不存在」反推路由在不在，
  绝不会造脏数据。探完务必复核总数没变（本次用例 180 / 测试单 188 前后一致）。

---

## 脚本 4：`verify-tools-live.mjs`

**改完工具或 `outputSchema` 之后的强制验收环节。** 只读，不写禅道数据。

### 为什么非要有它

这是本项目一条踩出来的铁律：

> `npm run verify`（`scripts/verify-mcp.js`）**手写 JSON-RPC、不做 ajv 校验**，
> 而 MCP 客户端会拿 `outputSchema` 校验 `structuredContent`。
> 于是「工具声明了 outputSchema，但返回的顶层键对不上」这类 bug，
> 在 `npm run verify` 那里**永远是绿的**，一到真客户端就 `InvalidParams`。
> （`get_project` / `get_execution` / `get_product` / `get_bug` 都栽过。）

### 它做三件事

1. 走完整 MCP 握手，列 `tools/list`，逐个打印 `outputSchema` 的字段并检查**有没有漏声明**；
2. 跑一组**只读冒烟用例**（默认 **61** 个：通用层与 8 个手写工具的回归 + 18 个新增只读用例 +
   若干「故意触发错误分支」的用例，全部指向真实实例但**零写操作**）；
3. 把 **协议级错误**（`-32602`，schema / 参数校验）与 **业务级错误**（工具返回 `isError`）**分开报告**
   —— 前者是 bug，后者往往是预期行为。

### 参数

| 参数 | 说明 |
| --- | --- |
| `--out=<path>` / `--json=<path>` | 报告写入文件（相对项目根） |
| `--list` | 只列工具与 schema，不做调用 |
| `--call=zendao_get_task:{"taskId":2012808}` | 补一个自定义调用（可重复） |
| `--no-smoke` | 不跑默认用例，只跑 `--call` |
| `--quiet` | 不往 stderr 输出进度 |

### 怎么读结果

| 报告里的现象 | 含义 |
| --- | --- |
| `✅ 符合预期` | 返回了 `isError` 与预期一致 |
| `✅ 入参被拒（预期）` | 故意传非法枚举 / 缺必填，zod 正确拦下 |
| `❌ 协议级错误` | **schema 与返回不一致** —— 检查该工具的 `outputSchema` 是否漏声明了实际返回的顶层键 |
| `❌ 与预期不符` | 业务行为变了（或默认用例里的对象 ID 已被删除，属「数据过期」） |

⚠️ 默认用例里的对象 ID（项目 `2000546`、影子产品 `2000076`、执行 `2000547`、若干 Bug/任务 ID）
取自本实例的真实数据。它们被删除后用例会变成「业务级错误」，此时换个 ID 重跑即可，不是脚本坏了。

---

## 脚本 5：`extract-official-modules.mjs`

提取「26 模块 / 229 个业务动作 + 每个动作的最低版本」，产出对比文档的「线 A + 线 B」。
**两种数据源**，同一份输出结构（`schemaVersion: 2`）。

### 两种模式（P2-17 升级：新加 SDK 内省）

| 模式 | 命令 | 数据源 | 要 clone 官方仓库？ | 额外字段 |
| --- | --- | --- | --- | --- |
| **`sdk`（推荐）** | `npm run probe:modules-sdk` | **`zentao-api` 的注册表**（`exportRegistry()`） | ❌ **不需要** | ✅ `method` / `path` / `type` |
| `md`（保留做交叉验证） | `npm run probe:official-modules -- <md> [out.json]` | 官方仓库 `docs/command-reference.md` | ✅ 需要 | 源码行号 `line` |

**为什么 `sdk` 模式是升级**：

1. **不需要 clone 官方仓库** —— 定义直接来自 npm 依赖 `zentao-api`，开箱即用。
2. **与运行时同一份注册表** —— 含 SDK 内置的 `override.js` 补丁，正是工具层看得到的定义，
   不会因官方文档改写而漂移。
3. **信息更全** —— 带 `method` / `path` / `type`，**markdown 里根本没有这三样**。

`md` 模式**不删**：两条独立路径都给 `26 / 229` + `106 / 123`，结论才敢信。

> ⚠️ 官方仓库**不需要 `npm install`** —— CLI 已不维护本地模块注册表，
> 模块定义来自外部 `zentao-api` SDK，`node_modules` 不存在也照样能解析这份 md。

### 参数

| 参数 | 说明 |
| --- | --- |
| `--sdk` | **SDK 内省模式**（不给任何位置参数时也是默认模式） |
| `--md` / `--from=md\|sdk` | 显式指定模式 |
| `<command-reference.md>` | `md` 模式的位置参数（给定它即进入 md 模式） |
| `[out.json]` / `--out=<file>` | 输出 JSON（省略则打到 stdout） |
| `--compare=<other.json>` | **交叉验证**：与另一份结果逐模块 / 逐动作比对（只比双方都有的字段），有差异时退出码 **2** |

```bash
# 推荐：SDK 内省，不需要官方仓库
npm run probe:modules-sdk -- --out=.workbuddy/tmp/official-modules-sdk.json

# 交叉验证：md 模式与 sdk 模式比对（需自行提供命令参考文件）
npm run probe:official-modules -- \
  <命令参考文件.md> \
  .workbuddy/tmp/official-modules-md.json \
  --compare=.workbuddy/tmp/official-modules-sdk.json
```

### 前置（仅 `md` 模式需要）

自行准备一份命令参考文件，其余模式不需要任何额外仓库。

### 怎么读结果

两个模式都输出 `modules=26 actions=229` + `max8.0(本实例可过)=106 max8.5(被拒)=123 其他=0`。

- **2026-09-20 交叉验证**：`md` vs `sdk` → 模块数 26 vs 26、动作数 229 vs 229、
  **逐动作版本门槛完全一致**、门槛统计同为 `106 / 123 / 0` ⇒ 两条独立路径互证。
- 与**脚本 1** 的「123 个被门槛拒绝」**精确吻合** —— 第三条独立路径。
- ⚠️ 两个数字口径不同，别混：`229` 是注册表里的**业务动作**数；
  脚本 1 报的 `255` 是 CLI 实际注册的**可执行动作**数（含 `props` / 帮助等非业务项）。
- 阈值以 **`max` 产品线**为准（本项目目标实例是 MAX8.2）。
- 版本字典键：`open`（开源版，即裸 `22.0`）/ `biz` / `max` / `ipd`。
  ⚠️ 旧版只捕到后三条，`open` 是 **P2-17 顺带修好的**（md 正则原先漏掉无字母前缀的那条）。
- `gate.noMaxLine > 0` 表示有动作**没声明 `max` 线**（＝该产品线不支持），不是解析失败。

---

## 脚本 6：`probe-my-work-modes.mjs`

`/my/work` 的 **mode 全取值扫描 + 数据区分度验证**。

### 为什么需要它

官方 `my` 模块 14 个动作**全部被 max8.5 门槛拒绝**，看起来整块死掉。
但 `/my/work` 是「一个接口 N 种资源」的设计 —— `mode` 换一个值就换一种资源。
实测 **13 / 14 个 mode 受支持**（只有 `project` 是伪 200），
意味着官方给不了的 9 个「我的 X」，本项目**可以零成本补上**。

### ⭐ 它验证的第二件事（最关键）

`epic` / `requirement` 返回的键**都叫 `stories`**，`testtask` 返回 `tasks` ——
很像服务端没过滤、退化成同一份数据。脚本用 **ID 集合交集**来钉死这件事：

| 对比 | 实测结果 |
| --- | --- |
| `story`(100条, ID 2002972 段) vs `epic`(43条, ID 1309) vs `requirement`(28条, ID 1508) | **交集 0 条** → 三张独立实体表 |
| `task`(17条, ID 11195) vs `testtask`(11条, ID 263) | **交集 0 条** → 独立 |

### ⚠️ 判定口径：`支持` 看的是**列表键存在**，不是**条数 > 0**

「条数为 0」有两种含义，混了就会得出错误结论：

| 现象 | 含义 |
| --- | --- |
| 返回**伪 200**（登录页 HTML）或报错 | mode **不支持** |
| 返回了**正确的列表键**但为空 | mode **支持**，只是**本账号无数据** |

这是本项目记过的「假阴性」坑 —— 结果为 0 时必须能区分这两者。

### 参数

| 参数 | 说明 |
| --- | --- |
| `--out=<file>` | 报告输出路径（默认 `.workbuddy/tmp/my-work-modes.md`） |
| `--product=<id>` / `--execution=<id>` | 可选，用于第四部分「详情路由复核」取样 |

```bash
npm run probe:my-work -- --product=7 --execution=71
```

全部为**只读 GET**。

---

## 脚本 7：`probe-smoke-matrix.mjs`

**全量只读动作冒烟扫描** —— 把 SDK 注册表里**每一个 `method=get` 的动作**都打一遍，
产出「本实例兼容性矩阵」（P2-19）。

### 为什么需要它

`verify:live` 的 61 个用例是**手工挑**的，覆盖不了注册表里 90 个只读动作。
「229 个动作里本实例到底哪些真能用」这个问题，之前只能靠**抽样推断**。
本探针把它变成**穷举实测**：一张表列清每个动作的结论，不猜。

### 两条设计原则（改动时别破）

1. **只跑 `method === 'get'`** —— 写动作（POST/PUT/DELETE）一个都不碰。
   这是它能安全对**真实实例**跑的前提，所以能当日常命令用。
2. **不硬编码端点清单** —— 模块名 / 动作名 / 路径模板 / 参数**全部从 SDK 注册表现读**，
   官方注册表升级后本脚本无需跟着改；再用「**先跑无参动作收种子 ID → 再跑带参动作**」的
   **多轮瀑布**自动补全 path 参数。每轮**重扫全部**目标动作（不只本轮新增），
   让「上一轮还拿不到 ID、这一轮因为父资源出了数据而变得可解」的动作有机会翻盘。

### 结论口径（⚠️ 别把前两类当缺陷）

| 结论 | 含义 |
| --- | --- |
| ✅ 可用 | 接口真的通（有数据） |
| ✅ 可用（空） | 接口**通**，只是这一页没数据 —— 空 ≠ 坏 |
| 🚫 门槛拒绝 | `minVersion` 不过（如 `max8.5` 才有的动作）—— **不是缺陷**，换满足版本的实例就能用 |
| ❌ 路由不存在 | 404，两条路都没有（真没有） |
| ⚠️ 参数不可解 | 本探针自动装配不出 ID（通常**父资源列表为空**，拿不到种子）。给个 ID 再验即可，不一定是接口问题 |
| ❌ 其他错误 | 非 404、非门槛的异常 —— **这一类才需要盯** |

⚠️ 前几轮踩过的**假阴性**坑（已修，写下来防复现）：
「种子只取第一个 ID」会让某产品的子资源全空而误判「参数不可解」；`countOf` 对空集合返回 1
会造成「假绿」；path 参数名（`planID`/`caseID`）与模块名不同要靠**路径段**兜底；
复合 ID `case_74` 原样当路径参数直接 404，必须剥前缀。

### 参数

| 参数 | 说明 |
| --- | --- |
| `--out=<path>` | 报告写入文件（相对项目根）；不传则写 `.workbuddy/tmp/smoke-matrix.md` |
| `--json=<path>` | 额外落一份结构化 JSON（供 P2-17 消费） |
| `--only=bug,task` | 只看某几个模块（默认全量） |
| `--concurrency=<n>` | 并发（**上限 5**，默认 4）—— 同账号并发实测安全线 ≤5，别往上加 |
| `--max-rounds=<n>` | 瀑布最大轮次（默认 5） |
| `--rec-per-page=<n>` | 每页取多少条（默认 5，只为验证接口通不通，不代表总量） |

```bash
npm run probe:smoke
npm run probe:smoke -- --only=bug,task --concurrency=3
```

### 本实例（MAX8.2）实测结果 —— 90 个只读动作

| 结论 | 数量 |
| --- | --- |
| ✅ 可用 | **19** |
| ✅ 可用（空） | 6 |
| 🚫 门槛拒绝 | 59 |
| ❌ 路由不存在 | 3 |
| ⚠️ 参数不可解 | 3 |
| ❌ 其他错误 | 0 |

👉 **「真正能打」的 19 + 6 = 25 个**是明确结论；59 个门槛拒绝属**预期**（换 max8.5+ 实例即解锁）；
3 个 404（`user/list`、`user/get` 系、`program/get`）与 3 个参数不可解（父资源为空）是**在本实例上确定的缺口**。
完整明细见 **`docs/instance-compatibility-matrix.md`**（自动生成，别手改）。

---


| 事实 | 值 |
| --- | --- |
| 服务器 | **MAX8.2（旗舰版）** @ `zen.example.com/zentaomax` |
| 官方 CLI | v0.3.0，26 个业务模块，**229 个业务动作**（CLI 实际注册 255 个可执行动作，差额是 `props`/帮助等非业务项 —— 两个口径别混） |
| 官方动作在该实例的可用性 | **229 个里 106 可过 / 123 被 max8.5 门槛拒绝**（两条独立路径交叉验证） |
| 本项目 | **12 个 MCP 工具**（通用层 3 + 手写兜底 9）。演进：09-17 补 P0 移植候选 **26 → 32**；09-18 通用层 **32 → 35**；09-20 P1 收敛 **35 → 11**（删掉 24 个「一工具一动作」封装，能力由通用层承接，无回退）；10-09 补 `/my/effort`（工时日志）**11 → 12** |
| ⭐ 通用层能力上限 | `zendao_modules` / `zendao_help` / `zendao_call` 由**官方注册表驱动**，同一份构建随实例版本自适应：本实例 max8.2 → **106** 个动作，max8.5+ → **229** 个 |
| 本实例 REST 端点 | 62 个探测点里 **37 个有路由 / 25 个 404**（2026-09-18 把「测试」分组从 3 点扩到 19 点） |
| 本实例**全量只读动作**（脚本 7，2026-09-20） | 90 个 `get` 动作里 **25 个真能打**（19 有数据 + 6 空）／59 门槛拒绝／3 路由不存在／3 参数不可解 → `docs/instance-compatibility-matrix.md` |
| 被版本拒绝（max8.5 门槛） | **整个 `my` 模块**（14 / 14）、`bug confirm`、各模块 `modules/updateModule/deleteModule`、`todo` 全部、`file update`、`story getGrades` |
| ⚠️ **门槛 ≠ REST 可用性** | 以上是**官方 CLI 层**的拒绝。本项目走 REST 直连，**不受此约束**：`bug confirm`（POST `/bugs/{id}/confirm` ✅ 有路）、`my` 的 9 个 mode、`issue`/`risk`/`meeting` 列表、`execution/projectExecutions`、`execution/team` 实测**全有路** |
| 门槛吃最狠的模块 | `doc` 41/42 · `my` 14/15 · `project` 8/13 · `meeting` 8/9 |
| 完全不受门槛影响的模块 | `user` · `program` · `productplan` · `build` · `testtask` · `release` · `system` · `epic` · `requirement` |
| 传输层掐断 | `bug update` / `bug delete` / `file delete`（及所有走 PUT/DELETE 的操作） |

**本项目不可替代的四条**：Bug 截图附件下载 · 跨产品全库 Bug（含影子产品）· 我的 Bug 快路 ·
**我的任务 / 我的需求 / 我的待办**（官方被 max8.5 门槛挡死）。

**曾经的「最大的一处机会」已经落地**（2026-09-17）：
`/my/work` 的 `mode` 支持 `bug` / `task` / `story` / `todo` 四种，
而官方 `/my/tasks`、`/my/stories`、`/my/todos` 在本实例全部 404 ——
现在这四种都通过 `zendao_list_my_work` 暴露出来了；
同批还补上了任务详情（`zendao_get_task`，`/tasks/{id}` 路由本来就存在）、
需求（`story/list` + `story/get`，**P1 后由通用层承接**，原手写工具已删）、
版本（`build/list`）、用户字典（`zendao_list_users`）。
详见 `docs/porting-candidates.md` 的「八、实施记录」。

**⭐ 通用层已上线**（2026-09-18，迁移计划 P0 完成）：

`zendao_modules` / `zendao_help` / `zendao_call` 三个工具由官方 `zentao-api@0.7.0` 的
**声明式动作注册表**驱动，一个工具覆盖 **229 个动作**，且**能力随实例版本自适应**
（版本取自匿名 `/?mode=getconfig`，本实例 max8.2 → 106 个动作）。
标准三步走：`modules`（有哪些）→ `help`（参数怎么传）→ `call`（执行）。

排查 / 复用这条链路时，四条硬约束别忘：

- ⚠️ **`import('zentao-api')` 必须是真动态 import** → `tsconfig` 的 `module`/`moduleResolution`
  必须是 `node16`。写成 `commonjs` 时 **tsc 会把 `import()` 静默降级成 `require()`**，
  编译期毫无异常、运行时才炸（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。
- ⚠️ **改 tsconfig 会同时影响 jest**（`jest.config.js` 的 `ts-jest.tsconfig` 指向同一份配置）
  → 改完顺手跑 `npm run test:unit`。
- ⚠️ **SDK 的 `convert` 是以 `(data, params, options)` 三参调用的** —— 传本项目的
  `convertHtmlFields(value, maxDepth)` 必须包一层单参数闭包，否则第二个形参收到 `params` 对象，
  深度上限变 NaN。
- ⚠️ **query 序列化不能交给 axios** —— 官方数组是 `key[0]=v0`，axios 默认 `key[]=v0`，
  多值查询参数会解析失败（适配器里自己实现了）。

完整方案与实测证据见 `docs/migration-plan-sdk.md`（含 P0 实施记录）。

**⭐ P1 工具收敛已完成**（2026-09-20）：

工具数 **35 → 11**。删掉的 24 个「一工具一动作」封装是：
`list_projects` / `get_project` / `create_project` / `list_executions` / `get_execution` /
`list_tasks` / `create_task` / `update_task_status` / `list_products` / `get_product` /
`list_programs` / `list_stories` / `get_story` / `list_builds` / `create_bug` / `update_bug` /
`resolve_bug` / `close_bug` / `activate_bug` / `confirm_bug` / `delete_bug` /
`list_bug_modules` / `update_bug_module` / `delete_bug_module` ——
能力**全部**由通用层 `zendao_call { module, action }` 承接（含原先手写的 `filter` 表达式与本地排序）。

保留的 8 个手写工具都是**官方与 SDK 都给不了**的实例特有能力：
`list_bugs`（跨产品全库合并）/ `get_bug` / `get_bug_attachments` / `list_my_bugs` /
`list_my_work` / `get_task` / `list_users` / `batch_create_tasks`。

⚠️ **三处没有**被通用层接管的附加值（用之前要知道，别再以为默认存在）：

1. `project/list` 的 `browseType=doing` 默认口径（旧 `list_projects` 的放大拉取 + 本地兜底）；
2. `program/list` 的 `type === 'program'` 过滤 + 本地分页（旧 `list_programs` 的加工）；
3. `xxxName` 人名补全从「所有列表工具」收窄到只有 `list_my_work` / `get_task` 会补。

验收基线：`npm run verify:live` **61/61**、`npm test` **13 套件 / 253 用例全绿**、
`npm run verify` 报 **12 个工具**。

**⭐ 最大的剩余机会：`/my/work` 其实支持 13 种 `mode`**（2026-09-18 实测，脚本 6）：

| | mode |
| --- | --- |
| ✅ 本项目已支持（4） | `bug` · `task` · `story` · `todo` |
| ⬜ **可零成本补上（9）** | `epic` · `requirement` · `testtask` · `testcase` · `feedback` · `ticket` · `issue` · `risk` · `meeting` |
| ❌ 不支持（1） | `project`（返回**伪 200**） |

这些全部对应官方 `my` 模块的动作，而官方整个 `my` 模块被 max8.5 门槛挡死 ——
**官方给不了的 9 个「我的 X」，本项目只要扩 `MyWorkMode` 枚举就能拿到。**

⚠️ 已验证**不是**「服务端没过滤」：`story`(100条, ID 2002972 段) / `epic`(43条, ID 1309) /
`requirement`(28条, ID 1508) 的 **ID 交集为 0**，`task` vs `testtask` 同样交集 0 —— 是独立实体表。

**几条反直觉的端点事实**（详见脚本 3 报告）：

- 版本挂在**执行**下：`/executions/{id}/builds` ✅，但 `/products/{id}/builds` 与 `/projects/{id}/builds` 都是 404。
- `/stories/{id}`、`/tasks/{id}` 详情路由**存在**（返回业务 `fail`，不是 404）。
- `/users`、`/users/{id}`、项目/执行 `members` **全部 404**；但 `/my/work` 响应里自带 `users` 字典（账号 → 姓名）。
- 项目维度可以查 Bug（`/projects/{id}/bugs`），但**不能**查任务（`/projects/{id}/tasks` 404）。
- `/testtasks` 有全局入口，`/stories` 没有；`/epics`、`/requirements` 也没有。

**测试线（2026-09-18 深探，详见 `docs/porting-candidates.md` P1-8）**：

- ⭐ **用例也有全局列表**：`/testcases` ✅（180 条），`/testtasks` ✅（188 条）。两者列表键都是**字典**（`cases` / `tasks`），必须 `restoreDictOrder`。
- ⚠️ **用例 ID 双形态**：列表给复合 ID `case_2004638`，**原样当路径参数直接 404**；详情必须剥前缀用纯数字 `/testcases/2004638`。
- ⭐ **能建**：`POST /testcases`（必填 `productID`+`title`）、`POST /testtasks`（必填 `productID`/`name`/`build`/`begin`/`end`）实测路由都在。
- ⭐ **执行结果只有一条路**：`/testtasks/{id}/results` —— 但它**忽略路径 id**，实为「**全库**执行结果」（2912 条：pass 2557 / fail 330 / blocked 25），且不分页（`pager=null`）。`?type=` ∈ `{all,fail,pass,blocked}` **真生效**。
- ❌ **「执行用例」两边都没有**：`/testcases/{id}/run`、`/results`、`/testruns`、`/testresults` 全无路由（16 次连测），官方 CLI 255 个动作里也没有。→ **能建能查，不能跑。**
- ⚠️ `/testtasks/{id}/cases` **恒报 `Task does not exist.`** —— 它要的是 **taskID**（「任务下的用例」），不是测试单 ID。
- 用例实体自带只读执行汇总：`lastRunner` / `lastRunDate` / `lastRunResult` / `caseFails` / `results`。

**重新评估触发条件**：实例升到 **max8.5+** 后重跑**脚本 1**（官方 CLI 边界）/ **脚本 3**（REST 端点）
/ **脚本 5**（官方模块清单）—— 届时官方 `my` / `confirm` /
`file update` / 整个 `doc` 解锁，本项目的差异会大幅收窄，只剩「附件下载 · 全库合并 ·
影子产品发现」三条护城河。

**三份文档的分工**（别重复维护同一份信息）：

| 文档 | 定位 | 什么时候看 |
| --- | --- | --- |
| `docs/official-module-parity.md` | **完整对照表** —— 官方 26 模块 × 229 动作 × 版本门槛 × REST 实测 × 本项目覆盖 | 决定「某个功能能不能做」 |
| `docs/porting-candidates.md` | **移植决策** —— 该做什么、优先级、做到哪了 | 决定「下一步做什么」 |
| `docs/vs-official-zentao-cli.md` | **总述** —— 该不该继续维护本项目 | 回答「要不要换成官方」 |

---

## 注意事项

- **凭据**：脚本读项目根 `.env` 的 `ZENTAO_*`，映射成官方 CLI 的 `ZENTAO_*` 环境变量，
  **只用于子进程、不打印、不落盘**。带凭据的调用会刷新 `~/.config/zentao/zentao.json` 里的 Token
  —— 这是官方 CLI 的正常行为。
- **代理**：环境注入了 `HTTP_PROXY`，脚本会自动把目标主机加进 `NO_PROXY`；
  否则打内网的请求会被代理改写而失败。
- **只读保证**：脚本只跑 `version` / `--help` / 列表查询，**没有任何写操作**。
  想验证写路径（PUT/DELETE）时不要用真实 Bug 试 —— 本实例的动作端点是「整体替换」语义，
  少传字段会清空数据（详见 README 坑五）。
- **中文输出乱码**：Windows 控制台编码所致，不是数据问题。用 `--out` 写文件再读即可。
- **别用 `npm run verify` 验收 schema 改动** —— 它不做 ajv 校验，
  要用**脚本 4**（`npm run verify:live`）那种真客户端，或脚本 2 看 schema。
- **改完 `src/` 必须 `npm run build` 再验收**（踩过：`src` 已把环境变量改名成 `ZENTAO_*`，
  但 `dist/` 没重编译，探针读的仍是旧拼写）。

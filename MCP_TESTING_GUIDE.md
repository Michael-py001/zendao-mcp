# 验证与测试指南

本文档分两部分：**怎么确认 MCP 接好了**（日常真正要用的），以及**项目里的 Jest 测试现状**。

> 2026-09-20 更新：P1 工具收敛已完成（**35 → 11 个工具**），测试基线也已清理并全绿。
> 2026-10-09 更新：新增 `zendao_list_my_efforts`（地盘-工时日志），工具数 **11 → 12**。
> 本文档里所有工具清单、用例数、命令都按当前仓库实际情况重写过。

---

## 一、验证接入（首选这条路）

### `npm run verify` —— 内置自检探针

```bash
npm run build
npm run verify
```

它做的事（源码见 `scripts/verify-mcp.js`）：

1. 以 MCP 客户端的身份拉起 `dist/index.js`（stdio 子进程）
2. `initialize` 握手 —— 确认服务活着、协议版本对得上
3. `tools/list` —— 列出所有已注册工具及必填参数
4. `tools/call` —— **真的调用一次** `zendao_modules`，确认能读到禅道数据
5. 检查 `stdout` 上有没有非 JSON 内容 —— 有就说明协议通道被日志污染了

正常输出（2026-09-20 实跑）：

```
✅ 1) initialize     -> zendao-mcp-server v1.0.0 (协议 2024-11-05)
✅ 2) tools/list     -> 12 个工具
      · zendao_get_task  (必填: taskId)
      · zendao_batch_create_tasks  (必填: items)
      · zendao_list_bugs
      · zendao_list_my_bugs
      · zendao_list_my_work  (必填: mode)
      · zendao_get_bug  (必填: bugID)
      · zendao_get_bug_attachments  (必填: bugID)
      · zendao_list_users
      · zendao_modules
      · zendao_help  (必填: module)
      · zendao_call  (必填: module, action)
✅ 3) tools/call     -> zendao_modules 成功，实例版本 max8.2，
                        注册表 26 模块 / 229 动作，当前实例可用 106 个
      · user  可用 5/5
      · program  可用 5/5
      · product  可用 5/10
✅ 4) stdout 洁净    -> 无非 JSON 输出，协议通道正常
```

它的价值在于：**进程起得来 ≠ 能干活**。这个探针会真的连禅道、真的走 JSON-RPC，
所以 `projects.map is not a function` 这类只有在真实调用时才暴露的 bug，它能抓到
（历史验证中确实抓到过）。

> 探针是**只读**的：只调 `zendao_modules`（读注册表 + 当前实例可用动作），
> 不会创建或修改任何数据。

### `npm run verify:live` —— 真客户端 × ajv 的完整验收（最强的一道）

```bash
npm run verify:live
```

61 个用例、把 MCP 服务器当真实客户端连上去逐个调用。**它会用 ajv 校验
`structuredContent` 是否符合 `outputSchema`** —— 这是 `npm run verify` 做不到的
（后者是手写的 JSON-RPC 探针，不验 schema）。

```
- 用例：**61**　符合预期：**61**　不符：**0**
- 其中协议级错误（schema / 参数校验）：**0**
✅ 全部通过。`structuredContent` 与 `outputSchema` 一致，无 InvalidParams。
```

**改完 `src/` 里的工具或 schema，这一条必须跑。** 源码见
`.workbuddy/skills/zentao-cli-parity/scripts/verify-tools-live.mjs`。

### 日志怎么读

日志全部走 **stderr**，stdout 是 JSON-RPC 专用通道。这是 stdio MCP 的硬约束：
只要有一行日志写进 stdout，客户端就会报 JSON 解析错误。

启动成功的标志：

```
[INFO] 启动 ZenTao MCP 服务器...
[INFO] 配置加载完成: http://zen.example.com/zentaomax（REST API v2）
[INFO] 禅道 API 客户端已创建
[INFO] 连接验证成功
[INFO] LRU 缓存已初始化
[INFO] 所有工具注册完成
[INFO] MCP 服务器已启动，等待连接...
```

（「禅道 API 客户端已创建」后面会真实发一次 `/projects` 探活，所以「连接验证成功」
和上一行之间有几百毫秒间隔，属正常。）

版本号那行是**可选**的：禅道没有一个所有版本都提供的版本接口，实测 2.0 的
`/api.php/v2/system` 会被当成产品路由、返回 `{"status":"fail"}`，程序判断为「拿不到」后
安静跳过——**日志里没有「禅道版本」这一行是完全正常的**，不算错误。

日志级别通过 `LOG_LEVEL` 控制（`DEBUG` / `INFO` / `WARN` / `ERROR`，默认 `INFO`）。
排查工具调用细节时用 `LOG_LEVEL=DEBUG`，能看到每次请求的参数。

### MCP Inspector（图形界面）

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

浏览器里逐个工具点着试。注意要在**项目根目录**启动，否则读不到 `.env`
（其实也会兜底找，但显式点更省事）。

### 在客户端里试

对 AI 说「列出禅道前 5 个 Bug」。它应该先调 `zendao_call`（`module: "bug"`, `action: "list"`，
带 `productID`）或 `zendao_list_bugs` 并返回真实数据。
如果看不到工具，看 [MCP-SETUP.md 第七节](./MCP-SETUP.md#七常见问题)。

---

## 二、Jest 测试现状

**当前状态：13 个套件 / 253 个用例，全绿（`npm test` exit 0）。**

### 目录与状态

| 路径 | 内容 | 用例 | 连真实禅道？ |
| --- | --- | --- | --- |
| `tests/auth/auth-config.test.ts` | 认证配置规则 + 换 Token（v1/v2 双链路）+ 方法覆盖策略（PUT/DELETE）+ **凭证来源优先级（`env-account` → `env-token` → 官方 CLI profile store）**，内含本机 mock HTTP 服务 | 61 | 否 |
| `tests/auth/bug-list.test.ts` | Bug 本地过滤的假阴性回归：`browseType=assignedtome` 不得外发、拉取上限必须覆盖全量、**全局范围必须逐产品合并且不得漏掉 `/products` 列表外的影子产品**、`list_my_bugs` 各身份口径与 `includeClosed`；以及**「地盘」快路的选择规则**（默认必须走 `/my/work` 单次请求且不得触发全库遍历、ID 字典归一化、顶层 `recTotal=0` 时须取 `pager.recTotal`、超单页必须翻页、`edited`/`includeClosed`/`productID`/`any` 必须回落、`/my/work` 404 时优雅降级） | 38 | 否 |
| `tests/unit/bug-attachments.test.ts` | Bug 截图下载：内嵌 `<img fileID>` 解析、`data/upload/**` 匿名读取、本地落盘与缓存 | 39 | 否（本机 `http.createServer`） |
| `tests/unit/dict-order.test.ts` | ID 字典顺序归一化（`restoreDictOrder()`）：按 `orderBy` 重排，防止 JS 把对象键顺序吃掉 | 17 | 否 |
| `tests/unit/cache.test.ts` | `LRUCache` 四条不变量：get/set、TTL 过期、**LRU 淘汰顺序（靠单调访问序号，不靠时钟）**、`cleanup()` 双向断言 | 4 | 否 |
| `tests/unit/profile-store.test.ts` | 官方 CLI profile store 的**只读**访问：路径解析、读取容错（坏 JSON / 缺字段）、选择优先级（指定 key > `currentProfile` > 唯一一条 > 报错不猜）、**Token 有效期推算**。只用临时文件，绝不碰真实 store | 32 | 否 |
| `tests/error-handling/network-errors.test.ts` | 传输层：缺凭证不得发请求、`verifyConnection()` 连不上返回 `false`、5xx 按配置重试、重试耗尽后抛出（替换 axios `adapter`，不上网络） | 4 | 否 |
| `tests/tools/batch-create-tasks.test.ts` | `batch_create_tasks` 的并发聚合 / 逐条失败汇总 / 提前中断（用「必定失败」的假 client 跑全流程） | 6 | 否 |
| `tests/tools/list-my-efforts.test.ts` | `zendao_list_my_efforts`（地盘-工时日志）：日期口径（单日紧凑写法 / 区间 / 单边 / 颠倒）、本地过滤与按日按月汇总、参数校验，以及 **⚠️ 安全回归 —— 响应内嵌 `user`（含 password 哈希）不得透进 `structuredContent`** | 19 | 否 |
| `tests/startup.test.ts` | 启动与环境检查：配置项是否齐、`verifyConnection()`、版本探测 | 15 | **是（只读）** |
| `tests/error-handling/api-errors.test.ts` | HTTP 层错误映射：错误 Token、不存在的资源、伪 200（登录页 HTML） | 6 | **是（只读）** |
| `tests/integration/e2e.test.ts` | 跨工具只读数据流：`zendao_modules` → `zendao_call` 列产品 → 列 Bug → 详情 → 附件 → 「我的」快路 → `get_task` → `list_users` | 5 | **是（只读）** |
| `tests/integration/mcp-server.test.ts` | 真客户端（stdio）拉起 `dist/index.js`：连接 → **断言工具集正好是 12 个（不许漂移）** → 调只读工具 | 7 | **是（只读）** |
| `tests/setup.ts` | 全局前置：加载 `.env`、构造 `testClient` / `testCache`、探测禅道连通性（失败只告警，不中断离线用例） | — | — |
| `tests/global.d.ts` | 挂到 `global` 上的测试变量类型声明 | — | — |
| `tests/run-all-tests.sh` | 全量入口（`npm run test:all`） | — | — |
| `tests/helpers/test-data.ts` | 造测试数据 / 清理的辅助函数（**当前无调用方**，留给将来补写操作测试用） | — | — |

**小结**：33 个用例会连 `.env` 里配的那个禅道，但**全部只读**
（列表 / 详情 / 附件 / `verifyConnection`），不会创建、修改、删除任何数据；
其余 220 个完全离线。

### 常用命令

```bash
npm test                  # 全部 13 套件 / 253 用例
npm run test:unit         # 纯单元（缓存 / 字典顺序 / 附件 / 批量建任务）
npm run test:auth         # 认证与 Bug 列表口径，纯离线
npm run test:tools        # 工具层（batch_create_tasks / list_my_efforts）
npm run test:errors       # 错误处理（网络 + API）
npm run test:startup      # 启动与环境检查
npm run test:integration  # 集成（e2e + 真客户端 mcp-server）
npm run test:coverage     # 覆盖率报告
npm run test:watch        # 监视模式
npm run test:all          # 串起上面全部，最后出覆盖率
```

> `npm test` 系列统一走 `node --experimental-vm-modules node_modules/jest/bin/jest.js`。
> **这个 flag 不能去掉**：`src/sdk/loader.ts` 会用动态 `import()` 惰性加载纯 ESM 的
> `zentao-api`，在 jest 的 VM 里少了它会报 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`。

### 覆盖率

`jest.config.js` 里设了阈值（语句/行 75%、分支 70%、函数 75%）。
当前实际覆盖率低于此 —— 大量实现没有用例覆盖。

> 提醒：带 `--coverage` 跑会执行全部测试（含 4 个只读的连网套件），但不写数据。

---

## 三、想加测试？照这个来

可参考 `tests/auth/auth-config.test.ts`，它是本项目里最「干净」的一个测试文件：

- **不连外部服务**：需要 HTTP 交互时，用 Node 原生 `http` 起一个临时服务监听 `127.0.0.1:0`（随机端口），
  在 `afterAll` 里关掉。这样测试是自洽的、可重复的。
- **自己控制环境变量**：`src/config.ts` 在模块加载时会 `dotenv.config()` 把真实 `.env` 灌进
  `process.env`，所以单测里要显式 `delete process.env.ZENTAO_*` 再按需赋值，否则结果取决于本机 `.env`。
- **注意代理**：本机运行环境注入了 `HTTP_PROXY`，axios 会照着走代理，
  打到 `127.0.0.1` 的请求可能根本到不了你的 mock 服务端。测试里显式设置
  `NO_PROXY=127.0.0.1,localhost`。
- **不要依赖执行顺序**：每个用例自己准备状态，`beforeEach` 清缓存。
- **要模拟「Web 服务器在 HTTP 层拒绝某方法」**（比如复现 PUT/DELETE 被掐断），
  在 mock 服务端里直接 `req.socket.destroy()` —— 比手搓 405 更接近真实表现：
  客户端会拿到 `ECONNRESET` / `socket hang up`，而不是一个可解析的响应。
  参考 `tests/auth/auth-config.test.ts` 的「PUT/DELETE 方法覆盖」一组。

### ⚠️ 两个已经踩过的坑

1. **axios 的 `dispatchRequest` 不校验状态码。**「非 2xx 就 reject」是各个 adapter
   自己调 `settle()` 干的活（`node_modules/axios/lib/core/settle.js`）。所以你要写**假
   adapter** 时，必须自己按 `config.validateStatus` 决定 resolve 还是 reject ——
   否则**连 HTTP 500 都会被当成请求成功**，重试用例会以「假绿」的方式通过。
   参考 `tests/error-handling/network-errors.test.ts` 的 `respond()`。
2. **重试逻辑在响应拦截器里，mock 掉 `client.get` 会把它整条绕过去。** 想测重试，
   就把假实现挂在 axios 的 `defaults.adapter` 上，而不是替换 `get`/`post`。

同时注意 `jest.config.js` 里 `roots` 是 `['src', 'tests']`，所以 `src` 下如果有
`*.test.ts` 也会被收集并**编译进 `dist/`** —— 新写的测试一律放到 `tests/` 下。

---

## 四、故障排查

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `npm run verify` 报「找不到构建产物」 | 没构建 | `npm run build` |
| 探针报「服务器进程提前退出」 | 配置 / 认证问题 | 看上面 stderr 的日志，八成是 `.env` |
| 探针报「stdout 上出现非 JSON 内容」 | 有代码用 `console.log` 打日志 | 改用 `logger`（已统一走 stderr） |
| `verify:live` 报 `InvalidParams` | `structuredContent` 的键与 `outputSchema` 对不上 | 检查是否往结构化输出里塞了未声明的键（中文标签只能出现在文本里） |
| jest 报 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG` | 少了 VM 开关 | 别直接用 `jest`，走 `npm test` 那套脚本 |
| `tests/setup.ts` 打印「连不上禅道」 | `.env` 没配或网络不通 | 只影响 4 个连网套件，纯离线用例照跑 |
| 写工具报 `ECONNRESET` / `socket hang up` | 前置 Web 服务器拒绝 PUT/DELETE | 本项目会自动降级为方法覆盖；若被显式关掉，看 `ZENTAO_METHOD_OVERRIDE` |
| 日志里出现 `本实例在 HTTP 层拒绝了 PUT` | 方法覆盖自动生效（**这是 WARN，不是错误**） | 属正常：探测到一次后会缓存结论，后续写请求直接走覆盖 |

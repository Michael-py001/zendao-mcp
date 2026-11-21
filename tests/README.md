# tests/ 目录说明

> 完整说明（验证方式、测试现状、怎么写测试）见项目根目录的
> **[MCP_TESTING_GUIDE.md](../MCP_TESTING_GUIDE.md)**，本文只做目录索引。

## 前提

**当前 13 个套件 / 253 个用例全绿。** 其中 4 个套件（33 个用例）会连 `.env` 里配的
禅道，但**全部只读**（列表 / 详情 / 附件 / 连通性探测），不会创建、修改、删除任何数据。

## 目录

| 路径 | 说明 |
| --- | --- |
| `setup.ts` | 全局前置（对所有测试生效）：加载 `.env`、构造 `testClient` / `testCache`、探测禅道连通性。**缺凭证或连不上时只告警、不抛错**，以保证离线单测可跑。 |
| `global.d.ts` | 挂到 `global` 上的测试变量（`testClient` / `testCache` / `testConfig` / `testLogger` / `testZendaoReachable`）的类型声明。 |
| `auth/auth-config.test.ts` | ✅ 认证配置规则 + 换 Token 链路（v1/v2 双链路）+ PUT/DELETE 方法覆盖策略 + **凭证来源优先级（env-account / env-token / 官方 CLI profile store）**。内含 mock HTTP 服务，**纯离线，61/61 通过**。 |
| `auth/bug-list.test.ts` | ✅ Bug 本地过滤的假阴性回归：`browseType=assignedtome` 不得外发给服务端、拉取上限必须覆盖全量、**全局范围必须逐产品合并（不得把只返回单产品的 `/bugs` 当全库，也不得漏掉 `/products` 列表外的 `shadow=1` 影子产品）**、`list_my_bugs` 的各身份口径与 `includeClosed`；以及**「地盘」快路的选择规则**（默认必须走 `/my/work` 单次请求且不得触发全库遍历、ID 字典归一化、顶层 `recTotal=0` 时须取 `pager.recTotal`、超单页必须翻页、`edited`/`includeClosed`/`productID`/`any` 必须回落、`/my/work` 404 时优雅降级）。内含 mock HTTP 服务，**纯离线，38/38 通过**。 |
| `unit/bug-attachments.test.ts` | ✅ Bug 截图下载：内嵌 `<img fileID>` 解析、`data/upload/**` 匿名读取、本地落盘与缓存。内含 mock HTTP 服务，**纯离线，39/39 通过**。 |
| `unit/dict-order.test.ts` | ✅ ID 字典顺序归一化（`restoreDictOrder()`）：按 `orderBy` 重排，防止 JS 把对象键顺序吃掉。**纯离线，17/17 通过**。 |
| `unit/cache.test.ts` | ✅ `LRUCache` 四条不变量：get/set、TTL 过期、**LRU 淘汰顺序（靠单调访问序号，不靠时钟）**、`cleanup()` 双向断言。**纯离线，4/4 通过**。 |
| `unit/profile-store.test.ts` | ✅ 官方 CLI profile store 的只读访问：路径解析（`ZENTAO_CONFIG_FILE` 覆盖 / `~` 展开 / 默认路径）、读取容错（坏 JSON / 缺字段）、**选择优先级（指定 key > `currentProfile` > 唯一一条 > 报错不猜）**、**Token 有效期推算**。只用临时文件，**绝不碰真实 store**，纯离线，32/32 通过。 |
| `error-handling/network-errors.test.ts` | ✅ 传输层错误：缺凭证不得发请求、`verifyConnection()` 连不上返回 `false`、5xx 按配置重试、重试耗尽后抛出。**替换 axios `adapter`，不上网络**，4/4 通过。 |
| `tools/batch-create-tasks.test.ts` | ✅ `batch_create_tasks` 的并发聚合 / 逐条失败汇总 / 提前中断。用「必定失败」的假 client 跑全流程，**不写禅道**，6/6 通过。 |
| `startup.test.ts` | ✅ 启动与环境检查：配置项是否齐、`verifyConnection()`、版本探测。**会连真实禅道（只读）**，15/15 通过。 |
| `error-handling/api-errors.test.ts` | ✅ HTTP 层错误映射：错误 Token、不存在的资源、伪 200（登录页 HTML）。**会连真实禅道（只读）**，6/6 通过。 |
| `integration/e2e.test.ts` | ✅ 跨工具只读数据流：`zendao_modules` → `zendao_call` 列产品 → 列 Bug → 详情 → 附件 → 「我的」快路 → `get_task` → `list_users`。**会连真实禅道（只读）**，5/5 通过。 |
| `integration/mcp-server.test.ts` | ✅ 真客户端（stdio）拉起 `dist/index.js`：连接 → **断言工具集正好是 12 个（不许漂移）** → 调只读工具。**会连真实禅道（只读）**，需先 `npm run build`，7/7 通过。 |
| `helpers/test-data.ts` | 造测试数据、清理数据的辅助函数。**当前无调用方**，留给将来补写操作测试用。 |
| `run-all-tests.sh` | 批量跑测试的 shell 脚本（`npm run test:all`）。 |

## 常用命令

```bash
npm test                  # 全部 13 个套件 / 253 个用例
npm run test:unit         # 纯单元，最快
npm run test:auth         # 认证与 Bug 列表口径，纯离线
npm run test:integration  # 集成（含真客户端拉起 dist/index.js，需先 build）
npm run test:coverage     # 覆盖率
npm run test:watch        # 监视模式
npm run test:all          # 串起全部，最后出覆盖率
```

## 相关

- 接入与验证：[MCP-SETUP.md](../MCP-SETUP.md)
- 测试与验证详解：[MCP_TESTING_GUIDE.md](../MCP_TESTING_GUIDE.md)

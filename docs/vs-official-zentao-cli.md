# 与官方 zentao-cli 的对比评估

> 评估日期：**2026-09-17** ｜ 评估对象：官方 [`easysoft/zentao-cli`](https://github.com/easysoft/zentao-cli) **v0.3.0**
> 评估方式：**本机真机实测**（非文档推测），复现脚本见 `.workbuddy/skills/zentao-cli-parity/`
> **最近更新**：2026-09-20（本项目完成 P1 工具收敛，与「覆盖面」相关的结论已重写）

---

> ⚠️ **2026-09-20 更新摘要** —— 本篇原稿写在「本项目只有 26 个手写工具」的年代。
> 之后本项目先接入官方 `zentao-api` 通用层（**229 个动作全量可达**），
> 再把工具数从 35 收敛到 **11**（3 通用层 + 8 手写兜底）。于是下面几条判断**已经变了**，
> 正文对应表格已按现状改写：
>
> | 原判断（09-17） | 现状（09-20） |
> | --- | --- |
> | 「官方 CLI 覆盖面更广」 | **不再成立** —— 本项目经通用层同样覆盖 26 模块 / 229 动作 |
> | 「本项目是一工具一动作、工具多、占 context」 | **已反转** —— 现在 11 个工具，粒度比官方还粗 |
> | 「本项目无辅助工具（`action_help`）」 | **已有** `zendao_modules` / `zendao_help` |
> | 「本项目无版本兼容自检」 | **已有** —— SDK 按实例自报版本逐动作判定门槛 |
>
> **不变的**：三条护城河（附件下载 · 跨产品全库合并 · 影子产品发现）与两条实例硬伤
> （PUT/DELETE 被传输层掐断、`my` 模块的 max8.5 门槛）——
> 这些由**实例**决定，与工具形态无关。

---

## TL;DR

**结论：现阶段官方 CLI 无法替代本项目，两者是互补分工，不是替代关系。**

原因浓缩成一句话：**目标实例是禅道旗舰版 MAX8.2，而官方 CLI 把一大片能力标在了 `max8.5` 门槛上**，
再加两条与本项目同样的实例级硬伤（PUT/DELETE 被传输层掐断、附件无法下载）。

| 判断 | 结论 |
| --- | --- |
| 官方 CLI 能覆盖更广的模块吗？ | ~~是~~ → **现已相当**：都是 26 模块 / 229 动作（本项目经通用层获得） |
| 官方 CLI 能在本实例跑「我的 Bug」吗？ | **不能**，`my` 模块要求 max8.5，实例是 max8.2 |
| 官方 CLI 能改 / 删 Bug 吗？ | **不能**，与本项目同因：PUT/DELETE 被前置服务器掐断 |
| 官方 CLI 能下载 Bug 截图吗？ | **不能**，`file` 模块根本没有读取/下载能力 |
| 本项目该退役吗？ | **不该**。等实例升到 max8.5+ 后再重新评估 |

---

## 一、实测环境

```
Zentao CLI:    0.3.0
Zentao Server: MAX8.2 (http://zen.example.com/zentaomax)
```

- 本机**未全局安装**官方 CLI，实测通过 `npx -y zentao-cli@latest` 调用。
- 官方 CLI 按 **开源版 / biz / max / ipd** 四个系列**分别**比较版本；
  同一操作在四个系列上的最低版本要求可以完全不同，版本不足时**在发业务请求前就报错拒绝**。

---

## 二、本质区别：两者根本不是同一种东西

| 维度 | 官方 zentao-cli | 本项目 zendao-mcp |
| --- | --- | --- |
| 形态 | CLI 工具 **+ 可选 MCP 服务**（`zentao mcp`） | 纯 MCP 服务器（stdio）+ CLI 风格的探针脚本 |
| 覆盖面 | **26 模块 / 229 个 API 操作** | **同为 26 模块 / 229 个动作**（经通用层）—— 另加 8 个手写兜底能力 |
| 工具粒度 | 模块级胖工具（`zentao_bug` / `zentao_task`…）+ `action` 枚举 | **通用层 3 个**（`modules`/`help`/`call`）+ 8 个手写专用工具 |
| 目标 | 通用工具，服务所有禅道实例与所有用户 | 通用层面向所有实例；手写层面向特定实例做深度适配 |
| 版本兼容 | 内置四系列版本自检，不满足直接拒绝 | **同样有**：SDK 按实例自报版本逐动作判定（门槛在**调用时**判） |
| 认证 | CLI profile store（`~/.config/zentao/zentao.json`），**MCP 配置里不写密码** | 项目 `.env` 里的账号密码 |
| 多账号 | 支持 `profile` 切换 | 不支持 |
| 维护方 | 官方团队，持续更新 | 自维护（但通用层依赖官方 SDK → **复用官方维护成果**） |

### MCP 设计取向：从「相反」走向「趋同」

| | 官方 `zentao mcp` | 本项目（P1 之后） |
| --- | --- | --- |
| 工具粒度 | **模块级「胖工具」**：`zentao_bug`、`zentao_task`… 用 `action` 枚举路由 | **通用层 3 + 手写 9**，粒度**比官方更粗** |
| 辅助工具 | `zentao_action_help` / `zentao_profile` / `zentao_switch_profile` | `zendao_modules` / `zendao_help`（无多账号） |
| 参数 schema | `params: z.record(z.string(), z.unknown())` —— **无类型约束透传** | 通用层同样透传 `params`；**手写层是强 zod schema** |
| 返回值 | 纯文本 `content:[{type:'text', text: JSON.stringify(...)}]` | `structuredContent` + `outputSchema` 强校验（**本项目的独特优势**） |
| 优点 | 工具数量少、省 context；覆盖面靠 action 展开 | 工具数已同样少；**多了结构化返回**与中文错误映射 |
| 缺点 | 参数靠模型猜，多一轮 `action_help` 调用；无 schema 校验 | 通用层同样靠模型猜参数（但 `zendao_help` 能给完整参数表） |

> 📌 **P1 之前**本项目是「一工具一动作」（`zendao_resolve_bug`、`zendao_close_bug`…）：工具多、占 context，
> 但调用前即知参数。P1 收敛后改成「通用层优先」，**取了两者的交集** ——
> 工具数与官方相当，同时保留强 `outputSchema` 校验与中文错误。

> 依据：官方源码 `src/mcp/tools.ts`、`src/mcp/server.ts`。

---

## 三、决定性事实：MAX8.2 的版本墙

官方 CLI 在**本实例**上按版本门槛被拒的操作（实测报错原文）：

```
Error(E2010): 操作 my/bugs 不支持当前禅道版本 max8.2，
最低版本要求：22.5 / biz13.5 / max8.5 / ipd5.5，请升级对应系列的禅道版本
```

| 能力 | 官方最低版本 | 现状（max8.2） |
| --- | --- | --- |
| **整个 `my` 模块**：我的 Bug / 任务 / 需求 / 待办 / 项目 / 会议 / 问题 / 风险 | max8.5 | 不可用 |
| **`bug confirm`**（确认 Bug） | max8.5 | 不可用 |
| `bug`/`story`/`task` 的 `modules` / `updateModule` / `deleteModule` | max8.5 | 不可用 |
| `todo` 全部操作、`file update`、`story getGrades` | max8.5 | 不可用 |
| `bug`/`story`/`task` 的 list / get / create / update / delete | max8.0 | 可用 |
| `bug`/`story`/`task` 的 activate / close / resolve / finish / start | max8.0 | 可用 |

**「我的 Bug」和「确认 Bug」恰好是本项目最吃重的两个能力 —— 官方在 max8.2 上直接给不了。**

---

## 四、三条与本项目同源的实例硬伤

### 4.1 官方 SDK 不做方法覆盖 → update / delete 一样会挂

本实例的前置 Web 服务器会在 **HTTP 层直接拒绝 `PUT` / `DELETE`**（`ECONNRESET`，连响应体都不给）。

官方 `zentao-api@0.7.0` 的请求实现（`dist/request/index.js`）是**直发定义的方法**：

```js
await client.request(command.path, {
  method: String(command.action.method).toUpperCase(),
  query: command.query,
  ...requestOptions,
});
```

对整个包 Grep `X-HTTP-Method-Override` / `_method` **无任何命中**
（只有一个同名但无关的错误码 `E_INDETERMINATE_ACTION_METHOD`，含义是「无法从 action 推导 HTTP 方法」）。

→ 官方 CLI 的 `bug/task/story update|delete` 在本实例上**同样会被掐断**。

> 官方有一处做对了：`autoFillUpdateParams()` 会在 update 前先 GET 当前对象、用现值补齐未显式传入的字段
> —— 思路与本项目 `buildActionBody()` 完全一致，都是为了防「PUT 整体替换清空字段」。
> 但它防不了 `ECONNRESET`。

### 4.2 官方 `file` 模块不能下载附件

```
zentao file props                       获取对象属性定义
zentao file create                      上传附件（最低 max8.0）
zentao file update <id>                 编辑附件，仅能修改名称（最低 max8.5）
zentao file delete <id>[,<id>...]       删除附件（最低 max8.0）
```

**没有「读取 / 下载」能力。** 而本实例的 Bug 几乎条条是「见图」型
（复现步骤正文只有一句话，信息全在截图里）→
本项目的 `zendao_get_bug_attachments` 在这一点上**没有任何替代品**。

### 4.3 官方不做「全库」，也发现不了影子产品

```
$ zentao bug --pick=id,title --limit=5
Error(E2003): 缺少必要参数 scope/scopeID or product/project/execution
```

官方**强制列表带范围**。同时 `zentao product` 只列出 20/34 个产品，
本实例的影子产品 `2000076`（`shadow=1`，项目型产品）**不在其中**。

实测补充：**只要已经知道 ID，官方是能查影子产品的** ——

```
$ zentao bug --product=2000076 --pick=id,title --limit=5
| 2010523 | 任务表含有预制舱关键词… |
| 2010521 | 报价对比上传任务表成功后… |
（共 33 项）
```

→ 官方缺的是**发现**影子产品的能力，不是查询能力。本项目的 `fetchBugScopeProducts()`
取「`/products` ∪ `/bugs` 的 `products` 字典」，正是补这个洞。

---

## 五、能力矩阵

| 能力 | 官方 zentao-cli | 本项目 |
| --- | --- | --- |
| Bug / 任务 / 需求 列表与详情 | 可用 | 可用 |
| 建 Bug、解决 / 关闭 / 激活 | 可用 | 可用 |
| 确认 Bug（confirm） | 需 max8.5 | **可用**（REST 有路，绕过官方门槛） |
| 「我的 Bug」地盘快路 | 需 max8.5 | **可用** |
| Bug 截图附件下载 | 无此功能 | **可用** |
| 跨产品全库 Bug 扫描（含影子产品） | 强制带范围 | **可用** |
| 改 Bug / 删 Bug（PUT、DELETE） | 传输层掐断 | 同样做不了 |
| 需求 / 用例 / 测试单 / 产品计划 / 版本 / 发布 | 可用（部分受版本限制） | **现已可用**（通用层；REST 实测有路的都能打） |
| 文档 / 待办 / 会议 / 问题 / 风险 / 工单 / 反馈 | 可用（部分受版本限制） | **多数已可用**（`issue`/`risk`/`meeting`/`feedback`/`ticket` REST 有路）⚠️ `doc` 全 404 |
| 项目 / 执行 / 任务 CRUD | 可用 | 可用 |
| 版本兼容自检 | 可用 | **可用**（SDK 按实例自报版本判定） |
| 多账号切换 | **可用** | 无此功能 |
| 强类型结构化返回（structuredContent） | 无此功能 | **可用**（仍是本项目独有优势） |

---

## 六、分工建议

**两个都留着，但分工已经变了 —— 不再是「广度 vs 深水区」。**

P1 之后本项目的覆盖面已与官方**基本齐平**（两者都靠 `zentao-api` 的动作注册表）。
真正的分界变成「**谁在你这台实例上真的能跑**」：

- **官方 CLI 更适合**：需要多账号 `profile` 切换的场景；以及官方刚发版、
  本项目通用层还没跟上的新模块（本项目跟随 SDK 版本，通常也能第一时间拿到）。

- **本项目更适合**：
  1. **要 `structuredContent` + `outputSchema` 强校验**的自动化链路（官方返回纯文本，无 schema 校验）；
  2. **官方门槛够不着、但 REST 有路**的能力 —— `my` 模块（我的 Bug / 任务 / 需求 / 待办）、
     `bug confirm`、`issue` / `risk` / `meeting` 列表、`execution/team`。
     官方在 max8.2 上直接拒绝，本项目走 REST 直连**不受官方门槛约束**；
  3. **三条护城河**：Bug 截图附件下载、跨产品全库合并（含影子产品）、影子产品的发现能力；
  4. 中文错误映射与中文枚举标签（官方报错是英文错误码）。

**顺带一个用法**：`zentao version` 会打印服务器版本，可以当「实例体检」的第一条命令 ——
它同时决定了官方 CLI 自身哪些功能可用。

---

## 七、什么时候重新评估

**触发条件：实例升级到 max8.5+。**

届时官方的 `my` 模块、`bug confirm`、各模块 `modules`、`file update`、`todo` 全部解锁，
本项目的差异化会大幅收窄，**只剩三条护城河**：

1. Bug 附件（截图）下载
2. 跨产品全库 Bug 合并
3. 影子产品发现

到了那一天，本项目的存续价值需要重新论证 —— 建议直接跑一次
`.workbuddy/skills/zentao-cli-parity/` 里的探针，用数据说话。

> 📌 **P1 之后判据变了**：即使在 max8.2 上，本项目的**覆盖面**也已与官方齐平（通用层）。
> 差距只剩「**实例级可达性**」（官方门槛拒掉、但 REST 其实有路的那批）。
> 所以「要不要继续维护」的判据，从「能覆盖多少模块」变成了两条：
> **① 是否要 `structuredContent` 强校验；② 是否要那三条实例独占能力。**

---

## 八、复现本文所有结论

```bash
# 1) 官方 CLI 侧：版本、模块、版本门槛、只读连通性（全部只读，无写操作）
npm run probe:cli
#   等价于：node .workbuddy/skills/zentao-cli-parity/scripts/probe-official-cli.mjs
#   常用变体：
#   npm run probe:cli -- --modules=ALL              # 分析全部 26 个模块
#   npm run probe:cli -- --sample-product=2000076   # 用影子产品验证「已知范围」
#   npm run probe:cli -- --out=docs/parity.md --json=docs/parity.json

# 2) 本项目侧：列出当前 MCP 工具清单与描述
npm run build
npm run probe:tools
#   等价于：node .workbuddy/skills/zentao-cli-parity/scripts/probe-mcp-tools.mjs
```

详细用法与参数见 `.workbuddy/skills/zentao-cli-parity/SKILL.md`。

> ⚠️ 探针只执行**只读**的官方 CLI 命令（`version` / `--help` / 列表查询）。
> 其中带凭据的调用会刷新 `~/.config/zentao/zentao.json` 里的 Token —— 这是官方 CLI 的正常行为。
>
> 📌 凭据从项目根 `.env` 读取（`ZENTAO_*` → `ZENTAO_*`），只注入子进程，不打印、不落盘。

# 官方 zentao-cli 模块 × 本项目工具：完整对照与移植依据

> **数据来源**：**`zentao-api` SDK 注册表**（`npm run probe:modules-sdk`，推荐）／
> 官方仓库 `zentao-cli/docs/command-reference.md`（`npm run probe:official-modules`，交叉验证）
> **目标实例**：禅道 **MAX8.2** @ `zen.example.com/zentaomax`（API `/api.php/v2`）
> **对照时间**：2026-09-18 ｜ **最近更新**：2026-09-20（P1 工具收敛 35 → 11，第三节按新结构改写；
> 线 A/B 改用 **SDK 内省**取数，与 md 模式逐动作一致）
> **配套文档**：[移植候选清单（决策与进度）](./porting-candidates.md) · [与官方 zentao-cli 的对比](./vs-official-zentao-cli.md)
> **复现**：见文末 [八、怎么重新生成这份对照](#八怎么重新生成这份对照)

本文是**索引型文档** —— 回答「官方有什么、我们有什么、差在哪里、差的部分能不能做」。
至于「该不该做、先做哪个」，看 [porting-candidates.md](./porting-candidates.md)。

---

## 一、怎么读：三条互相独立的线

判断一个官方功能能不能移植到本项目，必须同时过三关，**任何一关都可能是死路**：

| 线 | 问题 | 数据来源 | 本实例结果 |
| --- | --- | --- | --- |
| **A · 官方有没有** | 官方 CLI 提供这个动作吗？ | **`zentao-api` 注册表**（`probe:modules-sdk`）／官方 `command-reference.md` | **26 模块 / 229 个业务动作** |
| **B · 版本门槛** | 官方 CLI 允许打这台实例吗？ | 同上（每个动作标注最低版本） | **106 个可过 / 123 个被拒** |
| **C · REST 实际给不给路** | 服务端真的有这个路由吗？ | `npm run probe:endpoints` 实测 | **62 探测点 / 37 有路 / 25 无** |

### ⚠️ 最关键的一点：B 和 C **不等价**

这是整份文档最需要记住的事 —— **官方 CLI 的版本门槛，不是本项目的门槛**。

```
官方 CLI  ──(自己检查版本)──> 拦截 ✋  ← 门槛只存在于这一层
                                  │
本项目     ──(直连 REST)────────────┴──> 服务端  ← 只受「路由存不存在」约束
```

于是出现两种**高价值错位**：

| 错位 | 含义 | 实例 |
| --- | --- | --- |
| 🔵 **官方被拒，但 REST 有路** | **本项目的机会** —— 官方给不了，我们能给 | `/my/work` 全部 mode、`issue`/`risk`/`meeting` 列表、`execution/projectExecutions`、`bug/confirm` |
| 🔴 **官方放行，但 REST 无路** | **谁都做不了** —— 别浪费工 | `user/*`（`/users` 404）、`program/get`、三个模块树、`doc/*` |

**所以「官方有没有」几乎不构成移植理由，只有线 C 说了算。**

---

## 二、模块总览：官方 26 模块 × 本实例可用性

`max8.0` 门槛 = 本实例（8.2）**能过**；`max8.5` = **被拒**。

> ⚠️ **2026-09-20 P1 更新**：下表的「原手写工具」列记录的是 P1 收敛**之前**每个模块有几个专用工具。
> 收敛后这 30 个封装里的 **24 个已删除**，现在**全部模块统一由通用层覆盖** ——
> 只要「REST 层实测」不是 🔴，就能用 `zendao_call { module: "<模块>", action: "<动作>" }` 打到。
> 保留的手写工具只剩 8 个（清单见 `MCP-SETUP.md` 第五节）。

| 官方模块 | 中文 | 动作数 | max8.0 | max8.5 | 原手写工具 | REST 层实测 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `user` | 用户 | 5 | 5 | 0 | 1（绕路） | 🔴 `/users*` **全 404** |
| `program` | 项目集 | 5 | 5 | 0 | 1 | 🟡 仅 `/programs` 列表；`/programs/{id}` 404 |
| `product` | 产品 | 10 | 5 | 5 | 2 | 🟢 列表/详情可用 |
| `project` | 项目 | 12 | 4 | 8 | 3 | 🟡 团队/成员 404 |
| `execution` | 执行 | 11 | 5 | 6 | 2 | 🟢 列表/详情/团队/项目下执行 可用 |
| `productplan` | 产品计划 | 5 | 5 | 0 | 0 | 🟢 列表/详情可用 |
| `story` | 需求 | 12 | 8 | 4 | 2 | 🟢 列表/详情/动作流 可用 |
| `epic` | 业务需求 | 8 | 8 | 0 | 0 | 🟡 全局列表 404，详情可用（走 story 路由） |
| `requirement` | 用户需求 | 8 | 8 | 0 | 0 | 🟡 同上 |
| `bug` | Bug | 12 | 8 | 4 | **12 / 12** | 🟢 全模块可用（模块树除外） |
| `testcase` | 测试用例 | 8 | 5 | 3 | 0 | 🟢 列表/详情可用；模块树 404 |
| `task` | 任务 | 12 | 9 | 3 | 7 | 🟢 列表/详情/创建/4 个动作流 可用 |
| `issue` | 问题 | 5 | 0 | 5 | 0 | 🔵 **列表/详情/项目下/执行下 全可用** |
| `risk` | 风险 | 6 | 0 | 6 | 0 | 🔵 **列表/详情/项目下/执行下 全可用** |
| `meeting` | 会议 | 8 | 0 | 8 | 0 | 🔵 列表/详情可用；项目/执行下 404 |
| `feedback` | 反馈 | 12 | 7 | 5 | 0 | 🟢 列表/详情可用 |
| `ticket` | 工单 | 9 | 7 | 2 | 0 | 🟢 列表/详情可用 |
| `system` | 应用 | 3 | 3 | 0 | 0 | 🟢 `/systems` 路由在 |
| `build` | 版本 | 4 | 4 | 0 | 1 | 🟢 执行下列表 + `/builds/{id}` 可用 |
| `testtask` | 测试单 | 4 | 4 | 0 | 0 | 🟢 全局/产品/项目/详情 可用 |
| `release` | 发布 | 4 | 4 | 0 | 0 | 🟢 产品下列表 + `/releases/{id}` 可用 |
| `file` | 附件 | 3 | 2 | 1 | 1（**官方做不到**） | 🟢 `/files/{id}` 可用 |
| `workflow` | 工作流 | 5 | 0 | 5 | 0 | ⬜ 未探 |
| `doc` | 文档 | 41 | 0 | 41 | 0 | 🔴 `/doc/*` **全 404** |
| `todo` | 待办 | 3 | 0 | 3 | 1（读） | 🟡 `/todos` 404；读走 `/my/work?mode=todo` |
| `my` | 地盘 | 14 | 0 | 14 | **4 / 14** | 🔵 **13 个 mode 可用**（见第六节） |
| **合计** | | **229** | **106** | **123** | **32 → 11** | 37 有路 / 25 无 |

图例：🟢 基本可用 · 🔵 **官方被门槛拒但 REST 有路（机会）** · 🟡 部分可用 · 🔴 无路 · ⬜ 未探

> 📌 `doc` 一个模块占了 41 个动作（全部 max8.5），是「官方动作数」的最大虚高源。
> 剔除 `doc` 后，剩下的 188 个动作里 **106 个门槛可过**、82 个被拒 —— 更贴近真实差距。

---

## 三、本项目工具 → 官方动作映射

> ⚠️ **2026-09-20 P1 更新**：下表左列是 **P1 收敛之前**的手写工具名。
> 收敛后这 30 个里的 **24 个已删除**，统一改由通用层承接 ——
> 调用方式是 `zendao_call { module: "<官方模块>", action: "<官方动作>" }`。
>
> 仍然是手写工具的只剩这几个：
> `zendao_list_bugs` · `zendao_get_bug` · `zendao_get_bug_attachments` ·
> `zendao_list_my_bugs` · `zendao_list_my_work` · `zendao_get_task` ·
> `zendao_list_users` · `zendao_batch_create_tasks`。
>
> **旧工具名 → 新写法**的逐条对照见 `MCP-SETUP.md` 第五节的「常用动作」表。

### 3.1 有官方对应物（30 个）

| # | 原本项目工具 | 官方模块 | 官方动作 | 状态 |
| ---: | --- | --- | --- | --- |
| 1 | `zendao_list_projects` | `project` | `list` | ✅ 对齐 |
| 2 | `zendao_get_project` | `project` | `get` | ✅ 对齐 |
| 3 | `zendao_create_project` | `project` | `create` | ✅ 对齐 |
| 4 | `zendao_list_executions` | `execution` | `list` | ✅ 对齐 |
| 5 | `zendao_get_execution` | `execution` | `get` | ✅ 对齐 |
| 6 | `zendao_list_tasks` | `task` | `list` | ✅ 对齐 |
| 7 | `zendao_get_task` | `task` | `get` | ✅ 对齐 |
| 8 | `zendao_create_task` | `task` | `create` | ✅ 对齐 |
| 9 | `zendao_update_task_status` | `task` | `start`/`finish`/`close`/`activate` | ✅ **四合一** |
| 10 | `zendao_list_products` | `product` | `list` | ✅ 对齐 |
| 11 | `zendao_get_product` | `product` | `get` | ✅ 对齐 |
| 12 | `zendao_list_programs` | `program` | `list` | 🟡 官方还有 get/create/update/delete，REST 无路 |
| 13 | `zendao_list_stories` | `story` | `list` | ✅ 对齐 |
| 14 | `zendao_get_story` | `story` | `get` | ✅ 对齐 |
| 15 | `zendao_list_builds` | `build` | `list` | ✅ 对齐（路径是**执行**下） |
| 16 | `zendao_list_bugs` | `bug` | `list` | ✅ 对齐 |
| 17 | `zendao_get_bug` | `bug` | `get` | ✅ 对齐 |
| 18 | `zendao_create_bug` | `bug` | `create` | ✅ 对齐 |
| 19 | `zendao_update_bug` | `bug` | `update` | ⚠️ 本实例 PUT 被传输层掐断 |
| 20 | `zendao_resolve_bug` | `bug` | `resolve` | ✅ 对齐 |
| 21 | `zendao_close_bug` | `bug` | `close` | ✅ 对齐 |
| 22 | `zendao_activate_bug` | `bug` | `activate` | ✅ 对齐 |
| 23 | `zendao_confirm_bug` | `bug` | `confirm` | 🔵 **REST 有路！**（官方 max8.5 被拒） |
| 24 | `zendao_delete_bug` | `bug` | `delete` | ⚠️ 本实例 DELETE 被掐断 |
| 25 | `zendao_list_bug_modules` | `bug` | `modules` | 🔴 路由 404（且官方 max8.5） |
| 26 | `zendao_update_bug_module` | `bug` | `updateModule` | 🔴 双阻（404 + PUT 掐断） |
| 27 | `zendao_delete_bug_module` | `bug` | `deleteModule` | 🔴 双阻（404 + DELETE 掐断） |
| 28 | `zendao_list_my_bugs` | `my` | `bugs` | 🔵 **绕开门槛**（官方整个 `my` 模块 max8.5） |
| 29 | `zendao_list_my_work` | `my` | `todos`/`tasks`/`bugs`/`stories` | 🔵 **绕开门槛** |
| 30 | `zendao_list_users` | `user` | `list` | 🔵 **绕路**（`/users` 404 → 走 `/my/work` 字典） |

### 3.2 官方没有对应物 —— 本项目独有

| 工具 | 为什么官方做不到 |
| --- | --- |
| `zendao_batch_create_tasks` | 禅道没有原生批量接口，本项目是「逐条 + 分批并发」自研 |
| `zendao_get_bug_attachments` | **官方 `file` 模块只能上传/改名/删除，不能下载**；本项目靠 `data/upload/**` 匿名可读直取图片 |

> 另有三个「官方**有**对应动作、但官方 CLI 在本实例够不着」的保留工具：
> `zendao_list_bugs` 的全库合并（官方强制带范围，且发现不了影子产品）、
> `zendao_list_my_bugs` / `zendao_list_my_work`（官方整个 `my` 模块要 max8.5）、
> `zendao_list_users`（官方 `/users` 在本实例 404）。

---

## 四、缺口清单：官方有、本项目无

> ⚠️ **2026-09-20 P1 更新**：通用层上线 + P1 收敛之后，**本节列出的「缺口」基本都已被填上** ——
> 下面 A 档的动作（`productplan` / `release` / `testcase` / `testtask` / `issue` / `risk` /
> `meeting` / `feedback` / `ticket` / `system` / `build/get` / `execution/team` / `/my/work` 的 9 个 mode …）
> 现在都能直接用 `zendao_call { module, action }` 打到，**不需要再写手写工具**。
>
> 保留本节是为了留存**线 C（REST 实测）的证据** —— 它回答的仍然是
> 「这个动作在这台实例上到底有没有路」。B / C 档的阻碍（PUT/DELETE 被掐断、端点 404）
> **不受 P1 影响**，依然成立。

按「线 C（REST 实际）」分三档 —— **这才是移植可行性的判据**。

### ✅ A 档 · 可直接移植（REST 有路、只读、不碰 PUT/DELETE）

**这一类是真正的「白捡」清单**，成本低、无风险：

| 官方动作 | REST 路由（实测） | 价值 |
| --- | --- | --- |
| `productplan/list` | `/products/{id}/productplans` ✅ | 需求排期背景 |
| `productplan/get` | `/productplans/{id}` ✅（200+fail） | — |
| `release/list` | `/products/{id}/releases` ✅ | 版本发布线，现在完全空白 |
| `release/get` | `/releases/{id}` ✅ | — |
| `testcase/list` | `/testcases` ✅（**有全局列表**）、产品/项目/执行下 ✅ | 测试线 |
| `testcase/get` | `/testcases/{id}` ✅（⚠️ ID 要**剥掉 `case_` 前缀**） | 60 字段含步骤树 |
| `testtask/list` | `/testtasks` ✅、`/products/{id}/testtasks` ✅ | 测试批次 |
| `testtask/get` | `/testtasks/{id}` ✅ | — |
| `testtask` 执行结果 | `/testtasks/{id}/results` ✅（⚠️ **忽略路径 id**，实为全库 2912 条） | 全实例唯一「用例跑没跑」入口 |
| `issue/list` `issue/get` | `/issues` ✅ · `/issues/{id}` ✅ | 🔵 官方全模块 max8.5 被拒 |
| `issue/projectIssues` `issue/executionIssues` | `/projects/{id}/issues` ✅ · `/executions/{id}/issues` ✅ | 🔵 同上 |
| `risk/list` `risk/get` | `/risks` ✅ · `/risks/{id}` ✅ | 🔵 官方全模块 max8.5 被拒 |
| `risk/projectRisks` `risk/executionRisks` | `/projects/{id}/risks` ✅ · `/executions/{id}/risks` ✅ | 🔵 同上 |
| `meeting/list` `meeting/get` | `/meetings` ✅ · `/meetings/{id}` ✅ | 🔵 官方全模块 max8.5 被拒 |
| `feedback/list` `feedback/get` | `/feedbacks` ✅ · `/feedbacks/{id}` ✅ | — |
| `ticket/list` `ticket/get` | `/tickets` ✅ · `/tickets/{id}` ✅ | — |
| `system/list` | `/systems` ✅（200+fail） | 应用列表 |
| `build/get` | `/builds/{id}` ✅（官方无此动作） | 版本详情 |
| `execution/projectExecutions` | `/projects/{id}/executions` ✅ | 🔵 官方 max8.5 被拒 |
| `execution/team` | `/executions/{id}/team` ✅ | 🔵 官方 max8.5 被拒 |
| `epic/*` `requirement/*` 详情 | `/epics/{id}` · `/requirements/{id}` ✅（走 story 路由） | ⚠️ 全局列表 404 |
| `story/close` `story/change` `story/activate` | POST `/stories/{id}/{action}` ✅ | 需求状态流转 |
| `testtask/close` | POST `/testtasks/{id}/close` ✅ | — |
| `feedback/close` | POST `/feedbacks/{id}/close` ✅ | — |
| `ticket/close` | POST `/tickets/{id}/close` ✅ | — |
| **`my` 的 9 个 mode** | `/my/work?mode=…` ✅ | 🔵 **见第六节，最大收获** |

### ⚠️ B 档 · 受阻（有条件，需绕或需谨慎）

| 类别 | 官方动作 | 阻碍 |
| --- | --- | --- |
| **PUT 被掐断** | `story/update` `testcase/update` `product/update` `project/update` `execution/update` `task/update` `meeting/update` `risk/update` `feedback/update` `ticket/update` | 前置 Web 服务器在 HTTP 层掐 PUT。本项目对 Bug 的绕法是「**先 GET 当前值 → 拼完整对象 → 走 POST 动作端点**」 |
| **DELETE 被掐断** | 各模块 `delete` | 同上；通用层（官方 SDK）直发定义的 `DELETE`，**绝不降级 POST**（会掉进建单路由造脏数据） |
| **关闭类动作 404** | `product/close` `project/close` `execution/close` | POST 实测 **404**，明确无路 |
| **写创建类** | `testcase/create`（POST ✅ 已验证路由）、`testtask/create`、`productplan/create`、`release/create`、`build/create`、`ticket/create`、`feedback/create` | POST 路由大概率可用，但**属写操作，未做落库验证** |
| **`todo` 写操作** | `todo/create` `todo/update` `todo/delete` | `/todos` 404，且官方 max8.5 |

### ❌ C 档 · 明确不做（REST 无路）

| 官方动作 | 实测 | 说明 |
| --- | --- | --- |
| `user/list` `user/get` `user/create` `user/update` `user/delete` | `/users`、`/users/{id}` **404** | 唯一出路是 `/my/work` 的 `users` 字典（**已用于 `zendao_list_users`**），写操作彻底没戏 |
| `program/get` `program/create` `program/update` `program/delete` | `/programs/{id}` 404 | 项目集只有列表 |
| `project/team` `project/projectMembers` `project/members` | `/projects/{id}/team`、`/members` **404** | 官方标 max8.5，REST 也没开 |
| `execution/executionMembers` `execution/members` | `/executions/{id}/members` **404** | 同上（但 `/executions/{id}/team` **可用**） |
| **三个模块树** | `/products/{id}/story/modules`、`/testcases/modules`、`bug/modules` **404** | `story/modules` `bug/modules` `testcase/modules` `task/modules` `*updateModule` `*deleteModule` 共 ~12 个动作全废 |
| `epic/*` `requirement/*` 全局列表 | `/epics`、`/requirements` **404** | 详情有路（走 story 路由），列表只能靠 `/my/work?mode=epic\|requirement` |
| `meeting/projectMeetings` `meeting/executionMeetings` | `/projects/{id}/meetings`、`/executions/{id}/meetings` **404** | 只有全局 `/meetings` |
| **`doc` 整个模块（41 动作）** | `/doc/my/spaces` **404** | 单模块最大缺口，且全部 max8.5 —— **双向封死** |
| `workflow` 整个模块（5 动作） | 未探（全 max8.5） | 官方自己都标了 8.5，且是「以合同为例」的定制工作流，优先级最低 |
| `my/projects` | `/my/work?mode=project` **伪 200** | 13 个 mode 里唯一不支持的 |

---

## 五、⚠️ 三条容易搞错的判定规则

实测踩出来的，写文档/写代码时都别搞反：

### 1. 「404」才是没路，「200 + `status:fail`」是有路

禅道对**不存在的对象**返回 HTTP 200 + `{"status":"fail","message":"xxx does not exist."}`；
只有**路由本身不存在**才给 404。把 `fail` 当失败会让「需求详情」「任务详情」这类端点被误判为不存在。

> 对照证据：`POST /executions/{id}/close` → **404**（真没有）；`POST /bugs/{id}/confirm` → **200 + "Bug does not exist."**（路由在，只是 ID 不存在）。

### 2. 还有第三种「不存在」：伪 200

路由不存在时，请求被**回落到前端路由**，返回 **200 + 登录页 HTML**。
`/testresults`、`/testruns`、`/my/work?mode=project` 都是这种。**只看状态码一定会被骗。**

### 3. 动作端点必须用 POST 验证，GET 会假阳性

`GET /bugs/{id}/confirm` 会被 `/bugs/{id}` 路由吃掉，同样返回 "Bug does not exist."，
看起来像「路由存在」—— 但那是假象。**禅道的动作端点一律是 POST。**

---

## 六、🔵 本轮最大发现：`/my/work` 支持 **13 种** mode

官方 `my` 模块 14 个动作**全部被 max8.5 门槛拒绝**，看起来整块死掉。
但 `/my/work` 是「**一个接口 N 种资源**」的设计 —— `mode` 换一个值就换一种资源。

实测 14 个取值，**13 个支持、只有 `project` 不支持**：

| `mode` | 对应官方 `my` 动作 | 列表字段 | 本项目 | 实测（`your-account`） |
| --- | --- | --- | --- | --- |
| `bug` | `my/bugs` | `bugs` | ✅ 已支持 | 100 条（resolvedBy） |
| `task` | `my/tasks` | `tasks` | ✅ 已支持 | 17 条（openedBy） |
| `story` | `my/stories` | `stories` | ✅ 已支持 | 100 条（resolvedBy） |
| `todo` | `my/todos` | `todos` | ✅ 已支持 | 0 条（该账号无待办） |
| `epic` | `my/epics` | `stories` | ⬜ **可补** | **43 条** |
| `requirement` | `my/requirements` | `stories` | ⬜ **可补** | **28 条** |
| `testtask` | `my/testtasks` | `tasks` | ⬜ **可补** | **11 条** |
| `testcase` | `my/testcases` | `cases` | ⬜ 可补 | 0 条（无数据） |
| `feedback` | `my/feedbacks` | `feedbacks` | ⬜ 可补 | 0 条（无数据） |
| `ticket` | `my/tickets` | `tickets` | ⬜ 可补 | 0 条（无数据） |
| `issue` | `my/issues` | `issues` | ⬜ 可补 | 0 条（无数据） |
| `risk` | `my/risks` | `risks` | ⬜ 可补 | 0 条（无数据） |
| `meeting` | `my/meetings` | `meetings` | ⬜ 可补 | 0 条（无数据） |
| ~~`project`~~ | ~~`my/projects`~~ | — | ❌ 不支持 | **伪 200** |

### ⭐ 已排除「服务端没过滤」的可能（关键验证）

`epic` / `requirement` 返回的键都是 `stories`，`testtask` 返回 `tasks` —— 很像退化成同一份数据。
**实测 ID 集合交集为 0，证明是三张独立的表**：

| 对比 | 结果 | 结论 |
| --- | --- | --- |
| `story`(100条, ID 2002972 段) vs `epic`(43条, ID **1309**) vs `requirement`(28条, ID **1508**) | **交集 0 条** | ✅ 不同实体表，服务端**真按 mode 过滤** |
| `task`(17条, ID **11195**) vs `testtask`(11条, ID **263**) | **交集 0 条** | ✅ 不同实体 |

> 💡 所以「条数为 0」有两种含义，别混：① **mode 不支持**（`project` → 伪 200）；② **mode 支持但本账号无数据**（`testcase` 等 6 个 → 返回了正确的列表键，只是空）。
> 这是本项目记忆里记过的「假阴性」坑。

**移植成本**：`src/utils/myWork.ts` 的 `MyWorkMode` 只是加枚举值 + 列表键映射，**一个工具的参数扩一下就有 9 个新能力**。这是本清单里性价比最高的一项。

---

## 七、移植优先级建议

> 完整的进度跟踪与实施记录见 [porting-candidates.md](./porting-candidates.md)，这里只给排序依据。

| 优先级 | 项目 | 理由 | 成本 |
| --- | --- | --- | --- |
| **P0** | `my` 的 9 个 mode 扩充 | 🔵 官方给不了（全被门槛拒）+ 成本极低（只改枚举） | 极低 |
| **P0** | 测试线三件套：`testcase` 列表/详情 + `testtask` 列表 | 测试同事提 Bug 时追溯来源；列表/详情全有路 | 低 |
| **P1** | `release` 列表/详情 | 发布线完全空白，和 `build` 成对 | 低 |
| **P1** | `productplan` 列表/详情 | 需求排期背景 | 低 |
| **P1** | `issue` / `risk` / `meeting` 列表/详情 | 🔵 官方整模块被门槛拒，REST 全有路 —— **护城河** | 中（三个模块） |
| **P2** | `feedback` / `ticket` 列表/详情 | 反馈/工单线，官方门槛可过、REST 有路 | 中 |
| **P2** | 项目/执行维度查 Bug/Issue/Risk | `/projects\|executions/{id}/bugs\|issues\|risks` 全有路 | 低（扩参数） |
| **P2** | `story` 状态流转（close/change/activate） | POST 动作端点已验证有路 | 中 |
| **P3** | `execution/projectExecutions`、`execution/team` | 🔵 官方 max8.5 被拒，REST 有路 | 低 |
| **P3** | `system` 应用列表、`build` 详情 | 零散补全 | 低 |
| **❌ 不做** | `user/*`、`doc/*`、模块树、`program` 详情、各模块 `delete` | REST 无路或传输层掐断 | — |

---

## 八、怎么重新生成这份对照

线 A/B 是**自动提取**的，线 C 是**实测**的。三套工具都固化在项目的 `zentao-cli-parity` skill 里
（`.workbuddy/skills/zentao-cli-parity/scripts/`），实例升级或官方发版后重跑即可。

### 8.1 线 A + B：取模块与版本门槛

**推荐 —— SDK 内省（P2-17，不需要官方仓库）**：

```powershell
npm run probe:modules-sdk -- --out=.workbuddy/tmp/official-modules-sdk.json
```

直读 `zentao-api` 的 `exportRegistry()` —— 与运行时**同一份注册表**（含 SDK 内置 `override.js` 补丁），
还额外带 `method` / `path` / `type`（**markdown 里没有这三样**）。

**交叉验证 —— md 模式（需自行提供命令参考文件）**：

```powershell
npm run probe:official-modules -- `
  <命令参考文件.md> `
  .workbuddy/tmp/official-modules-md.json `
  --compare=.workbuddy/tmp/official-modules-sdk.json
```

两个模式都输出 `modules=26 actions=229` + `max8.0(本实例可过)=106 max8.5(被拒)=123`。
**2026-09-20 交叉验证：模块/动作数一致、逐动作版本门槛完全一致、门槛统计同为 `106 / 123 / 0`。**

> ⚠️ 阈值口径：本文以 **`max` 版本线**为准（本实例是 MAX8.2）。官方同时标注 `22.0 / biz13.0 / max8.0 / ipd5.0` 四条产品线
> （`22.0` 是开源版那条线，提取器记作 `open`）。
> ⚠️ `229` 是**注册表里的业务动作**数；`probe:cli` 报的 `255` 是 CLI 实际注册的**可执行动作**数（含 `props` 等），两个口径别混。

### 8.2 线 C：实测 REST 端点

```powershell
npm run probe:endpoints -- --out=.workbuddy/tmp/endpoints-all.md --quiet
```

分组跑：`--group=测试`、`--group=地盘`、`--group=维度` 等。

### 8.3 本项目工具清单（两选一）

```powershell
# 静态解析（不用 build、不连禅道，输出 name/title/description/schema 速览）
node .workbuddy/skills/zentao-cli-parity/scripts/extract-our-tools.mjs

# 真客户端列（需先 build；同时校验 outputSchema 完整性，输出结构化 JSON）
npm run verify:live -- --list
```

> ⚠️ `extract-our-tools.mjs` 靠正则解析 `registerTool` 的书写格式，**务必核对总数**（P1 收敛后为 **11**）。

### 8.4 可复现的专项探针

| 脚本（`.workbuddy/skills/zentao-cli-parity/scripts/`） | 干什么 |
| --- | --- |
| `probe-my-work-modes.mjs` | ⭐ `/my/work` 全 mode 扫描 + **数据区分度验证**（ID 交集比对） |
| `probe-my-work-modes.mjs --product=7 --execution=71` | 附带复核详情路由（含用例 ID 双形态） |

```powershell
npm run probe:my-work -- --product=7 --execution=71
```

> 📌 本轮还写了几支**一次性**探针（`.workbuddy/tmp/` 下），用于钉死几个具体结论，
> 它们的逻辑已被吸收进上面两个正式脚本，无需长期维护：
>
> | 一次性脚本 | 当时的用途 | 结论去向 |
> | --- | --- | --- |
> | `probe-work-modes.mjs` / `-v2` / `-v3` | mode 取值扫描 → 区分度验证 | 已固化进 `probe-my-work-modes.mjs` |
> | `probe-final-routes.mjs` | epic/requirement 详情、项目/执行下 issue/risk/meeting | 已写入本文第四节 |
> | `probe-action-post.mjs` | **POST** 验证动作端点（含零变更校验） | 已写入本文第五节第 1 条 |

---

## 附：数据口径备忘

- **229** = 官方「业务操作」总数（不含 `props` / 离线帮助等非业务动作）。
- **106 / 123** = 这 229 个动作按 `max` 版本线，对本实例（MAX8.2）可过 / 被拒。
- **37 / 25** = `probe:endpoints` 的 62 个探测点中，路由存在 / 不存在。
- **13 / 14** = `/my/work` 的 mode 取值中支持 / 总数（`project` 为伪 200）。
- 所有 REST 结论均为**只读 GET** 或**用不存在 ID 的 POST**，无数据变更（每轮均做零变更校验）。

# 移植候选清单：下一步该往本项目加什么

> 实测时间：2026-09-17 · 目标实例：禅道 **MAX8.2** @ `zen.example.com/zentaomax`
> 复现命令：`npm run probe:cli -- --modules=ALL` / `npm run probe:endpoints`
> 相关文档：[完整对照表（官方 26 模块 × 229 动作）](./official-module-parity.md) · [与官方 zentao-cli 的对比](./vs-official-zentao-cli.md)
> 🆕 **全量迁移计划**：[官方全量动作迁移计划（依赖 `zentao-api`，覆盖 229 动作 / 任意版本通用）](./migration-plan-sdk.md)
> —— 该计划的 **P0 已于 2026-09-18 完成**（工具总数 32 → 35，新增通用层三工具）；
> **P1 已于 2026-09-20 完成**（工具 **35 → 11**：24 个「一工具一动作」封装被删，能力全部由通用层承接，
> 只保留 8 个「官方给不了」的实例特有能力）。
> ⚠️ 因此本文件的「下一批候选」清单**大部分已随通用层上线而自动满足** ——
> 凡是通用层能打到的动作，**不必再新增手写工具**；仍值得手写的只有「官方与 SDK 都给不了」的实例级能力。
> 正文里的「26 → 32」「35 个工具」是**各阶段历史数字**，保留原貌。

## TL;DR

判断「该移植什么」的判据**不是**「官方有没有」，而是两条线相交：

1. **这台实例给不给路** —— 官方 229 个业务动作里 **123 个** 被 max8.5 门槛拒绝（CLI 实际注册 255 个可执行动作，差额是 `props`/帮助等非业务项）；62 个端点探测点里 **25 个** 是 404。
2. **本项目缺不缺** —— 09-17 时 26 个工具里需求和版本**完全缺失**（已补上，现 32 个 → P1 后 11 个）；剩余缺口见 🆕 下一批候选。

> ⚠️ 第 1 条只管到「**官方 CLI 层**」。本项目走 REST 直连，**不受官方版本门槛约束** ——
> 所以「官方被拒」的地方往往正是机会（`my` 全部、`bug confirm`、`issue`/`risk`/`meeting`）。
> 完整矩阵见 [official-module-parity.md](./official-module-parity.md)。

结论：**5 个 P0 已落地**（26 → 32 个工具，P1 后收敛为 11），另有 **9 项下一批候选**（见下一节，**多数已由通用层自动满足**），6 类明确别碰。

---

## ✅ 实施进度（2026-09-17 更新）

**P0 五项已全部实现并通过真机验收**，本项目工具数 **26 → 32**。

| # | 候选 | 状态 | 落地位置 | 实测结果 |
| --- | --- | --- | --- | --- |
| 1 | 地盘四合一 | ✅ 已上线 | `zendao_list_my_work`（`src/tools/getMyWork.ts`） | 四种 mode 全部返回正常 |
| 2 | 任务详情 | ✅ 已上线 | `zendao_get_task`（`src/tools/getTask.ts`） | 取回 78 字段任务实体 |
| 3 | 需求查询 | ✅ 已上线 | `zendao_list_stories` / `zendao_get_story`（`src/tools/getStories.ts`） | 产品/项目下各 4 条需求 |
| 4 | 版本列表 | ✅ 已上线 | `zendao_list_builds`（`src/tools/getBuilds.ts`） | 执行 380 下 10 个版本 |
| 5 | 用户字典 | ✅ 已上线 | `zendao_list_users`（`src/tools/getUsers.ts`） | 207 条账号→人名 |
| — | P1 四项 | ⬜ 未开始 | 见第三节 | — |

验收方式：**宿主同款 MCP SDK 起真客户端**调 23 个用例（含 3 个故意的错误分支），
`structuredContent` 全部通过 `outputSchema` 的 ajv 校验；另有 `npm run test:unit` 74/74 通过。

### 🆕 2026-10-09：新增 `zendao_list_my_efforts`（地盘-日志 / 工时）→ 工具数 11 → 12

**不属于「移植官方动作」的范畴** —— 官方注册表里**根本没有 `effort` 模块**
（`zentao-api@0.7.0` SDK 里也搜不到 `effort` / `工时` 字样），
所以这是本项目**自己探出来并打通的实例能力**，走 `GET /api.php/v2/my/effort`
（与网页「地盘 → 日志」同一通路）。

- 服务端**只认 `type` 预设**（`all` / `today` / `yesterday` / `thisweek` / `lastweek` / `thismonth` / `lastmonth`）；
  网页上那个 `date=20261015`、以及 `begin`/`end`/`start`/`dateFrom`… 共 **16 种参数名**经 api.php/v2 **全部被静默忽略**
  → 任意日期区间由本项目**本地过滤**（参数是我们自己加的，不是服务端契约）。
- 分页参数是 **`pageID`**（`page` 会被静默忽略，永远回第一页）；`recPerPage=1000` 一次取回全部（实测 938 条）。
- ⛔ **`POST /my/effort` 会触发服务端 `SQLSTATE[42S22]` DAO 异常** → 只读查询必须用 GET。
- ⚠️ 响应内嵌完整 `user` 对象（含 `password` MD5、`resetToken`）→ 工具只提取 `efforts`，
  并有离线用例专门守着这条线。

验收：离线单测 **19 例**；`npm run verify` → **12 个工具**；`npm test` → **13 套件 / 253 用例全绿**。

完整实现记录见文末 [**八、实施记录**](#八实施记录2026-09-17)。

---

## 🆕 下一批候选（2026-09-18 对照更新）

本轮把官方仓库拉到本地，从 `docs/command-reference.md` 提取了**权威的全量清单**
（26 模块 / 229 个业务动作 / 每个动作的版本门槛），并补测了一批 REST 路由。
完整矩阵见 → **[docs/official-module-parity.md](./official-module-parity.md)**。

> 📌 2026-09-20（P2-17）起这份清单改用 **SDK 内省**取数（`npm run probe:modules-sdk`，
> 直读 `zentao-api` 注册表，**不需要 clone 官方仓库**），并与原 md 模式逐动作比对一致。

**最重要的认知修正**：

> ⚠️ **官方 CLI 的版本门槛，不是本项目的门槛。**
> 官方被 max8.5 拒掉的功能，本项目走 REST 直连照样能做 —— 这批是**最值钱的候选**。

| 优先级 | 候选 | 为什么 | 实测 |
| --- | --- | --- | --- |
| ⭐ **P0** | **`my` 的另外 9 个 mode** | 官方整个 `my` 模块（14 动作）被门槛拒死；`/my/work` 实测**支持 13 种 mode**，只差扩枚举 | `/my/work?mode=epic\|requirement\|testtask\|testcase\|feedback\|ticket\|issue\|risk\|meeting` **全部 ✅** |
| **P0** | 测试线：`testcase` 列表/详情 + `testtask` 列表 | 测试同事提 Bug 时能追溯批次 | `/testcases` ✅ · `/testcases/{数字ID}` ✅ · `/testtasks` ✅ |
| **P1** | `release` 列表/详情 | 发布线**完全空白**，与已有的 `build` 成对 | `/products/{id}/releases` ✅ · `/releases/{id}` ✅ |
| **P1** | `productplan` 列表/详情 | 需求排期背景 | `/products/{id}/productplans` ✅ · `/productplans/{id}` ✅ |
| **P1** | `issue` / `risk` / `meeting` 列表/详情 | 🔵 **官方这三个模块 19 个动作全被门槛拒死**，REST 全有路 —— **护城河** | `/issues` ✅ `/risks` ✅ `/meetings` ✅（含 `projects\|executions/{id}/issues\|risks`） |
| **P2** | `feedback` / `ticket` 列表/详情 | 反馈/工单线 | `/feedbacks` ✅ · `/tickets` ✅ |
| **P2** | `story` 状态流转（close/change/activate） | 需求现在只能读、不能推状态 | POST `/stories/{id}/{action}` ✅ |
| **P2** | `execution/projectExecutions` · `execution/team` | 🔵 官方 max8.5 被拒，REST 有路 | `/projects/{id}/executions` ✅ · `/executions/{id}/team` ✅ |
| **P3** | `system` 应用列表 · `build` 详情 | 零散补全 | `/systems` ✅ · `/builds/{id}` ✅ |

**仍然明确不做**（REST 无路，别浪费时间）：`user/*`（`/users` 404）、`doc/*`（41 个动作全废）、
三个模块树、`program` 详情、`product`/`project`/`execution` 的 `close`（POST **404**）、各模块 `delete`。

⚠️ 另外修正一个旧结论：**`bug confirm` 的 REST 路由其实存在**
（`POST /bugs/{id}/confirm` → 200 + "Bug does not exist."），
它只是被**官方 CLI 的 max8.5 门槛**挡住了 —— 本项目不受此限。

---

## 一、先说判据

官方 CLI 的覆盖面是碾压型的（26 模块 / 255 动作），但**在你这台实例上有一半跑不动**：

| 门槛吃最狠的模块 | 被拒 / 总数 |
| --- | --- |
| `doc` 文档 | 41 / 42 |
| `my` 地盘 | 14 / 15 |
| `project` 项目 | 8 / 13 |
| `meeting` 会议 | 8 / 9 |
| `workflow` 工作流 | 5 / 6 |
| `issue` 问题 | 5 / 6 |

**反过来，「官方被门槛挡死」的地方，正是本项目的机会** —— 因为本项目靠实测摸出了一批
绕过门槛的通路（`/my/work`、动作端点走 POST、`data/upload` 直取附件）。

所以下面的候选清单按「**断链严重程度 × 实现成本**」排序，而不是按官方模块大小排序。

---

## 二、P0：建议现在就做

### 1. ✅ 地盘四合一：我的任务 / 我的需求 / 我的待办

**这是本次探测最大的发现。**

| 项 | 内容 |
| --- | --- |
| 现状缺口 | 只有 `zendao_list_my_bugs`。**「我的任务」根本没有** —— `zendao_list_tasks` 必须传 `executionID`，没有跨执行的「我负责什么」视图 |
| 可用通路 | `GET /my/work?mode=task\|story\|todo&type=assignedTo` —— **实测三个 mode 全部 200** |
| 官方对比 | 官方 `/my/tasks`、`/my/stories`、`/my/todos` **全部 404**，整个 `my` 模块要 max8.5（15 个动作里 14 个被拒）。**官方在你这台上给不了** |
| 实现成本 | **极低** —— `src/utils/myWork.ts` 的 `MyWorkMode` 类型**已经写着** `'bug' \| 'task' \| 'story' \| 'todo'`，只是工具层没用上；`fetchMyWorkBugs` 把 `mode` 参数化即可 |
| 实测数据 | `your-account` 当前：待处理任务 1 条（`todoCount.task=1`），需求 0 条 |

**三个 mode 的返回结构不一样**（实测，实现时注意）：

| mode | 列表字段 | 备注 |
| --- | --- | --- |
| `bug` | `bugs` | 本项目已用 |
| `task` | `tasks` | 额外带 `summary`、`kanbanList` |
| `story` | `stories` | 额外带 `gradeGroup`、`showGrade` |
| `todo` | `todos` | **结构差异最大**：顶层是 `todos` + `date` + `waitCount` / `doingCount`，**没有 `todoCount`** |

⚠️ 三种都仍要走 `extractList` + `restoreDictOrder`（ID 字典顺序会被 JS 吃掉，见 README「禅道 REST API 的五个典型坑」第四条）。

**建议设计**：新增一个 `zendao_list_my_work { mode, type, includeClosed?, page?, limit? }`，
把 `list_my_bugs` 保留为快捷方式（它的 role 回落逻辑更复杂），或直接把 `mode` 加进现有工具。

---

### 2. ✅ `zendao_get_task` —— 任务详情

| 项 | 内容 |
| --- | --- |
| 现状缺口 | 项目记忆里明确记着「**`zendao_get_task` 不存在**」。任务线是断的：能列（`list_tasks`）能建（`create_task`）能改状态，但**拿到 ID 后看不了详情** |
| 可用通路 | `GET /tasks/{taskID}` —— 实测返回 HTTP 200 + `Task does not exist.`（业务失败，**但路由存在**） |
| 实现成本 | 低。照 `getExecution` / `getProduct` 抄一份，注意详情类输出要用**单键容器** `{ task: z.any() }`（README 坑：白名单必炸） |

---

### 3. ✅ 需求查询：`zendao_list_stories` / `zendao_get_story`

| 项 | 内容 |
| --- | --- |
| 现状缺口 | **需求完全缺失**，但断链很硬：`zendao_get_bug` 返回的 `story` 字段是需求 ID，`create_bug` / `update_bug` / `create_task` 都接受 `story` 参数 —— **能填却查不到内容**。修 Bug 时想看需求背景只能去网页 |
| 可用通路 | `GET /products/{id}/stories` ✅ · `GET /projects/{id}/stories` ✅ · `GET /stories/{storyID}` ✅（详情路由存在） |
| **不可用** | `/stories`（全局）404 · `/epics` 404 · `/requirements` 404 · 需求模块树 404 |
| 实现成本 | 中。列表 + 详情两个工具，但字段要实测（story 实体字段不少） |

⚠️ 注意：**没有全局需求列表**，必须带 `productID` 或 `projectID`。

---

### 4. ✅ 版本查询：`zendao_list_builds`

| 项 | 内容 |
| --- | --- |
| 现状缺口 | Bug 的「影响版本」（`openedBuild`）和「解决版本」（`resolvedBuild`）一直是**硬填 `trunk`**（`create_bug` 里就是这么兜底的）。没法选真实版本 |
| 可用通路 | `GET /executions/{id}/builds` ✅ |
| **⭐ 反直觉** | 版本挂在**执行**下，不是产品下：`/products/{id}/builds` **404**，`/projects/{id}/builds` 也 **404** |
| 实现成本 | 低。一个列表工具 |

这也解释了「官方 `build` 模块在 max8.2 上 5/5 全部无门槛」—— 官方用的就是 `/{scope}/{scopeID}/builds`，
而只有 `executions` 这个 scope 在本实例有实现。

---

### 5. ✅ 用户字典：把 `assignedTo` 账号变成人名

| 项 | 内容 |
| --- | --- |
| 现状缺口 | 所有返回里的 `assignedTo` / `openedBy` / `resolvedBy` 都是**账号字符串**（`your-account`），人和名字对不上 |
| 可用通路 | ⚠️ `GET /users` **404**、`GET /users/{id}` **404** —— 官方路径全废 |
| **但** | `/my/work` 的响应里**自带完整用户字典**：`users: {"your-account":"xxx","admin":"admin","caicheng":"xxx", ...}`（实测 207 条），另有 `memberPairs` 106 条 |
| 实现成本 | 低。抓一次缓存住即可 |

**建议**：做一个 `zendao_list_users`，内部走 `/my/work`（任意 mode）取 `users` 字典并缓存。
顺便可以在 Bug/任务列表的输出里加一个可选参数（如 `resolveUserNames: true`）把账号替换成姓名。

---

## 三、P1：有价值，但先想清楚再动

| # | 候选 | 可用通路 | 价值 | 备注 |
| --- | --- | --- | --- | --- |
| 6 | **项目 / 执行维度查 Bug** | `/projects/{id}/bugs` ✅ · `/executions/{id}/bugs` ✅ | 中高 | 现在只能按**产品**查。加上后可以问「这个项目/这个迭代有哪些 Bug」。成本低，可在现有 `list_bugs` 上加 `scope` 支持（`scope` 参数其实已经声明了） |
| 7 | **产品计划 / 发布** | `/products/{id}/productplans` ✅ · `/products/{id}/releases` ✅ | 中 | 计划（`productplans`，**不是** `plans`）和发布记录 |
| 8 | **测试线** | `/testcases`（全局 180 条）✅ · `/testtasks`（全局 188 条）✅ · `/products\|projects\|executions/{id}/testcases\|testtasks` ✅ · `/testcases/{数字ID}` ✅ · `POST /testcases` ✅ · `POST /testtasks` ✅ | 中 | 若团队由测试同事提 Bug，能看到测试单批次会有帮助。⚠️ **能建能查，不能跑** —— 详见下方「测试线实测边界」 |

### 测试线实测边界（2026-09-18 深探）

**能做**（路由实测可用）：

| 能力 | 端点 | 备注 |
| --- | --- | --- |
| 查用例 | `/testcases`（全局）、`/products\|projects\|executions/{id}/testcases` | ⭐ 用例**有**全局入口（180 条），与 `/stories` 不同；列表键 `cases`，是**字典**不是数组 |
| 用例详情 | `/testcases/{数字ID}` | 60 字段，含 `steps` 嵌套步骤树（`group`/`item` 层级 + `expect` 期望、`parent` 指向父步骤）+ `files` |
| 建用例 | `POST /testcases` | 必填 `productID` + `title`；可选 `module`/`story`/`pri`/`type`/`precondition`/`steps`+`expects`+`stepType`（支持嵌套 key 如 `1.1.1`） |
| 查测试单 | `/testtasks`（全局）、`/products\|projects/{id}/testtasks` | 列表键 `tasks`（**字典**），顶层另带 `users` 字典（206 条）、`allSummary`/`pageSummary` |
| 测试单详情 | `/testtasks/{id}` | 31 字段 + `actions` |
| 建测试单 | `POST /testtasks` | 必填 `productID`/`name`/`build`/`begin`/`end` |
| ⭐ 查执行结果 | `/testtasks/{id}/results` | **全实例唯一**能看到「用例跑没跑、结果如何」的入口。见下方⚠️ |

**不能做**：

| 想干的事 | 实测 | 说明 |
| --- | --- | --- |
| **执行用例 / 记录测试结果** | `/testcases/{id}/run`、`/testcases/{id}/results`、`/testruns`、`/testresults` **全无路由** | ❌ 连测 16 次全 404（偶发一次 403 是伪影）。**官方 CLI 同样没有这个动作** —— 26 个模块、255 个动作里没有任何「跑用例」。这条路两边都断 |
| 用例模块树 | `/testcases/modules` **404** | 与官方 `testcase modules`「需 max8.5」**双向印证** |
| 测试单下的用例列表 | `/testtasks/{id}/cases` **恒报 `Task does not exist.`** | ⚠️ 它要的是 **taskID**（「任务下的用例」），不是测试单 ID。用真实测试单 ID 和真实 task ID 试过都不通 |
| 测试单关联版本 | `/testtasks/{id}/builds` **404** | — |

**⚠️ `/testtasks/{id}/results` 的三个反直觉点**（别按名字猜）：

1. **路径里的 `{id}` 被完全忽略** —— 传 `2000279` / `99999999` / `1` / `9` 返回的都是同样的 **2912 条**。它实际是「**全库测试执行结果**」，不是「某个测试单的结果」。
2. **不接受分页** —— `pager` 为 `null`，2912 条一次全吐。（`recPerPage` 传了也没用。）
3. **`type` 筛选真生效** —— `type` ∈ `{all, fail, pass, blocked}`，实测 `all` 2912 / `fail` 330 / `pass` 2557 / `blocked` 25。

结果条目本身很有用：`{ id, run, case, version, caseResult, stepResults[{result, real, files}], lastRunner, date, duration, files }`
—— 即「哪条用例、哪次运行、什么结果、谁跑的、什么时候、耗时、附件」。

**⚠️ 用例 ID 的双形态坑**：列表里 id 是复合形式 `case_2004638`，**原样当路径参数直接 404**；详情必须剥掉 `case_` 前缀用纯数字 `2004638`。（实测 `/testcases/case_2004636` → 404，`/testcases/2004636` → 200。）推测 `lib_xxx` 同理（用例库条目）。

**其它**：用例实体自带只读的执行汇总 —— `lastRunner` / `lastRunDate` / `lastRunResult`（`pass`/`fail`/`blocked`）/ `caseFails` / `results`，所以「这条用例上次跑过没、结果如何」**不用查 results 端点也能看到**。

---

## 四、P2：能用，但大概用不上

`issues`（问题）· `risks`（风险）· `meetings`（会议）· `feedbacks`（反馈）· `tickets`（工单）
—— **实测全部 200 可用**，但都是项目经理 / 客服视角，跟「前端开发修 Bug」这条主线关系不大。

真要做，建议先只做 `issues` + `risks`（项目健康度相关），其余等有明确需求。

> 🔵 **09-18 补充视角**：`issue` / `risk` / `meeting` 这三个模块在**官方 CLI 里是 max8.5 门槛、
> 19 个动作全被拒死**，而本实例 REST 层**全都有路**（含 `projects|executions/{id}/issues|risks`）。
> 也就是说这不是「能用但用不上」，而是「**官方给不了、我们能给**」——
> 价值判断仍取决于业务是否需要，但**它算护城河，不算鸡肋**。
> `my` 侧同理：官方 `my/issues`、`my/risks`、`my/meetings` 全被门槛拒，而 `/my/work?mode=issue|risk|meeting` 都支持。

---

## 五、明确不建议做（实测没有路，别浪费时间）

| 功能 | 实测结果 | 说明 |
| --- | --- | --- |
| **文档 `doc`** | `/doc/my/spaces` **404** | 官方 42 个 doc 动作里 41 个要 max8.5，剩下那 1 个在本实例也没路。**整块放弃** |
| **执行用例 / 记录测试结果** | `/testcases/{id}/run`、`/testcases/{id}/results`、`/testruns`、`/testresults` **全 404**（16 次连测） | ❌ **两边都没有**：REST 无路由，官方 CLI 255 个动作里也没有任何「跑用例」。能做的只有「建用例 + 查用例 + 查全库执行结果」（见 P1-8） |
| 模块树（bug / story / testcase） | `/products/{id}/modules`、`/bug/modules`、`/story/modules`、`/testcases/modules` **全 404** | 现有的 `zendao_list_bug_modules` 是注定打不通的占位 |
| 全局需求 / epic / requirement **列表** | `/stories`、`/epics`、`/requirements` **全 404** | ⚠️ **修正（09-18）**：详情其实**有路** —— `/epics/{id}`、`/requirements/{id}` 实测 ✅（走 story 路由）；「我的」视图也能走 `/my/work?mode=epic\|requirement` ✅。缺的只是全局列表 |
| 项目下任务 | `/projects/{id}/tasks` **404** | 任务只能逐执行查，别指望一次拿全 |
| 项目 / 执行成员 | `/projects/{id}/members`、`/executions/{id}/members` **404** | 用 `/my/work` 的 `memberPairs` 代替 |
| 用户列表（官方路径） | `/users`、`/users/{id}` **404** | 用 `/my/work` 的 `users` 字典代替（见 P0-5） |
| 待办（官方路径） | `/todos` **404** | 用 `/my/work?mode=todo` 代替（见 P0-1） |

---

## 六、怎么加，而不是加什么

几条已经踩出来的约定，动手前先看：

1. **详情类输出一律用单键容器** `{ story: z.any() }`，**不要写字段白名单** —— 禅道实体 40~92 个字段且随版本漂移，白名单必被 ajv 判 `additional properties`，工具一调就 InvalidParams。
2. **列表类记得 `restoreDictOrder`** —— 返回 ID 字典时，整数键的插入顺序在 `JSON.parse` 那刻就丢了，不重排的话列表会被 JS 规范化成升序。
3. **写操作先确认传输层** —— 本实例 PUT/DELETE 被前置服务器掐断。能走 `/{module}/{id}/{action}` 动作端点的就走 POST；不能的显式用 `requestNative()` 报错，**别降级成 POST**（会掉进别的路由，可能建出脏数据）。
4. **别信 `filters` / `browseType`** —— 除了 `/projects` 的 `browseType` 真生效，其余基本被静默忽略。用「放大拉取 + 本地过滤 + 本地分页」。
5. **改完必须 `npm run build`** —— 踩过：`src/` 把 `ZENDTAO_*` 改名成 `ZENTAO_*` 后没重编译，`dist/` 仍是旧拼写。

---

## 七、复现本文所有结论

```bash
# 官方 CLI 在 MAX8.2 上的能力边界（255 个可执行动作 / 132 可用 / 123 被拒）
npm run probe:cli -- --modules=ALL --out=./official.md

# 官方模块 × 动作 × 版本门槛的**全量清单**（229 个业务动作 / 106 可过 / 123 被拒）
# ⭐ 推荐：SDK 内省，不需要 clone 官方仓库（P2-17）
npm run probe:modules-sdk -- --out=.workbuddy/tmp/official-modules-sdk.json
# md 模式仍可用（需先 clone 官方仓库），并可与 sdk 结果交叉验证：
# npm run probe:official-modules -- <命令参考文件.md> \
#   .workbuddy/tmp/official-modules-md.json --compare=.workbuddy/tmp/official-modules-sdk.json

# 本实例 REST 端点可达性矩阵（62 探测点 / 37 有路 / 25 个 404）
npm run probe:endpoints -- --out=./endpoints.md --json=./endpoints.json

# `/my/work` 的 mode 支持性与数据区分度（13 / 14 个 mode 可用）
npm run probe:my-work -- --out=.workbuddy/tmp/my-work-modes.md

# 本项目当前工具清单（需先 npm run build）
npm run probe:tools -- --out=./tools.md
```

全部为只读操作。判定口径与踩坑记录见 `.workbuddy/skills/zentao-cli-parity/SKILL.md`；
官方模块的完整对照矩阵见 [official-module-parity.md](./official-module-parity.md)。

---

## 八、实施记录（2026-09-17）

P0 五项的落地过程与实测新发现。**判据不是「官方有没有」，而是「实例给不给路」** ——
这一节里的每条结论都是在 `zen.example.com/zentaomax`（MAX8.2）上真跑出来的。

### 8.1 交付清单

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 工具 | `src/tools/getMyWork.ts` | `zendao_list_my_work`（mode 切换四种资源） |
| 工具 | `src/tools/getTask.ts` | `zendao_get_task` |
| 工具 | `src/tools/getStories.ts` | `zendao_list_stories` + `zendao_get_story` |
| 工具 | `src/tools/getBuilds.ts` | `zendao_list_builds` |
| 工具 | `src/tools/getUsers.ts` | `zendao_list_users` |
| 底座 | `src/utils/myWork.ts` | 把 `fetchMyWorkBugs` 泛化成 `fetchMyWork(mode)`；新增 `fetchMyWorkUsers()` / `attachUserNames()` |
| 底座 | `src/utils/format.ts` | 新增，`formatHours()`（解决不同接口工时格式不一致） |
| 注册 | `src/tools/index.ts` | 6 个工具 + 对应 input/output schema |
| 脚本 | `.workbuddy/skills/zentao-cli-parity/scripts/verify-tools-live.mjs` | 新增，真机 SDK 验收探针 |

`fetchMyWorkBugs` **保留**为兼容封装（`getMyBugs.ts` 与离线用例依赖它），内部改为调用 `fetchMyWork(client, 'bug', …)`。

### 8.2 实测新发现（都在本文档其他章节没写过）

**① `/my/work` 四种 mode 的真实差异**

| mode | 列表字段 | 顶层额外键 | 备注 |
| --- | --- | --- | --- |
| `bug` | `bugs` | `todoCount` | 顶层也有 `recTotal`，但**恒 0**，真值只在 `pager.recTotal` |
| `task` | `tasks` | `todoCount`、`summary` | `summary` 是页级中文汇总句 |
| `story` | `stories` | `todoCount`、`gradeGroup`、`showGrade` | |
| `todo` | `todos` | `date`、`waitCount`、`doingCount` | **没有 `todoCount`**；`recPerPage` 恒回 1（忽略分页参数） |

⚠️ `summary` 是**页级**统计（原话「本页共 N 个任务」），翻多页时直接展示会被误读成全局总数 ——
工具里加了「（仅第 N 页）」前缀。

**② `/my/work` 的响应自带两份用户字典**

```
users       : { "your-account": "xxx", … }   207 条
memberPairs : { "your-account": "xxx", … }   106 条
```

这是本实例**唯一**能拿到「账号 → 人名」的地方（`/users`、`/users/{id}`、
`/{projects|executions}/{id}/members` 全部 404）。
207 条里只有 106 条填了真实姓名，其余（`admin`、供应商账号）姓名等于账号。

**③ 实体字段规模（决定 outputSchema 只能写容器）**

| 实体 | 字段数 | 取数端点 |
| --- | --- | --- |
| task（详情） | 78 | `GET /tasks/{id}` → `{ status, task, actions }` |
| story（详情） | 83 | `GET /stories/{id}` → `{ status, story, actions }` |
| story（列表） | 80 | `GET /products/{id}/stories` / `/projects/{id}/stories` |
| build | 24 | `GET /executions/{id}/builds` |

再次印证：详情类**必须**用单键容器 `{ task: z.any() }`，白名单必炸。

**④ 版本数据的真实分布**

- 304 个执行中 **121 个**有版本数据（`pager.recTotal` 口径）；
- 但版本集中在**产品 9 / 项目 21（海上风电）**那条线；
- **储能 / 技经项目下没有版本** → 那类 Bug 的 `openedBuild` 继续填 `trunk` 是正确的，不是将就。

**⑤ `estimate` 字段格式在两个接口里不一致（真 bug，已修）**

| 接口 | 实测值 |
| --- | --- |
| `GET /tasks/{id}` | `"40"`（纯数字） |
| `GET /my/work?mode=task` | `"40h"`（**自带单位**） |

直接拼 `` `${estimate}h` `` 会输出 **`40hh`**。新增 `utils/format.ts` 的 `formatHours()` 统一处理，
并顺手修掉了 `zendao_list_tasks` 里的同一个问题。

**⑥ 同账号并发请求会偶发 401**

扫描 304 个执行（并发 8）时出现 5 次 401，客户端自动重新登录后恢复。
说明该实例对同一账号的并发登录较敏感 —— 需要大批量扫描时把并发压到 5 以下，或复用同一 Token。

### 8.3 验收结果

| 项 | 结果 |
| --- | --- |
| 编译 | `npm run build` 通过（tsc 无错） |
| 工具清单 | `tools/list` 返回 **32 个**工具，6 个新增全部在列 |
| 真机 SDK 验收 | **23 / 23 符合预期**（含 3 个故意的错误分支：非法 mode、不存在的任务/需求、缺范围参数） |
| ajv 校验 | 所有用例的 `structuredContent` 均通过 `outputSchema` 校验，无 `InvalidParams` |
| 离线用例 | `npm run test:unit` **74 / 74 通过**（含 ID 字典顺序、附件工具、Bug 动作端点） |

⚠️ 强调一次：**`npm run verify` 看不到 outputSchema 的问题**（它手写 JSON-RPC、不做 ajv 校验）。
改 schema 或新增工具后，用 `verify-tools-live.mjs` 或等价方式起真客户端调一遍才算验收。

### 8.4 已知边界与后续

- **`zendao_list_my_work` 不做「逐产品合并」回落**：那条路只为 Bug 存在（Bug 归属产品）。
  任务/需求/待办没有等价的全库视图，`/my/work` 不可用时如实报错，好过给一份不完整的数据。
- **`resolveUserNames` 默认 `true`**：给列表项**追加** `xxxName` 字段而不覆盖原账号字段，
  这样 `pick` 语义不变、调用方仍能拿到账号（用于回写接口）。
- 仍未做：P1 四项（项目/执行维度查 Bug、产品计划与发布、测试线）；
  `list_my_bugs` 快路的 `orderBy` 透传（见 README「禅道 REST API 的五个典型坑」第四条遗留）。

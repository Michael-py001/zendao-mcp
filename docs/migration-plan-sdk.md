# 官方全量动作迁移计划（26 模块 / 229 动作）

> **目标**：本项目从「32 个手写工具、隐含 max8.2 假设」升级为「覆盖官方全量动作、任意禅道版本与产品线通用」的 MCP 服务器。
> **前提**：官方仓库已 clone 到 `D:\lili\other-projects\zentao-cli`；`zentao-api@0.7.0` 已随 `npm install` 落地。
> **状态**（2026-09-20 对齐真实进度）：✅ **P0 已完成**（2026-09-18，43/43 用例） ·
> ✅ **P1 已完成**（2026-09-20：工具 **35 → 11**，`verify:live` **61/61**、`npm test` **12 套件 / 234 用例全绿**；
> 任务 14 转入 P2） · ⬜ **P2 进行中（已完成 2 / 6）**
> · 所有关键结论均已在实测中验证，证据见文中标注与**第十一 / 十二 / 十三节实施记录**。
>
> ⚠️ **本文是「计划当时」的文档** —— 正文里的「32 个工具」「35 个工具」是**各阶段的历史数字**，
> 保留原貌以记录决策过程。**最终结果**：P1 把工具收敛为 **11 个**（通用层 3 + 手写兜底 8），
> 24 个「一工具一动作」封装被删、能力改由通用层承接。
> 工具现状请看 `README.md` / `MCP-SETUP.md`；**进度**看第六节（每阶段带状态列）与第七节清单。

---

## 零、结论先行

> ### 不要抄代码 —— 直接依赖 `zentao-api@0.7.0`。

主人说「官方代码已经测试过、我们只需要准确迁移」——这个判断是对的，但**结论要比预想的好**：

官方 `zentao-api` 不是一份「每个接口一个函数」的 SDK，而是一个**声明式动作注册表**：

```js
// exportRegistry().bug.actions[0]
{
  name: 'create', minVersion: ['22.0','biz13.0','max8.0','ipd5.0'],
  type: 'create', method: 'post', path: '/bugs', resultType: 'object',
  bodyParams: [ { name:'productID', type:'number', required:true, description:'所属产品' }, … ],
  params: [ … ], pathParams: { … }, resultGetter: 'bugs', pagerGetter: 'pager'
}
```

**路径、参数、类型、必填、中文说明、HTTP 方法、结果提取规则、分页字段、版本门槛、响应归一化、本地过滤/排序/摘取 —— 全在这份注册表里。**

所以「把 229 个动作迁移过来」不需要写 229 个工具，也不需要 port 任何解析逻辑：

| 做法 | 是否要重新测试 | 与官方一致性 |
| --- | --- | --- |
| ❌ 手抄 229 个动作的定义 | 要（抄错了不知道） | 会漂移 |
| ❌ Port `resolve.js` + `prepare-body.js` + `extractResult` | 要（~1500 行搬运） | 会漂移 |
| ✅ **`npm i zentao-api@^0.7.0`** | **不用** | **逐字节相同** |

**而且版本门槛（含 max8.5 的那 123 个动作）不需要任何特殊处理** —— 见第二节。

预计工时：**核心骨架 1 个阶段**（改 1 行 tsconfig + 4 个新文件 + 3 个新工具），不是「迁移 229 个动作」那么大的活。

---

## 一、官方 SDK 的真实结构

### 1.1 规模（实测 `exportRegistry()`）

| 指标 | 数值 |
| --- | --- |
| 模块 | **26** |
| 动作 | **229** |
| 注册表 JSON 体积 | 183 KB |
| 动作类型分布 | `list` 70 · `get` 20 · `create` 52 · `update` 31 · `delete` 29 · `action`(状态流转) 27 |
| 只读 / 写 | **90 / 139** |
| 参数量 | query 241 · body 609 · path 193 |
| 字段名字典 | 26 个模块全覆盖，合计 **1100+ 字段**（`getObjectProps`） |
| 内置 override | **12 处**（见 1.3） |

与 `docs/official-module-parity.md` 从官方 markdown 提取的 `26 / 229` **完全一致** —— 两条独立路径互证。
（**2026-09-20 起**这份清单本身也改为 SDK 内省产出：`npm run probe:modules-sdk`，
见第十三节 13.7；md 模式保留做交叉验证。）

### 1.2 模块与动作全表

| 模块 | 动作数 | max8.5 门槛数 | 动作 |
| --- | --- | --- | --- |
| `user` 用户 | 5 | 0 | list, create, get, update, delete |
| `program` 项目集 | 5 | 0 | list, create, get, update, delete |
| `product` 产品 | 10 | 5 | list, programProducts, create, close, createStoryModule, createBugModule, createTestcaseModule, get, update, delete |
| `project` 项目 | 12 | 8 | list, programProjects, team, projectMembers, create, close, createStory, createBug, createTask, update, delete, members |
| `execution` 执行 | 11 | 6 | list, projectExecutions, team, executionMembers, create, close, createTaskModule, get, update, delete, members |
| `productplan` 产品计划 | 5 | 0 | list, create, get, update, delete |
| `story` 需求 | 12 | 4 | list, modules, create, get, update, updateModule, delete, deleteModule, activate, change, close, getGrades |
| `epic` 业务需求 | 8 | 0 | list, create, get, update, delete, activate, change, close |
| `requirement` 用户需求 | 8 | 0 | list, create, get, update, delete, activate, change, close |
| `bug` Bug | 12 | 4 | list, modules, create, get, update, updateModule, delete, deleteModule, activate, close, confirm, resolve |
| `testcase` 测试用例 | 8 | 3 | list, modules, create, get, update, updateModule, delete, deleteModule |
| `task` 任务 | 12 | 3 | list, modules, create, get, update, updateModule, delete, deleteModule, activate, close, finish, start |
| `issue` 问题 | 5 | 5 | list, projectIssues, executionIssues, create, get |
| `risk` 风险 | 6 | 6 | list, projectRisks, executionRisks, create, get, update |
| `meeting` 会议 | 8 | 8 | list, projectMeetings, executionMeetings, create, get, update, delete, minutes |
| `feedback` 反馈 | 12 | 5 | list, create, createBug, createTicket, createTodo, createStory, createTask, get, update, delete, activate, close |
| `ticket` 工单 | 9 | 2 | list, create, createStory, createBug, get, update, delete, activate, close |
| `system` 应用 | 3 | 0 | list, create, update |
| `build` 版本 | 4 | 0 | list, create, update, delete |
| `testtask` 测试单 | 4 | 0 | list, create, update, delete |
| `release` 发布 | 4 | 0 | list, create, update, delete |
| `file` 附件 | 3 | 1 | create, update, delete |
| `workflow` 工作流 | 5 | 5 | list, getContract, create, update, delete |
| `doc` 文档 | **41** | **41** | mySpaces…deleteModule（空间/库/文档/目录四层 CRUD） |
| `todo` 待办 | 3 | 3 | create, update, delete |
| `my` 地盘 | 14 | 14 | todos, tasks, bugs, stories, epics, requirements, testtasks, projects, feedbacks, tickets, testcases, meetings, issues, risks |

> 注：`doc`(41) + `my`(14) + `issue/risk/meeting/workflow/todo`(27) = **82 个动作在 max8.2 上不可见**，在 8.5+ 上全部自动出现。

### 1.3 内置 override —— 这是「必须依赖它」的核心理由

`dist/modules/override.js`（313 行）在注册表上打了 **12 处**补丁，都是纯业务知识，抄不过来：

- `execution/create` **补充产品字段**（`products` / `plans`）—— 已实测生效
- `story/create|update` **增加 `plan` 字段**、`category` 改 string、**按评审人决定是否进评审流程**
- `bug/confirm` **只回传可写字段**（确认表单会重置缺省字段）
- `bug/confirm` **已关闭 Bug 的指派人是特殊标记**，API 会当账号校验
- `task/create|update` **补充 `parent` 字段**（子任务）
- `file/create` OpenAPI 说 JSON，**实际必须转 multipart/form-data**
- `doc/get` **把文档原始 JSON 快照转成 Markdown**
- `feedback/close` `confirmClose` 是控制器参数，**留在 JSON body 会被误当反馈表字段**
- 另有 `acl` 默认值、里程碑字段、需求层级等

**这些是官方踩坑后写进代码的隐知识。自己 port 一份 = 必然会漏。**

### 1.4 SDK 已经具备、而本项目现在没有的能力

| 能力 | 现在 | 迁移后 |
| --- | --- | --- |
| **实例版本探测** | `GET /system` 手写 | 匿名 `GET /?mode=getconfig`（有 24h 缓存、并发合并） |
| **按版本过滤动作** | ❌ 无（全量硬编码） | ✅ `minVersion` 逐条判定，抛 `E_UNSUPPORTED_ZENTAO_VERSION` |
| **update 的 autoFill** | ❌ 无 | ✅ 先 GET 现值补齐再 PUT，避免未提交字段被清空 |
| **本地过滤/搜索/排序/摘取/限数** | 部分手写 | ✅ `filter` / `search` / `sort` / `pick` / `limit` 全套 |
| **HTML → Markdown** | ❌ 无 | ✅ `convert`（列表）/ `convertSingle`（单条） |
| **请求体组装 + 类型强转** | 手写 | ✅ `resolveActionRequest` + `prepareActionBody` |
| **分页归一化** | 手写 | ✅ `pager: {total, page, recPerPage}` |
| **失败响应归一化** | 手写 | ✅ `status` / `message` / `apiCode` / `raw` |
| **字段名 → 中文** | ❌ 无 | ✅ `getObjectProps()`，1100+ 字段 |

---

## 二、max8.5 的 123 个动作：**不需要特殊处理**

这是主人这次最关心的一点，实测结论非常干净：

> **版本门槛是在「调用时」按「实例自报版本」判定的，不是编译期、也不是我们这层能的。**

实测（`.workbuddy/tmp/tsmod/e2e-live.mjs`，直连本实例）：

```
1. 匿名 getZentaoConfig()          → version: max8.2   （无需登录 ✅）
2. login(account, password)        → OK，token len=32
3. request('bug/list', {scope:'products',scopeID:9}) → status=success, total=769 ✅
   request('task/get',{id:2012808})  → 78 字段 ✅
   request('story/get',{id:2003068}) → 83 字段 ✅
4. request('my/bugs')   → E_UNSUPPORTED_ZENTAO_VERSION （minVersion = max8.5）✅
   request('bug/confirm')→ E_UNSUPPORTED_ZENTAO_VERSION （minVersion = max8.5）✅
5. getModuleNames({version:'max8.2'}) → 过滤后可见 106 个动作
```

**`106` 这个数字与 `docs/porting-candidates.md` 里从官方 markdown 提取的「max8.0 门槛 106」精确吻合** —— 三方互证。

所以：

| 场景 | 结果 | 我们要写的代码 |
| --- | --- | --- |
| 本实例 max8.2 | `my`/`doc`/`todo`/`issue`/`risk`/`meeting`/`workflow` 被门槛拦下，报清晰中文错误 | 翻译错误消息 |
| 别人的 max8.5+ | **同一份构建，229 个动作全部可用** | 零 |
| 别人的开源版 22.x / biz / ipd | `minVersion` 走对应产品线，自动适配 | 零 |

> **关键提醒**：`minVersion` 是四条产品线（`22.x` 开源 / `biz` / `max` / `ipd`），不是只有 max。
> 我们要保证**不把版本写死成 max**，并把 `ZENTAO_VERSION` 作为「`getconfig` 探不到时」的兜底覆盖。

**「迁移 max8.5 动作」的实际工作量 = 把注册表原样带进来 + 不做版本过滤 + 翻译错误消息。**

### 2.1 ⚠️ 一个必须说清的例外：`my` 模块

上面说「门槛会自动放行」，但 `my` 模块这条路**在本实例上是真的没路**，不可混为一谈。实测（绕过 SDK 门槛直打 REST）：

```
/my/bugs      → HTTP 404        /my/tasks    → HTTP 404
/my/stories   → HTTP 404        /my/todos    → HTTP 404
/my/projects  → HTTP 404
/my/work      → 200 success  keys=[title,isBiz,isMax,isIPD,todoCount,bugs,users]
```

**两个结论：**

1. **官方门槛是准确的** —— `my` 模块的 14 个动作走 `/my/<资源>` 路由，在 max8.2 上路由确实不存在。SDK 拦得对，不是误判。
2. **但本项目挖到的 `/my/work?mode=<13种>` 是官方注册表里根本没有的另一条路**，在 max8.2 上照样能用。

> ⭐ **所以手写层的 `zendao_list_my_work` / `zendao_list_my_bugs` 不但不能退役，价值反而更高**：
> 它能在 max8.2 上提供**官方要 max8.5 才给**的能力（「我的 Bug / 任务 / 需求 / 待办 …」）。
> 迁移后的完整能力 = **官方全量 229 个动作 ∪ 官方没有的 `/my/work` 多资源地盘**。

这是本项目相对官方 CLI 的**护城河**，计划里要明确保住（见 3.4）。

---

## 三、架构设计

### 3.1 目标分层

```
┌──────────────────────────────────────────────────────────────┐
│  MCP 工具层                                                   │
│  ├─ 手写层（保留）：32 个，带实例兜底逻辑                      │
│  └─ 通用层（新增）：registry 驱动，覆盖全量 229 动作            │
└───────────────────────┬──────────────────────────────────────┘
                        │  zendao-api 的 request('bug/get', params, {client})
┌───────────────────────▼──────────────────────────────────────┐
│  zentao-api@0.7.0（官方，不改）                                │
│  registry · resolve · prepare-body · extract · 版本门槛 · override │
└───────────────────────┬──────────────────────────────────────┘
                        │  options.client  ← 鸭子类型适配器
┌───────────────────────▼──────────────────────────────────────┐
│  本项目 transport 适配器（新写，~150 行）                       │
│  实现 request(path, opts) + getZentaoConfig()                  │
│  内部复用现有 axios client：401 自动重登、代理、错误中文化、      │
│  PUT/DELETE 被掐断探测、fetchBinary                            │
└───────────────────────┬──────────────────────────────────────┘
                        ▼
                     禅道 REST v2
```

### 3.2 为什么用适配器，而不是全盘换成官方 `ZentaoClient`

官方 `ZentaoClient` 的接口恰好很小，SDK 的 `request()` 只用到两件事：

```ts
interface ClientRequestOptions { method?, body?, bodyType?, responseType?, headers?, query?, signal?, timeout?, insecure? }
client.request(path: string, opts: ClientRequestOptions): Promise<T>
client.getZentaoConfig(opts?): Promise<ServerConfig>   // 需要 .version
```

我们要保留的是这些**现有资产**（官方 client 没有）：

- ✅ **401 自动重登**（并发下本实例偶发 401，我们有重试）
- ✅ **`isMethodRejected()`** —— PUT/DELETE 被传输层掐断的判定（含 `ECONNRESET` / `EPIPE` / 405 / 501）
- ✅ **中文错误消息 + `formatFailMessage()`**（业务失败是 `200 + status:fail`，要和人话对上）
- ✅ **`fetchBinary()`**（附件下载，`zendao_get_bug_attachments` 依赖）
- ✅ **代理处理**（`HTTP_PROXY` 注入 + `NO_PROXY` 白名单）
- ✅ **`normalizeBaseUrl()`**（去 `/index.php`、去尾 `/`）

**反过来，如果全盘换官方 client，这些都要重写，且失去本实例的实战调优。**

### 3.3 通用层工具形态（推荐方案）

```
zendao_modules     发现层：按实例版本列出可用模块 + 动作 + 门槛
zendao_help        定义层：查单个动作的完整参数表（必填/类型/枚举/默认值/中文说明）
zendao_call        执行层：{ module, action, params } → 结果
```

- **3 个工具覆盖 229 个动作**，context 增量 ~1K tokens
- 天然版本自适应：`zendao_modules` 直接反映实例版本决定的能力边界
- LLM 按 `modules → help → call` 三步走，不会瞎猜参数

**为什么不用「一模块一工具」（官方 MCP 的做法，26 个）**：官方那样做，`params` 仍是一个 `z.record()` 松散包，仍然要 `zentao_action_help` 补一次往返。而 26 个工具每个都要在 description 里列出该模块全部动作名 + 说明（官方就是这么写的），**总 context 成本明显高于 3 个工具，但能省下的往返次数是一样的**（都省不掉 help 那一步）。

**为什么不用「一动作一工具」（229 个）**：估算 40–60K tokens 的工具定义，多数模型会出现选择困难。不做。

### 3.4 手写层 32 个工具的去留

**结论：保留，但收敛到「官方做不到」的那几个。**

| 手写工具 | 官方等价动作 | 处置 |
| --- | --- | --- |
| `zendao_get_bug_attachments` | `file/*` 不能下载；且需要魔数校验 + 匿名 URL 拼接 | 🟢 **必须保留**（不可替代） |
| `zendao_list_my_bugs`（全库合并 + `/my/work` 快路） | `my/bugs` 在 8.2 被门槛挡；`bug/list` 必须带 scope | 🟢 **保留**（8.2 上唯一出路） |
| `zendao_list_my_work`（四 mode + 身份字典） | `my/*` 同上 | 🟢 **保留** |
| `zendao_get_bug`（`actions` 历史 + 内嵌截图提取） | `bug/get` 只给纯 JSON | 🟡 保留增强，基础能力改由通用层兜底 |
| `zendao_list_users`（`/my/work` 字典） | `user/list` 在部分实例可用 | 🟡 降级为「字典补充」 |
| 其余 ~26 个（产品/项目/执行/任务/需求/版本/Bug CRUD） | 通用层**完全覆盖** | 🔴 标记 deprecated，或直接替换为 `zendao_call` 等价调用 |

处置后的工具总数取决于决策 3：

| 收敛力度 | 工具数 | 说明 |
| --- | --- | --- |
| **激进（推荐）** | **3–5 + 3 = 6–8 个** | 只留不可替代的，其余全部交给通用层 |
| 保守 | 32 + 3 = 35 个 | 存量全留，通用层作为补充 |

**两个方向的能力上限是一样的：从 26 个动作 → 229 个动作。** 区别只在 context 占用与「两条路做同一件事」的歧义。

> ⚠️ 另需清理：现有 5 个工具的描述里硬编码了「**本实例不可用**」（`update_bug`/`delete_bug`/3 个模块树）。
> 那是 max8.2 的结论，**对 8.5 用户是错的**，迁移时必须改成运行时判定或中性描述。

> ⭐ **护城河清单（迁移后仍不可替代）** —— 这四项不要跟着 deprecated：
>
> 1. `zendao_get_bug_attachments` —— 官方 `file` 模块**不能下载附件**，且我们做了魔数校验 + 匿名 URL 拼接
> 2. `zendao_list_my_work` —— `/my/work` 13 种 mode，**官方注册表里没有这条路**（见 2.1）
> 3. `zendao_list_my_bugs` —— 全库合并（官方 `bug/list` 必须带 `scope`，做不了全库） + `/my/work` 快路
> 4. `zendao_get_bug` —— `actions` 历史 + 内嵌截图正则提取（官方 `bug/get` 只给纯 JSON）



---

## 四、需要主人拍板的 4 个决策

### 决策 1 · 依赖方式

| 方案 | 优点 | 缺点 | 建议 |
| --- | --- | --- | --- |
| **A. `npm i zentao-api@^0.7.0`** | 官方发布、MIT、零漂移、上游修 bug 自动受益、183KB 不进 git | 多一个运行时依赖；ESM-only（已解决，见 5.1） | ✅ **推荐** |
| B. vendor 复制 `dist/` 进 `src/vendor/` | 无外网依赖、完全可控、可现场改 | 官方升级要手动同步；33 个文件进仓库；仍然要处理 ESM | 仅在需要离线分发的场景 |
| C. 只复制 `exportRegistry()` 的 JSON + 自写解析 | 体积最小 | **要把 `resolve`/`prepare-body`/`extract`/`override` 全部重写** → 违背「不重新测试」 | ❌ 不推荐 |

### 决策 2 · 通用层工具形态

- ✅ **推荐：3 工具方案**（`modules` / `help` / `call`），理由见 3.3
- ⬜ 备选：官方同构 26 个模块工具（若希望与官方 CLI 的 MCP 完全对齐）
- ⬜ 备选：3 工具 + 高频动作额外生成强类型工具（折中，工具数会到 ~50）

### 决策 3 · 手写层收敛力度

- ✅ **推荐：激进**（只留 3–5 个不可替代的，其余标记 deprecated）
- ⬜ 保守：32 个全留，通用层作为补充（会有「两条路做同一件事」的歧义）

### 决策 4 · 凭证来源

- ✅ **推荐：`.env` / 环境变量（现状）+ 复用官方 CLI 的 profile store**（`~/.zentao/…`）
  → 已经装了官方 CLI 的同事**零配置**接入，这对「通用项目」很关键
- ⬜ 仅 `.env`（现状）
- ⚠️ **注意**：SDK 的 `persistProfiles` 默认 `false`，**保持关闭** —— 不要让我们的 MCP 偷偷往用户 home 目录写东西。

---

## 五、关键技术障碍与解法（均已实测）

### 5.1 ⚠️ ESM/CJS 互操作 —— 这是唯一的真障碍

- 本项目：`tsc` + `module: "CommonJS"`，`package.json` 无 `type`
- `zentao-api`：`"type": "module"`，`exports` 只有 `import` 条件，**没有 `require`/`default`**

实测结论：

| 尝试 | 结果 |
| --- | --- |
| `require('zentao-api')` | ❌ `ERR_PACKAGE_PATH_NOT_EXPORTED`（Node 24 也一样，exports 明确不给 require） |
| `module: commonjs` + `await import()` | ❌ **tsc 会把 `import()` 降级成 `require()`** → 运行时炸 |
| **`module: node16` + `await import()`** | ✅ **保留真动态 import**，且 CJS 输出无变化 |

**解法（已实测通过）**：`tsconfig.json` 只改两行

```jsonc
{
  "module": "node16",
  "moduleResolution": "node16"
}
```

- ✅ **存量 39 个源文件零改动、零错误编译通过**（已实测 `tsc` exit=0）
- ✅ 输出仍是 CJS（`package.json` 不加 `type`）
- ✅ 相对 import **不需要**补 `.js` 后缀
- ✅ 静态 `import { request } from 'zentao-api'` 会被 TS1479 拦住 —— 这是**好事**，防止踩坑

**产物级证据**（用本项目真实 `tsconfig.json` + 只覆盖 `module`/`moduleResolution`，编译一个含 `await import('zentao-api')` 的文件）：

```js
// 编译产物 —— 注意 `"use strict"` + `Object.defineProperty(exports, ...)`，仍是 CJS
const sdk = await import('zentao-api');   // ✅ 原样保留
// ❌ 产物里没有 Promise.resolve().then(() => require('zentao-api')) 这种降级
```

运行时实测：`require('./产物.js')` 后调用 → **`modules: 26`** ✅（CJS 产物成功加载纯 ESM 依赖）。

**联动影响面** —— `tsconfig.json` 不止 `tsc` 一个消费者，逐项已实测：

| 消费者 | 风险 | 实测 / 说明 |
| --- | --- | --- |
| `npm run build`（tsc） | — | **exit=0，零错误** |
| **jest / ts-jest 29.4.5** | ⚠️ **同源** | `jest.config.js` 的 `globals['ts-jest'].tsconfig` 指向**同一个 `tsconfig.json`**。已核 ts-jest 的 `_overriddenCompilerOptions` **不含 `module`**（不会偷偷改回 CommonJS）→ 会老实用 node16 编译 → **实测全部单测通过**（用例数随阶段增长：P0 74 → P1 188 → P2-15 234，最新见第九节） |
| `npm run dev`（ts-node 10.9.2） | 低 | 该脚本用得少；ts-node 对 `node16` 支持有限，若报错用 `ts-node --compiler-options` 单独覆盖即可 |
| eslint / prettier | 无 | 不解析 `module` 语义 |

> 若哪天要让 jest 用独立配置（比如测试改走 ESM），标准做法是加 `tsconfig.jest.json`（`extends` 主配置 + `module` 改回 `CommonJS`）再让 `jest.config.js` 指过去。**当前不需要** —— 实测同源可直接跑。

### 5.2 类型声明

动态 `import()` 天然带类型。仅在需要 `import type` 时加 resolution-mode 属性：

```ts
import type { ModuleDefinition, ServerConfig } from 'zentao-api' with { 'resolution-mode': 'import' };
```

否则报 `TS1541`。**推荐做法**：统一走 `src/sdk/loader.ts` 的惰性单例，类型从动态 import 推导，全局只此一处特殊处理。

⚠️ **实测发现一处类型缺口**：`getZentaoConfig()`（实现在 `dist/misc/zentao-version.js`）**没有被 `dist/index.d.ts` 导出** → 直接调用会报 `TS2339: Property 'getZentaoConfig' does not exist`。

`index.d.ts` 实际导出面（已核对）：

| 类别 | 导出 |
| --- | --- |
| 客户端 | `ZentaoClient` |
| 执行 | `request`（+ `BuiltinRequestName` / `RequestParamsFor` / `RequestResultFor` 类型） |
| 注册表 | `exportRegistry` / `getModuleNames` / `isModuleName` / `getModule` / `getModuleAction` / `getModuleActionParams` / `getObjectProps` / `defineModuleActions` / `defineModules` / `extendModuleAction` |
| 工具 | `pickFields` / `filterData` / `searchData` / `sortData` / `processData` |
| 错误 | `ERRORS` / `ZentaoError` / `ErrorCode` |
| Profile | `getAllProfiles` / `getProfile` / `addProfile` / `switchProfile` / … |
| 版本 | `BUILD` / `VERSION`（常量，**不是**实例版本探测） |

→ **版本探测**（任务 5）走两条路之一：① `ZentaoClient` 的公开方法（见 `dist/client/index.d.ts`）；② 在 `client-adapter.ts` 里自己匿名 GET `/?mode=getconfig`（官方实现只有几行，且实测**无需登录**）。这条不影响整体方案，只是别指望 `import { getZentaoConfig }`。

### 5.3 启动开销

`await import('zentao-api')` 首次加载 183KB 注册表 + 457KB `generated.js`。做成**惰性单例**（首次调用工具时才加载），MCP 握手不受影响。

### 5.4 实例差异（这是「通用」的另一半）

| 差异 | 本实例 | 别人可能是 | 处理 |
| --- | --- | --- | --- |
| PUT/DELETE | **被传输层掐断** | 正常 | ❌ 不全局禁用；运行时探测 + 明确报错 |
| `getconfig` 匿名可读 | ✅ | 可能被拦 | 降级到 `ZENTAO_VERSION` 环境变量 → 再不行则跳过门槛并告警 |
| 自签证书 | — | 内网常见 | 暴露 `ZENTAO_INSECURE=1`（SDK 原生支持 `insecure`） |
| 认证方式 | account+password | Token / zentaosid | 现有三种都保留 |
| 每页上限 | — | 可能更小 | `ZENTAO_REC_PER_PAGE` 可配 |

---

## 六、分阶段实施

### P0 · 打通骨架（最小可跑闭环）—— ✅ **已完成（2026-09-18）**

| # | 任务 | 完成情况 |
| --- | --- | --- |
| 1 | `npm i zentao-api@^0.7.0` | ✅ 已装；`exports` 确认只有 `types/browser/import`（**无 `require`**，与预期一致） |
| 2 | tsconfig 改 `module`/`moduleResolution` → `node16` | ✅ 两行；存量**零改动编译通过** + **jest 74/74 全过** |
| 3 | `src/sdk/loader.ts` | ✅ 惰性单例；**产物级验证**：`import('zentao-api')` 原样保留、无 `require` 降级 |
| 4 | `src/sdk/client-adapter.ts` | ✅ `request()` + `getZentaoConfig()`；另含 query 序列化（对齐官方 deepObject 风格）、multipart 直通、SDK 错误码转换 |
| 5 | `src/sdk/version.ts` | ✅ 版本探测 + 缓存 + `ZENTAO_VERSION` 兜底 + 门槛判定；匿名 `getconfig` 实测拿到 `max8.2` |
| 6 | `src/sdk/errors.ts` | ✅ 20+ 错误码 → 中文人话 + **可执行的下一步建议** |
| 7 | 通用层 3 个工具 | ✅ 落在 `src/tools/sdkModules.ts` / `sdkHelp.ts` / `sdkCall.ts`（文件名与计划略有出入） |
| 8 | `src/tools/index.ts` 注册 | ✅ 工具总数 32 → **35** |
| 9 | `npm run build` + `npm run verify:live` | ✅ **43/43 全过，0 协议级错误** |

> **计划外新增 1 处**：`src/client.ts` 加了 `requestRaw()` —— 低层原始请求，
> **不判业务状态**（专供 SDK 适配器），同时保留 401 自动重登 / 重试 / 中文错误。
> 没有它，SDK 的 `normalizeResponse()` 就拿不到 `{status:'fail'}` 原文，错误会退化成一句笼统的话。

**P0 完成标志（逐条实测）**：

| 标志 | 实测结果 |
| --- | --- |
| 8.2 实例上 `zendao_modules` 只列出 106 个动作 | ✅ 输出「注册表 26 个模块 / 229 个动作，本实例可用 **106** 个」 |
| `zendao_call('bug','list',…)` 拿到数据 | ✅ 通过 |
| `zendao_call('my','bugs')` 报清晰的中文门槛错误 | ✅ `E_UNSUPPORTED_ZENTAO_VERSION` → 中文说明 + 「用 zendao_modules 查看可用动作」 |

**验收方式**：`npm run verify:live`（真 SDK 客户端 + ajv 校验 `structuredContent`），
用例从 24 个扩到 **43 个**，新增 17 个覆盖通用层（含故意错误分支）。

### P1 · 体验与对齐 —— ✅ **已完成（2026-09-20，任务 14 转入 P2）**

| # | 任务 | 状态 |
| --- | --- | --- |
| 10 | 输出增强：`getObjectProps` 字段名中文化、HTML→Markdown（`convert`） | ✅ 已完成（新增 `src/utils/labels.ts`） |
| 11 | 透传 `filter` / `search` / `sort` / `pick` / `limit` / `autoFill` 到 `zendao_call` | ✅ 已完成（另加 `searchFields`，共 6 个参数） |
| 12 | 清理硬编码「本实例不可用」描述 → 运行时判定 | ✅ 已完成（实际覆盖 **38 处**，多于计划的 5 处） |
| 13 | 手写层收敛（按决策 3 激进方案） | ✅ 已完成：**工具 35 → 11**，24 个「一工具一动作」封装全删 |
| 14 | 写工具真实落库验收（靶子：#82 演示中心） | ➡️ **转入 P2**（写操作真机验收，见下） |

### P2 · 通用化收尾 —— ⬜ **进行中（已完成 5 / 6）**

| # | 任务 | 状态 |
| --- | --- | --- |
| 15 | 凭证多源：`.env` + 环境变量 + 复用官方 CLI profile store（按决策 4） | ✅ **已完成（2026-09-20）** |
| 16 | `README.md` 重写为「通用版」：安装指引 / 多版本支持 / 多站点配置 | ✅ **已完成（2026-09-20）** |
| 17 | 探针升级：`probe:official-modules` 增加 **SDK 内省模式**（不再依赖官方仓库的 markdown） | ✅ **已完成（2026-09-20）** |
| 18 | 文档收敛：`official-module-parity.md` / `porting-candidates.md` / 本文件重新划界 | ✅ **已完成（2026-09-20，12 个文件）** |
| 19 | 探针 7（新）：**全量动作冒烟扫描** —— 按注册表遍历只读动作，产出「本实例兼容性矩阵」 | ✅ **已完成（2026-09-20）** |
| 14 | ⬅️ **自 P1 转入**：写工具真实落库验收（靶子：#82 演示中心） | ⬜ 待开工 |

> **P2 只剩 `14`**（写操作真实落库验收）—— 这是唯一需要**动真实禅道数据**的任务，
> 靶子选在演示中心产品（`#82`），验收时务必按「先建临时对象 → 验 → 清理」来做。
> 另有 `openspec/` 陈旧 spec 待归档（不在 P2 范围）。

---

## 七、通用性检查清单（主人的核心诉求）

迁移完成的定义 = 下面每一条都成立（**最新盘点：10 ✅ / 2 ⬜ 部分达成**，见第十三节）：

| # | 条目 | 状态 |
| --- | --- | --- |
| 1 | 不硬编码实例版本；用 `getZentaoConfig()` 运行时探测，`ZENTAO_VERSION` 兜底 | ✅ `src/sdk/version.ts`：匿名 `?mode=getconfig` + 缓存 + env 覆盖 + 探不到**不阻断** |
| 2 | 不硬编码产品线（`max`）；`minVersion` 覆盖 `22.x` / `biz` / `max` / `ipd` 四条线 | ✅ 判定完全交给 SDK 注册表，本项目不参与 |
| 3 | 不硬编码「PUT/DELETE 不可用」；运行时探测 + 明确报错 | ✅ `src/client.ts` 的 `isMethodRejected()`；文案已中性化为「**部分实例**」 |
| 4 | 不硬编码「本实例只有 4 种 mode」；`my` 14 动作全量暴露 **且** `/my/work` 13 种 mode 继续保留（2.1） | ⬜ **部分达成**：`/my/work` 13 种 mode 实测全通，但只暴露了 4 种（余 9 种待补）；`my/*` 在本实例是**真 404**（SDK 门槛拦得对），8.5+ 实例会自动放行 |
| 5 | 工具描述里不出现任何本实例专属 ID / 结论 | ✅ P1 任务 12（38 处） |
| 6 | `baseUrl` 鲁棒：容忍 `/zentao`、`/zentao/`、`/zentao/index.php`、`/api.php/v2` | ✅ `src/config.ts` 的 `normalizeBaseUrl()` + `apiVersion` 嗅探（写入 `api.php/v2` 也会被剥掉） |
| 7 | 支持自签证书（`insecure`） | ✅ `ZENTAO_INSECURE=1` → SDK `globals.insecure` |
| 8 | 代理可配（`NO_PROXY` 白名单） | ✅ 沿用现有 axios client（`src/client.ts`） |
| 9 | 凭证多源：`.env` / 环境变量 / profile store | ✅ **P2-15 已完成**：优先级 `env-account` → `env-token` → 官方 profile store（**只读**，含 `ZENTAO_CONFIG_FILE` / `ZENTAO_PROFILE` 契约）；⚠️ profile 只带 Token 且有寿命（本实例 4 小时），不可自动续期 |
| 10 | 每页条数、超时、并发上限可配 | ⬜ **部分达成**：`ZENTAO_REC_PER_PAGE` / `ZENTAO_TIMEOUT` ✅；**并发上限仍是代码常量**（`utils/products.ts` `CONCURRENCY=12`、`getBugAttachments` `DOWNLOAD_CONCURRENCY=4`） |
| 11 | **不往用户 home 目录写任何东西**（`persistProfiles` 保持 false） | ✅ `version.ts` 显式声明 `persistProfiles: false`；P2-15 特意**绕开** SDK 的 `getAllProfiles()`（其 `readStore` 会建锁目录），改用 `fs.readFileSync` 裸读 |
| 12 | 安装零门槛：`npm i && npm run build` 即可，不要求用户也 clone 官方仓库 | ✅ 官方能力来自 npm 依赖 `zentao-api@^0.7.0`，183KB 不进 git |

> 剩下 2 项（第 4、10）都不是「没做」，而是**部分达成**：
> 第 4 项的 `/my/work` 另 9 种 mode 已是现成的 `porting-candidates.md` ⭐P0 候选；
> 第 10 项的并发上限若要开放，注意别超过「同账号并发 ≤5」的实测安全线。

---

## 八、风险 / 明确不做的事

| 项 | 说明 |
| --- | --- |
| ⚠️ **「官方已测过」的边界** | 官方逻辑**确实可信，不需要逐动作重测**。但**官方没在「我们这台 8.2 实例」上跑过全量 229 动作** —— 我们已实测到多处 REST 层差异（伪 200、`/my/work` 13 种 mode、PUT/DELETE 被掐）。<br>所以：**不重测「官方逻辑」，但必须扫一遍「本实例兼容性」**（P2 任务 19）。这是把「测试成本」从逐条手测降到一次批量冒烟。 |
| ⚠️ 供应链 | 依赖官方 npm 包（`zentao-api`，作者 Sun Hao @ chandao.com，MIT）。建议锁版本 `^0.7.0` 并在 README 说明来源。 |
| ⚠️ `doc` 模块 41 个动作**全在 max8.5** | 本实例一个都调不了。P0 只做「门槛拦截 + 友好报错」，无法实测 —— 需要 8.5 环境才能验。 |
| ❌ 不做 | 不重写官方解析逻辑；不做方法覆盖（`POST` 冒充 `PUT`）；不全局禁用写操作；不为单个实例写死兼容分支 |
| ❌ 不做 | 不生成 229 个独立工具 |
| ❌ 不做 | 不复刻官方 CLI 的 profile 交互命令（`login`/`logout`/`switch`），除非决策 4 选「复用 profile store」且确有必要 |

---

## 九、验收方式

| 层级 | 手段 | 覆盖 |
| --- | --- | --- |
| 编译 | `npm run build` | 存量零改动（已验证） |
| 结构 | `npm run verify` 的 `tools/list` | 必须正好 **11 个工具**（通用层 3 + 手写层 8） |
| schema | `npm run verify:live` | 新工具 + `outputSchema` ajv 校验（**必须，不能用 `npm run verify`**） |
| 版本自适应 | 真机：`zendao_modules` 应只列 106 个动作 | 门槛过滤正确 |
| 能力 | `npm run verify:live` 增加 `zendao_call` 只读冒烟用例 | 各模块 list/get 各一条 |
| 通用性 | **`npm run probe:smoke`**（P2 任务 19 的全量冒烟矩阵，✅ 已交付） | 90 个只读动作逐个标「本实例可用 / 可用(空) / 门槛拒绝 / 路由不存在 / 参数不可解」→ `docs/instance-compatibility-matrix.md` |
| 凭证 | `tests/unit/profile-store.test.ts` + 真机双向 | store 路径/容错/选择/有效期推算；真机确认「新 token 能打通、过期 token 报错文案正确」 |
| 退化 | `npm test` —— **12 套件 / 234 用例** | 存量不回归（离线为主，4 个套件 / 33 用例连真机但全部只读） |

> ⚠️ **基线已变，别再追旧数字**：P1 删掉了 11 个引用已删工具的旧用例文件，
> `test:unit` 不再是 74、`test:auth` 不再是 100/100。**现在以 `npm test` 全量 234 用例为准**
> （P1 结束时为 188，P2-15 增加 profile store 相关用例后为 234），
> 逐套件的用例数见 `README.md`「测试与验证」。
>
> ⚠️ **两条 verify 别混用**：`npm run verify` 是手写 JSON-RPC、**不做 ajv**，
> 验不出「结构化返回与 `outputSchema` 不匹配」（2026-09-15 那批详情类工具全炸就是这么漏过去的）；
> 改 `outputSchema` / `structuredContent` 必须跑 `npm run verify:live`。

---

## 十、下一步

**P0 / P1 均已完成**（见第六节，实施记录见第十一 / 十二节）。**只剩 P2**：

- ~~**P1 · 体验与对齐**~~ → ✅ 四项完成（`10` 字段中文化 / `11` 参数透传 / `12` 描述中性化 / `13` 工具 35 → 11），
  任务 `14`（写工具落库验收）**转入 P2**。
- **P2 · 通用化收尾（已完成 5 / 6）**，只剩：
  1. `14` **写工具真实落库验收**（唯一需要动真实数据的任务；靶子：演示中心产品 `#82`）
- 已完成：`18` 文档收敛（2026-09-20，12 个文件）、`15` 凭证多源（2026-09-20，含真机双向验收）、
  `19` 全量只读动作冒烟矩阵（2026-09-20，90 个动作实测 → `docs/instance-compatibility-matrix.md`）、
  `17` 探针 SDK 内省（2026-09-20，不再依赖官方仓库 markdown，与 md 模式逐动作一致）、
  `16` README 通用版（2026-09-20，安装指引 / 多站点与多版本 / 坑表述去实例化）。

---

## 十一、实施记录 · P0（2026-09-18）

### 11.1 交付清单

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `package.json` | 改 | 新增依赖 `zentao-api: ^0.7.0` |
| `tsconfig.json` | 改 | `module` / `moduleResolution` → `node16`（**只动这两行**） |
| `src/client.ts` | 改 | 新增 `requestRaw()`（低层原始请求）+ 拦截器支持跳过认证注入 |
| `src/sdk/loader.ts` | 新 | ESM 惰性单例 |
| `src/sdk/client-adapter.ts` | 新 | 鸭子类型传输适配器 |
| `src/sdk/version.ts` | 新 | 版本探测 + SDK 全局策略 |
| `src/sdk/errors.ts` | 新 | SDK 错误码 → 中文 |
| `src/sdk/index.ts` | 新 | `getSdkRuntime()` 统一入口 |
| `src/tools/sdkModules.ts` | 新 | `zendao_modules` |
| `src/tools/sdkHelp.ts` | 新 | `zendao_help` |
| `src/tools/sdkCall.ts` | 新 | `zendao_call` |
| `src/tools/index.ts` | 改 | 注册 3 个新工具 + shapes（工具总数 32 → 35） |
| `.workbuddy/skills/zentao-cli-parity/scripts/verify-tools-live.mjs` | 改 | 冒烟用例 24 → **43** |

### 11.2 实现期踩到的三个坑（都已在代码里注释）

1. **`getModuleActionParams` 返回的参数不能直接喂给 SDK 的 `convert`**
   —— SDK 是以 `(data, params, options)` **三参**调用 `convert` 的。直接传本项目的
   `convertHtmlFields(value, maxDepth = 6)`，第二个形参 `maxDepth` 会收到 `params` 对象，
   深度上限变成 `NaN`（行为不可控）。**必须包一层单参数闭包**。

2. **axios 的 query 序列化与官方不一致**
   —— 官方数组用 `key[0]=v0&key[1]=v1`，axios 默认是 `key[]=v0&key[]=v1`。
   禅道的多值查询参数会解析失败，所以自己实现了 `appendQueryValue`（逐字对齐官方）。

3. **multipart 请求体不能由我们设 `Content-Type`**
   —— 必须让 axios 生成带 `boundary` 的头，否则服务端拒收。适配器里对
   `bodyType: 'raw'`（multipart 走这条）**一律不设** Content-Type。

> 另修一处类型问题：SDK 的全局 `recPerPage` 声明为 `string`（它会进 query），
> 传 `number` 会被 TS 拦下 —— 需显式 `String()`。

### 11.3 验收证据

```
npm run build                 → exit=0
npm run test:unit             → 74/74 通过
npm run verify:live           → 43/43 符合预期，0 协议级错误
zendao_modules                → 「注册表 26 个模块 / 229 个动作，本实例可用 106 个」
zendao_modules {module:"doc"} → 「41 个动作，本实例可用 0 个」（全部标注需 max8.5）
zendao_call my/bugs           → E_UNSUPPORTED_ZENTAO_VERSION + 中文说明 + 下一步建议
```

`106` 与第五节、`docs/official-module-parity.md` 从官方 markdown 独立推算的数字
**三方互证**。

---

## 十二、实施记录 · P1（2026-09-20）

### 12.1 交付清单

| 文件 / 动作 | 性质 | 说明 |
| --- | --- | --- |
| `src/tools/`（15 个文件） | **删** | `getProjects` / `getProjectById` / `createProject` / `getExecutions` / `getTasks` / `createTask` / `updateTaskStatus` / `getProducts` / `getPrograms` / `getStories` / `getBuilds` / `createBug` / `updateBug` / `bugActions` / `bugModules` |
| `src/utils/browse.ts` | **删** | 仅被上述已删文件引用（`filter.ts` 只在注释里提过） |
| `src/tools/index.ts` | 改 | 24 个 `registerTool` 块 + 24 个输入 shape + 14 个输出 shape 一并清除 → **工具总数 35 → 11** |
| `src/utils/labels.ts` | **新** | 包 `getObjectProps` 做小写归一 + 未命中回落；补 Bug 状态 / severity / pri 三个枚举的中文（官方字典没有枚举值中文） |
| `src/tools/sdkCall.ts` | 改 | `filter` 改「逗号 = AND」；`search` 支持数组；新增 `searchFields`；`limit` 口径统一；3 条「静默失效 → 显式告警」；`renderData` 走中文字段名 |
| `src/utils/cache.ts` + `src/types/cache.ts` | 改 | **修掉真 LRU bug**（见 12.2-3） |
| 测试 | **删 / 改** | 删 11 个引用已删工具的旧用例文件；`e2e` / `mcp-server` / `batch-create-tasks` / `network-errors` / `cache` 改写为只读或纯 mock |
| 外部 MCP 测试链 | **删** | 3 个 YAML + 2 个脚本 + 7 个 npm 脚本（整条链已死），`MCP_TESTING_GUIDE.md` / `tests/README.md` 重写 |
| `jest.config.js` / `package.json` | 改 | jest 全部脚本加 `--experimental-vm-modules`（见 12.2-1）；npm 脚本 31 → 24 |
| 文档 | 改 | `README` / `MCP-SETUP` / `official-module-parity` / `vs-official-zentao-cli` / `porting-candidates` / 本文件 / `SKILL.md` / `extract-our-tools.mjs`（12 个文件，＝ **P2-18**） |

**收敛后的 11 个工具**：

- **通用层 3**：`zendao_modules` / `zendao_help` / `zendao_call` —— 覆盖官方 **229 个动作**
- **手写层 8**（官方给不了的能力）：`zendao_list_bugs` / `zendao_get_bug` / `zendao_get_bug_attachments` /
  `zendao_list_my_bugs` / `zendao_list_my_work` / `zendao_get_task` / `zendao_list_users` / `zendao_batch_create_tasks`

> 8 个工具落在 **7 个文件**里 —— `getBugs.ts` 一个文件承载 `list_bugs` + `get_bug`。

### 12.2 实现期踩到的 5 个坑（都已修）

1. **jest 拦住了 ESM 动态 import** —— `src/sdk/loader.ts` 用 `await import('zentao-api')`，
   在 jest 的 VM 里报 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`
   → 所有 jest 脚本前面加 `node --experimental-vm-modules`。

2. **`src/tests/setup.ts` 偷偷改掉了 `ZENTAO_BASE_URL`** —— 它把环境变量硬编码成
   `http://localhost:3000`，**覆盖真实地址** → 连带 `mcp-server.test.ts` 一直失败。
   **删除该 setup**，并把测试从 `src/tests/` 迁到 `tests/`。

3. **缓存「LRU」名不副实** —— `lastAccess: Date.now()` 在同一毫秒内的多次访问会打平，
   淘汰时挑中了**刚被读过**的 key（退化成 FIFO）→ 换成单调递增的 `accessSeq` 计数器。

4. **`network-errors` 测试是「假绿」** —— 直接 mock `client.get` 会**绕过 axios 重试**；
   而假 adapter 若无条件 resolve，HTTP 500 也会被当成功（axios 的 `dispatchRequest`
   **不校验状态码**，是各 adapter 自己调 `settle()` 才 reject）
   → 改为 mock axios 的 `adapter` 并**复刻 `settle()` 语义**。

5. **文案中文化会打断旧断言** —— 字段中文化后 `状态: active` 变成 `状态: 激活`，写死字面量的断言必挂
   → 断言改成**不变量**（不锁死展示值），展示文案改动不再引发假回归。

### 12.3 验收证据

```
npm run build        → exit=0
npm test             → 11 套件 / 188 用例全绿（其中 2 个套件连真机，全部只读）
npm run verify       → exit=0，tools/list 返回 11 个工具
npm run verify:live  → 61/61 符合预期，0 协议级错误（真 MCP 客户端 + ajv 校验 outputSchema）
```

### 12.4 ⚠️ 收敛带来的 3 处能力变化（有意为之）

| 能力 | 收敛前（手写工具层） | 收敛后（通用层） |
| --- | --- | --- |
| `project/list` 默认口径 | 工具层默认只列「进行中」(`browseType=doing`) | **默认返回服务端全量**；要「进行中」显式传 `browseType=doing` |
| `program/list` 过滤 | 工具层过滤 `type === 'program'` + 本地分页 | **交回服务端**（原过滤条件没有官方依据） |
| `xxxName` 人名补齐 | 多个列表工具自动补齐 | **收窄为只在 `list_my_work` / `get_task` 生效**（其余走通用层，字段原样返回） |

> 三条都是同一条原则的副产品：**工具层不再替服务端做决定**。
> 若后续确需恢复，应做成**显式参数**，而不是隐式默认 —— 否则又回到「两条路做同一件事」的歧义。

---

## 十三、实施记录 · P2（2026-09-20）

### 13.1 交付清单（任务 15 · 凭证多源）

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `src/utils/profile-store.ts` | 新 | 官方 CLI profile store 的**只读**访问器（路径解析 / 清洗 / 选择 / 有效期推算） |
| `src/config.ts` | 改 | 优先级 `env-account` → `env-token` → **profile**；站点地址也可从选中 profile 推断；三选一都拿不到时按 `reason` 给**分类报错** |
| `src/client.ts` | 改 | 401 的 hint **按凭证来源分流** —— profile 来源不再误报成「已用账号换取 Token」 |
| `src/index.ts` | 改 | 启动时把「凭证来源」打进日志；profile Token 推算已过期时先打一条 `WARN` |
| `src/types/index.ts` | 改 | `ZenTaoConfig` 增 `credentialSource` / `credentialProfileKey` / `credentialExpiresAt` |
| `tests/unit/profile-store.test.ts` | 新 | 40+ 用例（路径 / 容错 / 选择优先级 / 有效期推算） |
| `tests/auth/auth-config.test.ts` | 改 | 补认证变量隔离（新增来源会打乱原有 env 假设） |
| `.env.example` / `MCP-SETUP.md` / `README.md` | 改 | 三种来源对照 + 有效期说明 + FAQ |

### 13.2 复用的两个官方契约（不自己发明）

| 契约 | 值 | 为什么必须对齐 |
| --- | --- | --- |
| `ZENTAO_CONFIG_FILE` | store 文件路径 | 官方 CLI 认这个变量（`src/config/store.ts` 的 `setConfigPath`），我们也认 → 两边可**共用同一个 store** |
| `profileKey` 格式 | `account@server` | 官方 `findProfileByKey` 的匹配口径，`ZENTAO_PROFILE` 支持 `account@server` / `account` / `account@hostname` 三种写法 |

### 13.3 实现期踩到的 4 个坑（都已修）

1. **别用 SDK 的 `getAllProfiles()`** —— 它的 `readStore` 走 `withProfileFileLock`，**纯读也会** `mkdir ~/.config/zentao/` 并建临时锁目录，违反「不往 home 写任何东西」。改用 `fs.readFileSync` 裸读。
2. **路径口径跟 CLI 不跟 SDK** —— 官方 CLI 用 `os.homedir()`，SDK 用 `HOME ?? USERPROFILE ?? homedir()`，不一致时以 **CLI** 为准（我们复用的是 CLI 写的那个文件）。
3. **`dotenv` 会把删掉的环境变量补回来** —— 验证脚本里「先删 env 再 require」是错的：`config.ts` 加载时跑 `dotenv.config()` 又重新灌入。必须**先 require，再删**。
4. **半填仍是硬报错** —— `ZENTAO_ACCOUNT` 与 `ZENTAO_PASSWORD` 只填一个时，**即使** store 里有可用凭证也照样报错。静默回落会把笔误藏起来，更难查。

### 13.4 ⚠️ 实测发现：profile Token 有寿命，且不可自动续期

本实例 `serverConfig.expiredTime = 14400`（**4 小时**，由签发时刻起算）：

| 观测 | 结果 |
| --- | --- |
| store 里 09-18 签发的 token（两天后使用） | 三个不同端点全部 `401 {"status":"fail","message":"Not allowed"}` |
| 同账号现取的新 token | `200` 正常 |
| 连续两次 login 拿到的 token | **两个可并存**（都返回 200）→ 不存在「后签顶掉前签」 |

结论：**过期是主因**，且 store **不存密码** ⇒ 这条来源**无法自动续期**。
因此实现上做了两件事：启动时若推算出已过期就打 `WARN`（推算不出**不猜**）；401 时给**专门**文案指向「重新 `zentao login`」。

### 13.5 验收证据

```
npm run build        → exit=0
npm test             → 12 套件 / 234 用例全绿
npm run verify       → exit=0，tools/list 返回 11 个工具
npm run verify:live  → 61/61 符合预期，0 协议级错误
真机双向：
  A) 真实 store（已过期）→ source=profile，tokenExpiresAt=2026-09-18T10:47:57Z，报错文案正确指向重新登录
  B) 临时 store（新 token）→ source=profile，站点地址从 profile 推断，verifyConnection=true、GET /products 200
```

> B 用的是 `ZENTAO_CONFIG_FILE` 指向**临时文件** —— 全程**没动**真实 store，也没往 home 写任何东西。

### 13.6 交付清单（任务 19 · 全量只读动作冒烟矩阵）

**动机**（对应第八节那条风险）：官方逻辑可信、不必逐动作重测，但**官方没在「我们这台 8.2 实例」上跑过全量 229 动作**。
把「测试成本」从逐条手测降到**一次批量冒烟**——这就是任务 19。

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `.workbuddy/skills/zentao-cli-parity/scripts/probe-smoke-matrix.mjs` | 新 | 探针 7：按注册表遍历**全部只读动作**，多轮瀑布自动补 path 参数，输出兼容性矩阵 |
| `docs/instance-compatibility-matrix.md` | 新（生成物） | 本实例兼容性矩阵正文（自动生成，**别手改**） |
| `docs/instance-compatibility-matrix.json` | 新（生成物） | 同一次运行的结构化结果（供任务 17 消费） |
| `package.json` | 改 | 新增 `npm run probe:smoke` |
| `README.md` / `MCP-SETUP.md` / `SKILL.md` | 改 | 命令表 + 文档索引 + 脚本 7 章节 |

**两条设计原则**（改动时别破）：① **只跑 `method=get`** ── 写动作一个都不碰，这是能安全对真机跑的前提；
② **不硬编码端点清单** ── 模块 / 动作 / 路径 / 参数全部从 SDK 注册表现读，注册表升级后无需改脚本。

**本实例（MAX8.2）实测 —— 90 个只读动作**：

| 结论 | 数量 | 说明 |
| --- | --- | --- |
| ✅ 可用 | **19** | 真能打 |
| ✅ 可用（空） | 6 | 接口通、本页无数据（**空 ≠ 坏**） |
| 🚫 门槛拒绝 | 59 | `minVersion` 高于本实例 —— **不是缺陷**，换 max8.5+ 即解锁 |
| ❌ 路由不存在 | 3 | 真 404（`user/*`、`program/get`） |
| ⚠️ 参数不可解 | 3 | 父资源为空、拿不到种子 ID（给 ID 即可验） |
| ❌ 其他错误 | 0 | —— |

⇒ **明确「真能打」的动作 = 19 + 6 = 25 个**；59 个门槛拒绝属预期；剩 6 个是**本实例上确定的缺口**。

**实现期踩过并修掉的 5 个假阴性**（写下来防复现，全部会让结论**偏保守/偏乐观**）：

1. 种子只取**第一个** ID → 某产品的子资源全空 → 误判「参数不可解」。**改**：每个资源收最多 5 个候选，空结果换下一个父亲 ID 重试。
2. `countOf` 对空集合 `{data:[]}` 返回 **1** → 假绿「✅ 可用（1条）」。**改**：加 `sawCollection` 标志，空集合判 0。
3. path 参数名 ≠ 模块名（`planID` vs `productplan`、`caseID` vs `testcase`）。**改**：三层兜底 —— 参数前缀 / 路径资源段 / 路径作用域段。
4. 复合 ID `case_74` 原样当路径参数**直接 404**。**改**：`normalizeId()` 剥前缀。
5. 多轮瀑布只重扫**本轮新增** → 错过「后来才可解」的动作。**改**：每轮**重扫全部**目标动作。

**验收证据**：

```
npm run build        → exit=0
npm run probe:smoke  → 90 个只读动作扫描完成，5 轮收敛
                        ✅ 19 / ✅空 6 / 🚫 59 / ❌ 3 / ❌其他 0 / ⚠️参数 3
报告：docs/instance-compatibility-matrix.md（+ 同名 .json）
```

> 探针只发 GET、只读列表与详情，**不改任何禅道数据**；并发默认 4（同账号实测安全线 ≤5）。

### 13.7 交付清单（任务 17 · 探针 SDK 内省模式）

**动机**：「官方全量清单」（26 模块 / 229 动作 / 版本门槛）原先**只能从官方仓库的
`docs/command-reference.md` 提取** —— 也就是要求使用者先 `git clone` 官方仓库。
这与通用性检查清单第 12 条「**安装零门槛、不要求用户也 clone 官方仓库**」直接冲突。

**做法**：给已有提取器加一条 **`sdk` 模式**，直读 npm 依赖 `zentao-api` 的 `exportRegistry()`。

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `scripts/extract-official-modules.mjs` | 改 | 加 `--sdk` / `--md` / `--from` / `--out` / `--compare`；两模式统一输出结构（`schemaVersion: 2`） |
| `package.json` | 改 | 新增 `npm run probe:modules-sdk`（`--sdk` 的别名，开箱即用） |
| `README.md` / `MCP-SETUP.md` / `SKILL.md` / `official-module-parity.md` / `porting-candidates.md` | 改 | 命令表、复现步骤、数据来源全部改为「SDK 内省优先，md 模式做交叉验证」 |

**为什么 `sdk` 模式更权威**：

1. **不需要 clone 官方仓库** —— 定义来自 npm 依赖。
2. **与运行时同一份注册表** —— 含 SDK 内置 `override.js` 补丁（12 处），
   即工具层实际看得到的定义，不会因官方文档改写而漂移。
3. **信息更全** —— 额外带 `method` / `path` / `type`，**markdown 里没有这三样**。

**md 模式不删 —— 留着做交叉验证**（这正是本次升级能自证的地方）：

| 对比项 | md 模式 | sdk 模式 | 结论 |
| --- | --- | --- | --- |
| 模块数 | 26 | 26 | ✅ |
| 动作数 | 229 | 229 | ✅ |
| 逐动作版本门槛 | —— | —— | ✅ **完全一致**（0 处差异） |
| 门槛统计 `max8.0 / max8.5 / 其他 / 无max线` | 106 / 123 / 0 / 0 | 106 / 123 / 0 / 0 | ✅ |

**顺带修掉一个旧缺陷**：md 模式原先的版本正则漏掉了**无字母前缀**的那条线，
导致 `22.0`（开源版）被丢弃、版本字典只剩 `biz/max/ipd`。现在两条线都记作 `open`，
两种模式**都**输出四键 `{open, biz, max, ipd}`。

**验收证据**：

```
npm run probe:modules-sdk -- --out=.workbuddy/tmp/official-modules-sdk.json
  → mode=sdk source=zentao-api@0.7.0 (exportRegistry)
    modules=26 actions=229
    max8.0(本实例可过)=106 max8.5(被拒)=123 其他=0（其中无 max 线=0）

npm run probe:official-modules -- <官方 command-reference.md> <out> \
  --compare=.workbuddy/tmp/official-modules-sdk.json
  → 模块数 26 vs 26 · 动作数 229 vs 229  ✅
    ✅ 逐动作版本门槛完全一致
    门槛统计：106/123/0/0 ／ 106/123/0/0          → exit code 0（有差异时退 2）
```

> `--compare` 只比两模式**都有**的字段（模块名 / 动作名 / 版本门槛）；
> `method` / `path` / `type` 只有 sdk 模式有，不参与比较。
> 本任务**没改 `src/`**，故未重跑 `npm test` / `verify:live`。

### 13.8 交付清单（任务 16 · README 通用版）

**动机**：README 是项目对外的门面。要在别人**换站点、换版本**时都能照着装起来，
就不能让「本实例」的结论占据正文 —— 实例得出的数字只能作为**示例**出现，并指向可复现的实测产物。

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `README.md` | 改 | ① 快速开始升级为**安装指引**（环境要求 / 三步 / 不需要 clone 官方仓库 / 示例输出标注「数字随实例变化」）；② **新增「多站点与多版本」整节**；③ 标题去实例化 |
| `.env.example` | 改 | 补上**已实现但漏记**的 4 个变量（`ZENTAO_INSECURE` / `ZENTAO_REC_PER_PAGE` / `ZENTAO_ATTACHMENT_DIR` / 别名 `ZENTAO_URL`），并补 `ZENTAO_VERSION` 的说明与警示 |
| `MCP-SETUP.md` | 改 | 第六节标题去实例化（`典型坑与实例行为实测`），并说明「哪些是通性、哪些是部署相关」 |
| `docs/porting-candidates.md` | 改 | 两处「见 README 坑四」改为指向新标题 |

**具体做了什么**：

1. **安装指引**：明确 Node ≥ 18、三步（装依赖编译 → 配 `.env` → `npm run verify`）、
   并写明**不需要 clone 任何官方仓库**（P2-17 之后这条才真正成立）。
   `npm run verify` 的示例输出标注「数字随你的实例变化」。
2. **多站点配置**：一张表覆盖「换站点 / 带上下文路径 / 回落 v1 / 自签证书 / 内网 + 代理 /
   前置服务器掐断 PUT-DELETE / 同时连多站点」；点明凭证三源与 `.env.example`。
3. **多版本支持**：讲清「版本探测 → 注册表 `minVersion` 判定 → 门槛报错说人话」三段式，
   给出 `MAX8.2 → 106` / `MAX8.5+ → 229` 的效果表，并重申
   **「官方 CLI 的门槛 ≠ 本项目的门槛」**。
4. **去实例化**：原先的「这个实例的五个隐性坑」→
   **「禅道 REST API 的五个典型坑」**，并在节首说明：五条属**通性**，
   括号里的实测结论来自参考实例，**换实例请以 `probe:smoke` 的兼容性矩阵为准**。
   （这五条本来就大多是 API 通性 —— `filters` 被忽略、分页字段、PUT/DELETE 被掐、
   无全库 Bug 接口、动作表单整体替换，只有「PUT/DELETE 被掐」带明确部署色彩。）
5. **去重**：通用层那节原本也列了一张「实例 → 可用动作数」表，与新的多版本节重复，
   改为一句概述 + 锚点跳转，避免两处各自漂移。

⚠️ **没有动的**：`docs/` 下的分析文档仍以参考实例（MAX8.2）为基准 ——
它们的定位是「实测证据与决策依据」，本来就该锚定一个具体实例；本次只保证 **README 门面通用**。

**验收证据**：

```
（纯文档 + .env.example 改动，不涉及代码路径）
- README 结构：快速开始 / 数据模型 / 认证 / 多站点与多版本 / 可用工具 / 常用命令 /
  项目结构 / 设计说明 / 禅道 REST API 的五个典型坑 / 测试与验证 / 安全 / 许可
- 交叉引用复核：全仓 grep「坑一|坑二|坑三|坑四|坑五|五个隐性坑」—— 除本节叙述外**无残留失效指向**
- `.env.example` 变量覆盖核对：以 `src` 实际读取 / 实现的口径列为 17 项，
  **逐个比对 0 遗漏**（含 `INSECURE` / `REC_PER_PAGE` / `ATTACHMENT_DIR` / `VERSION` / `URL` 别名）
```

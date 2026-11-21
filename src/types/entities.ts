/**
 * ZenTao API 实体类型定义
 */

// 项目实体
export interface IProject {
  id: number;
  name: string;
  code: string;
  status: string;
  begin: string;
  end: string;
  acl?: string;
  whitelist?: string;
  team?: string;
  hasProduct?: string;
  deleted?: string;
  vision?: string;
  displayCards?: string;
  fluidBoard?: string;
  uid?: string;
}

// 任务实体
export interface ITask {
  id: number;
  name: string;
  /** 所属项目 */
  project: number;
  /**
   * 所属执行（迭代 / 阶段 / 看板）。
   * 禅道的任务必须挂在执行下，列表接口也是 `/executions/{executionID}/tasks`，
   * 所以这个字段是任务的核心归属，不是可选项。
   */
  execution?: number;
  module?: number;
  story?: number;
  storyVersion?: number;
  design?: number;
  openedBy?: string;
  openedDate?: string;
  openedVersion?: number;
  assignedTo?: string;
  assignedDate?: string;
  email?: string;
  pri?: number;
  estimate?: number;
  estimateConsumed?: number;
  consumed?: number;
  left?: number;
  deadline?: string;
  estStarted?: string;
  realStarted?: string;
  finishedBy?: string;
  finishedDate?: string;
  status?: string;
  subStatus?: string;
  color?: string;
  confirmed?: number;
  priOrder?: string;
  deleted?: string;
  vision?: string;
  duration?: number;
  autoChangeStatus?: number;
  strict?: number;
  uid?: string;
}

// 执行实体（迭代 sprint / 阶段 stage / 看板 kanban）
// 注意：禅道的任务挂在执行下，所以拿 task 之前通常要先拿到 executionID。
export interface IExecution {
  id: number;
  /** 所属项目 */
  project: number;
  name: string;
  /** sprint 迭代 | stage 阶段 | kanban 看板 */
  type?: string;
  model?: string;
  status?: string;
  subStatus?: string;
  begin?: string;
  end?: string;
  days?: number;
  lifetime?: string;
  attribute?: string;
  parent?: number;
  acl?: string;
  PM?: string;
  PO?: string;
  QD?: string;
  RD?: string;
  milestone?: number;
  deleted?: string;
  vision?: string;
  uid?: string;
}

// 产品实体
export interface IProduct {
  id: number;
  name: string;
  code: string;
  line?: number;
  type?: string;
  status?: string;
  subStatus?: string;
  desc?: string;
  acl?: string;
  whitelist?: string;
  order?: string;
  vision?: string;
  deleted?: string;
  createdBy?: string;
  createdDate?: string;
  createdVersion?: string;
  owner?: string;
  orderBy?: string;
  uid?: string;
}

// 需求实体
export interface IStory {
  id: number;
  product: number;
  branch?: number;
  plan?: string;
  title: string;
  spec?: string;
  verify?: string;
  pri?: number;
  estimate?: number;
  status?: string;
  stage?: string;
  color?: string;
  hl?: number;
  linkBug?: string;
  linkCase?: string;
  childStory?: string;
  duplicateStory?: string;
  confirmStory?: number;
  needNotReview?: string;
  lines?: number;
  order?: string;
  setted?: number;
  deleted?: string;
  vision?: string;
  openedBy?: string;
  openedDate?: string;
  openedVersion?: number;
  assignedTo?: string;
  assignedDate?: string;
  uid?: string;
}

// 用户实体
export interface IUser {
  id: number;
  dept?: number;
  account: string;
  role?: string;
  realname?: string;
  nickname?: string;
  commiter?: string;
  avatar?: string;
  birthday?: string;
  gender?: string;
  score?: number;
  scoreLevel?: number;
  deleted?: string;
  locked?: string;
  join?: string;
  scoreStatus?: string;
  feedback?: string;
  ranzhi?: string;
  scoreList?: string;
  birthright?: string;
  scoreTop?: string;
  ip?: string;
  whitelist?: string;
  groups?: number[];
 visions?: string;
  deletedDate?: string;
  uid?: string;
}

// API 响应格式
export interface IApiResponse<T = any> {
  status: number;
  data: T;
  message?: string;
}

// 分页参数
export interface IPaginationParams {
  page?: number;
  limit?: number;
  orderBy?: string;
}

// 项目查询参数
/**
 * 项目浏览口径（服务端 browseType）。
 *
 * ⚠️ 与 Bug 不同，**项目列表的 browseType 是真正生效的**（实测：all=23 / undone=17 /
 * doing=17 / wait=0 / 乱传=0），所以可以放心交给服务端分页。
 *
 * 语义：`undone` = 未完成（= wait + doing），`wait` = 未开始，`doing` = 进行中。
 * 官方 CLI（`zentao project list`）默认 `undone`，本项目默认 `doing`
 * （对齐禅道网页「项目」菜单的默认视图，见 `getProjects.ts` 说明）。
 */
export type ProjectBrowseType = 'all' | 'undone' | 'wait' | 'doing';

export interface IProjectQueryParams extends IPaginationParams {
  /** 服务端浏览口径，默认 `doing`（进行中）。要全部请传 `all` */
  browseType?: ProjectBrowseType;
  /**
   * 本地精确状态过滤（`wait` / `doing` / `done` / `suspended` / `closed`）。
   *
   * 注意这是**本地**过滤 —— 服务端不认 `status` 参数（实测传 `status=doing` 仍返回全部
   * 23 条，静默失效）。传了它就会把服务端口径放宽为 `all` 以免两级筛选取交集。
   */
  status?: string;
  type?: string;
  acl?: string;
}

// 任务浏览类型（禅道 browseType）——决定列表按什么口径过滤
export type TaskBrowseType =
  | 'all'
  | 'unclosed'
  | 'assignedtome'
  | 'myinvolved'
  | 'assignedbyme';

// 执行浏览类型
export type ExecutionBrowseType = 'all' | 'undone' | 'wait' | 'doing';

// 任务查询参数
export interface ITaskQueryParams extends IPaginationParams {
  /**
   * 所属执行 ID（必填）。
   * 禅道的任务一定挂在某个执行下，列表接口是 `/executions/{executionID}/tasks`，
   * 不存在「全局任务列表」这种东西 —— 所以这个字段是查询的前提。
   */
  executionID: number;
  /** 浏览类型，默认 unclosed（未关闭） */
  browseType?: TaskBrowseType;
}

// 执行查询参数
export interface IExecutionQueryParams extends IPaginationParams {
  /** 只看某个项目下的执行 */
  projectId?: number;
  /** 执行状态过滤，默认 undone（未完成） */
  browseType?: ExecutionBrowseType;
}

// 创建任务参数
// 字段名与禅道 API 2.0 的请求体保持一致，便于直接透传。
export interface ICreateTaskParams {
  /** 任务名称 */
  name: string;
  /** 所属执行 ID（必填）—— 注意不是 project */
  executionID: number;
  /** 任务类型，如 devel / design / test / study / discuss / ui / affair 等 */
  type?: string;
  /** 指派给（账号） */
  assignedTo?: string;
  /** 预计开始（YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss） */
  estStarted?: string;
  /** 截止日期 */
  deadline?: string;
  /** 优先级 1-4，1 最高 */
  pri?: number;
  /** 预计工时 */
  estimate?: number;
  /** 所属模块 ID */
  module?: number;
  /** 相关需求 ID */
  story?: number;
  /** 任务描述（支持 HTML 富文本） */
  desc?: string;
  /** 父任务 ID */
  parent?: number;
}

// 产品查询参数
export interface IProductQueryParams extends IPaginationParams {
  status?: string;
  type?: string;
  line?: number;
}

// 需求查询参数
export interface IStoryQueryParams extends IPaginationParams {
  productId?: number;
  branch?: number;
  status?: string;
  stage?: string;
  pri?: number;
}

// 用户查询参数
export interface IUserQueryParams extends IPaginationParams {
  dept?: number;
  role?: string;
  locked?: string;
}

// 创建项目参数
export interface ICreateProjectParams {
  name: string;
  code: string;
  begin: string;
  end?: string;
  acl?: string;
  whitelist?: string;
  team?: string;
  namePrefix?: string;
  multiply?: number;
  showSupprise?: string;
  needNotReview?: string;
}

// 创建产品参数
export interface ICreateProductParams {
  name: string;
  code: string;
  line?: number;
  type?: string;
  status?: string;
  desc?: string;
  acl?: string;
  whitelist?: string;
  productUnit?: string;
  attribute?: string;
}

// 创建需求参数
export interface ICreateStoryParams {
  product: number;
  branch?: number;
  plan?: number;
  title: string;
  spec?: string;
  verify?: string;
  pri?: number;
  estimate?: number;
  category?: string;
  color?: string;
  tags?: string;
  files?: string;
  mailto?: string;
  uid?: string;
}

// ---------- Bug ----------
// 权威定义来源：官方 SDK easysoft/zentao-api 的 `bug` 模块（共 12 个动作，2026-09-15 对齐）
//   list         GET    /{scope}/{scopeID}/bugs   （scope：products / projects / executions）
//   modules      GET    /products/{productID}/bug/modules     产品的 Bug 模块树
//   create       POST   /bugs
//   get          GET    /bugs/{bugID}
//   update       PUT    /bugs/{bugID}
//   updateModule PUT    /bug/modules/{moduleID}
//   delete       DELETE /bugs/{bugID}
//   deleteModule DELETE /bug/modules/{moduleID}
//   activate     PUT    /bugs/{bugID}/activate
//   close        PUT    /bugs/{bugID}/close
//   confirm      PUT    /bugs/{bugID}/confirm
//   resolve      PUT    /bugs/{bugID}/resolve
// ⚠️ 官方定义的动作是 PUT（不是 POST）。
//
// ⚠️⚠️ 但**本实例的 PUT/DELETE 在 HTTP 层被掐断，且方法覆盖无效**（2026-09-15 实测）。
// 好在主动作端点 `/{module}/{id}/{action}` 在本实例上按**路径**匹配、不校验方法，
// 只要把资源 ID 一并放进 **body**，用 POST 就能正常打到动作处理器。
// 所以 bugActions.ts 里所有动作统一走 POST + `body.bugID`，理由与证据见该文件头部注释。
//
// 可达性（本实例实测，2026-09-15）：
//   可达 ✅  list / create / get / activate / close / confirm / resolve
//   不可达 ❌ update、delete（PUT/DELETE 被传输层掐断，覆盖又无效）
//   不存在 ❌ modules / updateModule / deleteModule（官方要求 22.5/biz13.5/max8.5+，本实例 404）

/** Bug 实体（禅道返回约 70 个字段，这里只声明常用的一部分） */
export interface IBug {
  id: number;
  product: number;
  project?: number;
  execution?: number;
  module?: number;
  plan?: number;
  story?: number;
  task?: number;
  title: string;
  keywords?: string;
  /** 严重程度 1-4，1 最严重 */
  severity?: number;
  /** 优先级 1-4，1 最高 */
  pri?: number;
  /** codeerror 代码错误 / config 配置相关 / install 安装部署 / security 安全相关 等 */
  type?: string;
  os?: string;
  browser?: string;
  /** 重现步骤（富文本，可能含 HTML） */
  steps?: string;
  /** active 激活 / resolved 已解决 / closed 已关闭 */
  status?: string;
  subStatus?: string;
  /** 是否已确认：1 已确认 / 0 未确认 */
  confirmed?: number | string;
  activatedCount?: number;
  /** 影响版本，如 ['trunk'] */
  openedBuild?: string | string[];
  openedBy?: string;
  openedDate?: string;
  /** 指派给。注意：Bug 关闭后禅道会把它置成字符串 "closed" */
  assignedTo?: string;
  assignedDate?: string;
  deadline?: string;
  resolvedBy?: string;
  /** fixed 已解决 / notrepro 无法重现 / bydesign 设计如此 / duplicate 重复 / postponed 延期 等 */
  resolution?: string;
  resolvedBuild?: string;
  resolvedDate?: string;
  closedBy?: string;
  closedDate?: string;
  lastEditedBy?: string;
  lastEditedDate?: string;
  deleted?: string;
  vision?: string;
}

/** Bug 的浏览口径。实测本实例只有 all / unresolved 有明确语义，其余值返回 0 */
export type BugBrowseType = 'all' | 'unresolved' | 'resolved' | 'closed' | 'assignedtome';

/** Bug 的动作（状态流转） */
export type BugActionType = 'resolve' | 'close' | 'activate' | 'confirm';

/** Bug 列表查询参数 */
export interface IBugQueryParams extends IPaginationParams {
  /** Bug 所属范围：products / projects / executions。不传则查全局（数据形态不同，见 response.ts） */
  scope?: 'products' | 'projects' | 'executions';
  /** 范围 ID（产品 ID / 项目 ID / 执行 ID） */
  scopeID?: number;
  browseType?: BugBrowseType;
}

/** 创建 Bug 参数（openedBuild 必填，这是官方定义里的硬性要求） */
export interface ICreateBugParams {
  productID: number;
  title: string;
  /** 影响版本。主干用 'trunk'，其余传版本 ID */
  openedBuild: string[];
  project?: number;
  execution?: number;
  severity?: number;
  pri?: number;
  type?: string;
  steps?: string;
  story?: number;
  assignedTo?: string;
}

/** 更新 Bug 参数（只传要改的字段即可，工具内部会先 GET 现值再合并，避免 PUT 清空） */
export interface IUpdateBugParams {
  bugID: number;
  title?: string;
  severity?: number;
  pri?: number;
  type?: string;
  openedBuild?: string[];
  steps?: string;
  project?: number;
  execution?: number;
  story?: number;
  assignedTo?: string;
}

/** 解决 Bug 参数（resolution 必填） */
export interface IResolveBugParams {
  bugID: number;
  /** fixed 已解决 / notrepro 无法重现 / bydesign 设计如此 / duplicate 重复Bug /
   *  external 外部原因 / postponed 延期处理 / willnotfix 不予解决 / tostory 转为需求 */
  resolution: string;
  resolvedDate?: string;
  resolvedBuild?: string;
  assignedTo?: string;
  comment?: string;
}

/** 关闭 / 激活 Bug 参数 */
export interface ICloseBugParams {
  bugID: number;
  comment?: string;
}

export interface IActivateBugParams {
  bugID: number;
  openedBuild?: string[];
  assignedTo?: string;
  comment?: string;
}

/**
 * 确认 Bug 参数（对齐官方 `bug/confirm` 的请求体字段）。
 *
 * ⚠️ 两条实测经验（2026-09-15，详见 `tools/bugActions.ts`）：
 * 1. 这个表单是**整体替换**语义 —— 只提交 `{bugID}` 会把 `type` / `assignedTo` 等没提交的字段**清空**，
 *    所以工具内部先读当前值再合并（本类型里的字段都是「想改才传」）。
 * 2. `status` 在本实例上**是被强校验的**：不传会报
 *    `『Bug状态』不符合格式，应当为:『/active|resolved|closed/』`。缺省取 Bug 当前状态。
 */
export interface IConfirmBugParams {
  bugID: number;
  /** 指派给（账号）。确认 Bug 通常同时指派 */
  assignedTo?: string;
  /** Bug 类型：codeerror / config / install / security / performance / standard / automation / designdefect / codeimprovement / others */
  type?: string;
  /** 优先级 1-4，1 最高 */
  pri?: number;
  /** 截止日期 (YYYY-MM-DD) */
  deadline?: string;
  /** 状态，取值 active / resolved / closed；缺省用 Bug 当前状态 */
  status?: string;
  /** 抄送给（账号列表） */
  mailto?: string[];
  /** 备注 */
  comment?: string;
}

/** 删除 Bug 参数 */
export interface IDeleteBugParams {
  bugID: number;
}

/** 修改 Bug 模块（官方 `bug/updateModule`，PUT /bug/modules/{moduleID}） */
export interface IUpdateBugModuleParams {
  moduleID: number;
  /** 新模块名 */
  name?: string;
  /** 父模块 ID，0 表示顶层 */
  parent?: number;
}

/** 删除 Bug 模块（官方 `bug/deleteModule`，DELETE /bug/modules/{moduleID}） */
export interface IDeleteBugModuleParams {
  moduleID: number;
}

// ---------- 项目集（program）----------
// 实测：列表可用（GET /programs），但详情端点 /programs/{id} 返回 404，所以只提供列表。

/** 项目集实体 */
export interface IProgram {
  id: number;
  name: string;
  code?: string;
  /** doing / closed 等 */
  status?: string;
  type?: string;
  parent?: number;
  begin?: string;
  end?: string;
  realBegan?: string;
  realEnd?: string;
  /** 进度百分比（字符串形式，如 "97.10"） */
  progress?: string;
  estimate?: number;
  left?: number;
  consumed?: number;
  pri?: string;
  openedBy?: string;
  deleted?: string;
}


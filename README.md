# ZenTao MCP Server

让 AI 客户端（Claude / Cursor / WorkBuddy 等）通过 [MCP](https://modelcontextprotocol.io/) 读写禅道的项目、任务、Bug 和工时。

- **传输**：stdio｜**API**：禅道 API 2.0（可回落 v1）｜**认证**：账号密码自动换 Token，401 自动重换
- **16 个工具**：通用层 3 个由官方 `zentao-api@0.9.3` 注册表驱动（43 模块 × 365 动作，按实例版本自动过滤）；手写 13 个补官方给不了的实例能力

## 安装

在自己的电脑上运行（不用 clone 仓库、不用预装依赖）：

```bash
npx -y @michael_py001/zendao-mcp init
```

交互式填站点地址 / 账号 / 密码，自动检测本机 agent 并写入配置，形如：

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

⚠️ 凭证明文写进 agent 配置，别把含密码的配置提交到 git。安装器会另存一份到 `~/.zendao-mcp/.env`（权限 600）供下次复用；写配置前自动备份、原子替换，JSONC 注释原样保留。

- **自动写入配置（25 个）**：WorkBuddy、Claude Code、Claude Desktop、Cursor、Codex、OpenCode、Gemini CLI、VS Code、Windsurf、Cline、Roo Code、Kilo Code、Zed、GitHub Copilot CLI、Kiro、Continue、Qwen Code、Antigravity、Trae、CodeBuddy、Droid、Augment、Qoder、Devin、Amp
- **另支持 57 个手工配置**：`-a <id>` 选中后打印可复制的命令，不猜路径写文件；`--list-agents` 看全部 ID

```bash
npx -y @michael_py001/zendao-mcp init --dry-run     # 只看计划
npx -y @michael_py001/zendao-mcp init -a cursor -y  # 非交互
npx -y @michael_py001/zendao-mcp doctor             # 检查安装状态
```

启动命令是 `npx -y @michael_py001/zendao-mcp mcp`（`serve` 兼容）。WorkBuddy 需在连接器中心点「信任」。从 1.1.x 升级：重跑 `init` 写新条目，删掉旧的 `zendao` 条目。

## 从源码运行

Node.js ≥ 18：`npm install && npm run build`，复制 `.env.example` 为 `.env` 填凭证，`npm run verify` 自检。

## 能做什么

**通用层（3 个）**：`zendao_modules` 看有哪些动作 → `zendao_help { module, action }` 查参数 → `zendao_call { module, action, params }` 执行。覆盖官方全部 43 模块 / 365 动作，按实例版本自动过滤，不需要编译期适配。

**手写层（13 个）**：

| 场景 | 工具 |
| --- | --- |
| Bug | `zendao_list_bugs`（含全库合并）· `zendao_get_bug` · `zendao_get_bug_attachments` · `zendao_list_my_bugs` |
| 我的地盘 | `zendao_list_my_work`（任务/需求/待办/Bug）· `zendao_list_my_efforts`（工时日志） |
| 任务 / 人员 | `zendao_get_task` · `zendao_list_users` · `zendao_batch_create_tasks` |
| 附件 / 链接 | `zendao_read_attachment`（任意对象附件）· `zendao_link`（生成 / 解析页面 URL） |
| 工时写入 | `zendao_fill_efforts` · `zendao_delete_effort` |

⚠️ **写操作**：`zendao_call`（写类动作）、`zendao_batch_create_tasks`、`zendao_fill_efforts`、`zendao_delete_effort` 会真往禅道写数据；其余只读。填日志默认只预览，`dryRun: false` 才真写。

禅道有两条分层线：**任务挂「执行」下**（要 `executionID`），**Bug 挂「产品」下**（要 `productID`）；没有全局任务列表，全库 Bug 靠逐产品合并。详见 [MCP-SETUP.md](./MCP-SETUP.md)。

## 多站点 / 多版本

改 `ZENTAO_BASE_URL` 即可换站点，同一份构建通用；版本适配在运行时按官方注册表的 `minVersion` 判定，不满足会给人话提示。凭证三源优先级：账号密码 → `ZENTAO_TOKEN` → 官方 CLI 登录态（后者只有 Token、有寿命，不宜长期无人值守）。全部变量见 [`.env.example`](./.env.example)。

## 版本更新

| 版本 | 更新内容 |
| --- | --- |
| **1.3.0**（待发布） | 升级 `zentao-api` 至 0.9.3：官方动作 229 → 365、模块 26 → 43；新增 `zendao_link`（页面链接生成/解析）和 `zendao_read_attachment`（从 URL / HTML / fileID 读取任意对象附件），工具总数 16 个 |
| 1.2.0 | 配置形态改为 `mcp` 子命令 + 凭证明文写入各 agent 的 `env`；`serve` 保留为兼容别名 |
| 1.1.0 | 安装器支持 82 个 agent（25 个自动写入 + 57 个手工指引），写配置时保留 JSONC 注释与尾随逗号 |
| 1.0.0 | 首次发布：`init` 一键安装、`mcp` 启动，凭证明文写入 agent 配置 |

## 文档

- [MCP-SETUP.md](./MCP-SETUP.md) — 接入配置、认证、参数、典型坑与实例行为
- [MCP_TESTING_GUIDE.md](./MCP_TESTING_GUIDE.md) — 验证与测试
- [docs/official-module-parity.md](./docs/official-module-parity.md) — 官方模块 / 动作对照表
- [docs/instance-compatibility-matrix.md](./docs/instance-compatibility-matrix.md) — 实例兼容性矩阵

## 安全与许可

不要提交 `.env`（已在 `.gitignore`）。许可：ISC。

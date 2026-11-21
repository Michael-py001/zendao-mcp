# Project Context

## Purpose
zendao-mcp-server 是一个基于 Model Context Protocol (MCP) 的服务器实现，旨在让 LLM 能够通过标准化的协议操作禅道项目管理系统的 API。该项目为 LLM 和禅道系统之间提供桥梁，实现项目、任务、产品、需求等管理功能的自动化。

## Tech Stack
- **编程语言**: TypeScript
- **运行时**: Node.js
- **HTTP 客户端**: axios
- **MCP 协议**: @modelcontextprotocol/sdk
- **数据验证**: zod (或内置类型检查)
- **配置管理**: dotenv
- **测试框架**: Jest
- **代码规范**: ESLint + Prettier
- **目标系统**: 禅道开源版 21.7 (兼容 18.0+)

## Project Conventions

### Code Style
- 使用 TypeScript strict 模式
- 所有文件和目录使用 kebab-case 命名
- 函数和变量使用 camelCase 命名
- 常量使用 UPPER_SNAKE_CASE 命名
- 接口命名以大写 I 开头 (如 IProject)
- 每个工具函数必须包含 JSDoc 注释
- 所有异步函数必须返回 Promise

### Architecture Patterns
- **分层架构**: 接口层(MCP工具) -> 服务层(业务逻辑) -> 数据层(API客户端)
- **工具模式**: 每个 MCP 工具都是独立的模块
- **缓存模式**: 实现 LRU 缓存机制
- **批量处理**: 支持并发控制和数据聚合
- **错误处理**: 统一错误响应格式

### Testing Strategy
- **单元测试**: 每个工具函数都需要独立的单元测试 (覆盖率 ≥ 80%)
- **集成测试**: 使用真实禅道 API 进行端到端测试
- **Mock 测试**: 模拟网络请求和响应
- **边界测试**: 测试异常情况和错误处理
- **性能测试**: 验证缓存机制和批量操作性能

### Git Workflow
- **分支策略**: 使用 GitHub Flow
- **主分支**: main (受保护，不能直接推送)
- **功能分支**: feature/[功能名称]
- **提交规范**: 使用 Conventional Commits
  - feat: 新功能
  - fix: 修复bug
  - docs: 文档更新
  - refactor: 代码重构
  - test: 测试相关
  - chore: 构建/工具相关
- **代码审查**: 所有 PR 必须经过代码审查
- **自动化**: PR 必须通过 CI/CD 流程

## Domain Context
### 禅道 API 特性
- 基于 RESTful API 设计
- 使用 Token 认证 (zentao session token)
- 支持标准 HTTP 状态码
- 返回 JSON 格式数据
- 支持分页查询 (page、limit 参数)
- 支持字段过滤和排序

### 核心功能模块
1. **项目管理**: 项目创建、查询、更新、状态管理
2. **任务管理**: 任务 CRUD、状态流转、分配管理
3. **产品管理**: 产品管理、产品线操作
4. **需求管理**: 需求创建、评审、状态跟踪
5. **用户管理**: 用户查询、权限验证
6. **批量操作**: 批量创建、更新、删除
7. **缓存机制**: 查询结果缓存、性能优化

### 数据模型
- 项目 (Project): id, name, code, status, begin, end
- 任务 (Task): id, name, project, status, assignedTo, deadline
- 产品 (Product): id, name, code, status, createdDate
- 需求 (Story): id, title, product, status, pri, estimate
- 用户 (User): id, account, realname, dept, role

## Important Constraints
- 必须兼容禅道开源版 18.0+ 所有版本
- 不支持 WebHook 功能 (基于用户需求)
- 不实现禅道原生功能，仅包装 API
- 不处理前端界面
- 使用环境变量存储敏感信息 (token)
- 不记录敏感数据到日志
- 请求频率限制: 默认最多 10 个并发请求
- 缓存大小限制: 默认最多 1000 项缓存
- 不支持实时推送或长连接

## External Dependencies
- **禅道 API**: http://localhost (或其他部署地址)
  - 版本: 开源版 21.7
  - 认证: Token 认证
  - 协议: HTTP/HTTPS
- **MCP 协议**: modelcontextprotocol.io
  - 用于与 LLM 客户端通信
  - 定义工具调用和数据交换格式
- **npm 包**:
  - @modelcontextprotocol/sdk: MCP 协议实现
  - axios: HTTP 请求库
  - dotenv: 环境变量管理
  - zod: 数据验证 (可选)

## Context

ZenTao（禅道）是一个开源的项目管理软件，提供完整的项目管理、产品管理、测试管理、文档管理等功能。它通过 REST API 暴露了所有核心功能，支持第三方系统集成。

本变更旨在创建一个 MCP (Model Context Protocol) 服务器，让 LLM 能够通过标准化的协议操作禅道 API，实现项目管理任务的自动化。

## Goals / Non-Goals

### Goals
- 实现完整的禅道 API MCP 服务器
- 支持项目管理、任务管理、产品管理、需求管理等核心功能
- 提供易用的工具接口，便于 LLM 调用
- 确保代码质量和类型安全
- 提供完整的错误处理和日志记录

### Non-Goals
- 不实现禅道原生功能（仅包装 API）
- 不实现前端界面
- 不处理禅道权限系统内部的复杂逻辑（仅调用 API）
- 不实现复杂的批量操作优化（仅提供基础能力）

## Technical Decisions

### 架构模式
**决策**：采用分层架构设计
- **接口层**：MCP 工具定义层，负责工具注册和协议转换
- **服务层**：业务逻辑层，封装各种操作方法
- **数据层**：API 客户端层，处理 HTTP 请求和响应

**原因**：分层架构便于维护和扩展，每层职责清晰，便于单元测试。

### 技术选型

#### 语言与运行时
**选择**：TypeScript + Node.js
**原因**：
- TypeScript 提供类型安全，减少运行时错误
- 与 MCP 协议高度兼容
- 良好的开发体验和工具支持
- 丰富的生态系统和库

#### HTTP 客户端
**选择**：axios
**原因**：
- Promise 风格的 API，简洁易用
- 优秀的错误处理机制
- 支持请求/响应拦截器
- 活跃的维护和广泛使用

#### MCP 实现
**选择**：基于 @modelcontextprotocol/sdk 实现
**原因**：
- 官方 SDK，协议兼容性最好
- 社区支持度高
- 文档完善
- 便于维护和升级

### API 认证机制
**决策**：支持禅道 Token 认证
**实现**：
```typescript
interface ZenTaoConfig {
  baseUrl: string;
  token: string;
  timeout?: number;
}
```

### 工具设计原则
1. **最小化原则**：每个工具只负责一个明确的功能
2. **幂等性**：相同输入产生相同输出，支持重试
3. **错误处理**：提供详细的错误信息和处理建议
4. **类型安全**：所有参数和返回值都有明确的 TypeScript 类型定义

## Data Model

### 核心实体类型
```typescript
interface Project {
  id: number;
  name: string;
  code: string;
  status: string;
  begin: string;
  end: string;
  // ... 其他字段
}

interface Task {
  id: number;
  name: string;
  project: number;
  status: string;
  assignedTo: string;
  // ... 其他字段
}

interface Product {
  id: number;
  name: string;
  code: string;
  status: string;
  // ... 其他字段
}

interface Story {
  id: number;
  title: string;
  product: number;
  status: string;
  // ... 其他字段
}
```

## Error Handling

### 错误分类
1. **配置错误**：baseUrl 无效、token 缺失等
2. **网络错误**：连接超时、API 不可用等
3. **业务错误**：权限不足、数据验证失败等
4. **API 错误**：禅道返回的错误状态码和消息

### 错误响应格式
```typescript
interface MCPError {
  code: number;
  message: string;
  details?: any;
  hint?: string; // 提供操作建议
}
```

## Testing Strategy

### 单元测试
- 使用 Jest 作为测试框架
- 每个工具函数都需要单元测试
- 模拟 axios 请求，测试各种响应场景
- 测试覆盖率要求 >80%

### 集成测试
- 使用真实的禅道 API（或测试环境）
- 测试完整的工具调用流程
- 验证错误处理机制

### 手动测试
- 验证所有工具功能正常
- 检查文档和示例的正确性
- 测试边界条件和异常场景

## Performance Considerations

- 使用连接池复用 HTTP 连接
- 实现简单的内存缓存机制（避免重复请求）
- 支持请求超时设置
- 控制响应数据大小（分页处理）

## Caching Strategy

### 缓存机制设计
为提高性能，MCP服务器将实现轻量级的内存缓存机制：

#### 缓存策略
- **LRU 缓存**：使用 Node.js Map 实现简单的 LRU 缓存
- **TTL 过期**：每个缓存项设置 TTL（Time To Live）时间
- **大小限制**：限制最大缓存项数量（默认 1000 项）

#### 缓存实现
```typescript
interface CacheItem<T> {
  data: T;
  timestamp: number;
  ttl: number; // 毫秒
}

class LRUCache<K, V> {
  private cache = new Map<K, CacheItem<V>>();
  private maxSize: number;
  private defaultTtl: number;

  constructor(maxSize = 1000, defaultTtl = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.defaultTtl = defaultTtl;
  }

  get(key: K): V | null {
    // 实现 LRU 缓存逻辑
  }

  set(key: K, value: V, ttl?: number): void {
    // 实现 LRU 缓存逻辑
  }
}
```

#### 缓存应用场景
1. **查询类操作**：项目列表、任务列表、产品列表等（TTL: 5分钟）
2. **静态数据**：用户列表、部门列表等（TTL: 30分钟）
3. **详情查询**：单个项目、任务详情（TTL: 10分钟）

#### 缓存管理
- 启动时清理过期缓存
- 提供手动清理缓存的 API
- 支持按类型清理缓存
- 记录缓存命中率和性能指标

## Batch Operations

### 批量操作支持
为提高效率，MCP服务器将提供批量操作功能：

#### 支持的批量操作
1. **批量创建任务** (`batch_create_tasks`)
   - 一次性创建多个任务
   - 支持重复操作跳过机制
   - 返回创建成功/失败的详细报告

2. **批量更新任务状态** (`batch_update_task_status`)
   - 批量更新多个任务的状态
   - 支持批量分配任务负责人
   - 支持批量设置优先级

3. **批量创建项目** (`batch_create_projects`)
   - 批量创建多个项目
   - 支持模板项目复用
   - 自动生成项目代码

4. **批量创建需求** (`batch_create_stories`)
   - 批量创建多个需求
   - 支持批量设置优先级和模块
   - 支持批量关联产品

#### 批量操作实现
```typescript
interface BatchOperation<T> {
  items: T[];
  options: {
    continueOnError?: boolean; // 出错时是否继续
    reportMode?: 'summary' | 'detailed'; // 报告模式
  };
}

interface BatchResult<T> {
  success: number;
  failed: number;
  results: Array<{
    item: T;
    status: 'success' | 'failed';
    id?: number; // 成功时返回 ID
    error?: string; // 失败时返回错误信息
  }>;
}
```

#### 批量操作特点
- **原子性**：支持部分成功/部分失败
- **并发控制**：限制并发请求数，避免对禅道 API 造成压力
- **进度报告**：实时报告批量操作进度
- **错误恢复**：提供失败项目的重试机制

#### 使用示例
```typescript
// 批量创建任务
const result = await batchCreateTasks({
  items: [
    { name: '任务1', project: 1, assignedTo: 'user1' },
    { name: '任务2', project: 1, assignedTo: 'user2' },
  ],
  options: { continueOnError: true, reportMode: 'detailed' }
});
// 返回：{ success: 2, failed: 0, results: [...] }
```

## Security

- Token 存储使用环境变量
- 不在日志中记录敏感信息
- 输入验证和sanitization
- 遵循最小权限原则

## Migration Plan

### 第一阶段：基础设施
- 初始化 TypeScript 项目
- 配置构建脚本和开发环境
- 实现基本的 MCP 服务器框架

### 第二阶段：核心功能
- 实现 API 客户端
- 实现项目管理工具
- 实现任务管理工具

### 第三阶段：扩展功能
- 实现产品管理工具
- 实现需求管理工具
- 实现用户管理工具

### 第四阶段：优化和测试
- 编写测试用例
- 性能优化
- 完善文档和示例

## Risks / Trade-offs

### 风险
1. **禅道 API 变更**：API 版本升级可能引入破坏性变更
   - **缓解**：版本锁定，API 变更时及时更新

2. **认证安全**：Token 泄露风险
   - **缓解**：使用环境变量，不记录日志

3. **API 限制**：禅道可能有请求频率限制
   - **缓解**：实现重试机制和错误处理

### Trade-offs
- **功能完整性 vs 开发速度**：选择先实现核心功能，逐步扩展
- **性能 vs 复杂度**：采用简单有效的方案，避免过度优化
- **错误处理详细程度 vs 性能**：提供有用的错误信息，有助于调试

## Open Questions

经过实际环境测试和需求确认，以下问题已有明确答案：

1. **是否需要支持禅道的 Webhook 功能？**
   - **答案：不需要** - 基于用户反馈，不实现WebHook支持

2. **是否需要实现批量操作功能（如批量创建任务）？**
   - **答案：需要** - 将在MCP服务器中实现批量操作工具，提高效率

3. **如何处理不同版本禅道 API 的兼容性？**
   - **答案：兼容低版本API** - 确保与禅道开源版18.0+的所有版本兼容

4. **是否需要实现缓存机制以提高性能？**
   - **答案：需要** - 实现简单的内存缓存机制，缓存查询结果

## References

- [禅道 API 官方文档](https://www.zentao.net/book/api/setting-369.html)
- [MCP 协议规范](https://modelcontextprotocol.io/)
- [TypeScript 最佳实践](https://typescript-eslint.io/docs/)

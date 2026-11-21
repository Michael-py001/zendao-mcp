/**
 * Jest 测试配置 - 优化版用于 MCP 服务器测试
 */

module.exports = {
  // 预设
  preset: 'ts-jest',

  // 测试环境
  testEnvironment: 'node',

  // 根目录
  roots: ['<rootDir>/src', '<rootDir>/tests'],

  // 测试文件匹配模式
  testMatch: [
    '**/__tests__/**/*.ts',
    '**/?(*.)+(spec|test).ts'
  ],

  // 转换配置
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },

  // 模块文件扩展名
  moduleFileExtensions: [
    'ts',
    'tsx',
    'js',
    'jsx',
    'json',
    'node'
  ],

  // 模块名映射（路径别名）
  // 注意：Jest 的配置项名是 moduleNameMapper，之前写成 moduleNameMapping 是无效项。
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@utils/(.*)$': '<rootDir>/src/utils/$1',
    '^@tools/(.*)$': '<rootDir>/src/tools/$1',
    '^@types/(.*)$': '<rootDir>/src/types/$1'
  },

  // 覆盖率收集
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts', // 入口文件通常不需要测试
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts'
  ],

  // 覆盖率输出目录
  coverageDirectory: 'coverage',

  // 覆盖率报告格式
  coverageReporters: [
    'text',
    'lcov',
    'html',
    'json-summary'
  ],

  // 覆盖率阈值（适当降低以适应实际开发）
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 75,
      lines: 75,
      statements: 75
    }
  },

  // 设置文件
  //
  // ⚠️ 只保留这一个。原先还挂了一个 `<rootDir>/src/tests/setup.ts` 作「备用路径」，
  // 但它会把 process.env.ZENTAO_BASE_URL 硬改成 http://localhost:3000
  // （在 tests/setup.ts 之后执行，等于把真实地址覆盖掉），
  // 导致任何 spawn 子进程的用例连到假地址上 —— 已删除，测试全部迁到 tests/ 下。
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],

  // 测试超时（毫秒）
  testTimeout: 30000,

  // 详细输出
  verbose: true,

  // 清除模拟状态
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  // 错误处理
  errorOnDeprecated: true,

  // 检测打开的句柄（帮助发现资源泄漏）
  detectOpenHandles: true,

  // 最大工作进程数
  maxWorkers: '50%',

  // 最大并发数
  maxConcurrency: 5,

  // 转换忽略模式
  transformIgnorePatterns: [
    'node_modules/(?!(axios)/)'
  ],

  // 全局变量
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json',
      isolatedModules: true
    }
  },

  // 测试环境选项
  testEnvironmentOptions: {
    NODE_ENV: 'test'
  },

  // 报告器配置
  // 如需 JUnit XML 报告（CI 用），先安装依赖：npm i -D jest-junit，
  // 再把下面这行换回 ['jest-junit', { outputDirectory: 'test-results', outputName: 'junit.xml' }]
  reporters: ['default']
};

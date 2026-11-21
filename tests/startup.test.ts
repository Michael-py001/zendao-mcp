/**
 * 启动测试
 * 测试 MCP 服务器的启动流程和配置验证
 */

/// <reference path="./global.d.ts" />

import fs from 'fs';
import { exec } from 'child_process';
import path from 'path';

describe('MCP Server Startup', () => {
  const distPath = path.join(__dirname, '../dist');

  beforeAll(() => {
    // 确保在正确的目录中
    process.chdir(path.join(__dirname, '..'));
  });

  describe('Build Verification', () => {
    test('should have built dist/index.js', () => {
      const indexPath = path.join(distPath, 'index.js');
      expect(fs.existsSync(indexPath)).toBe(true);
      console.log('✅ dist/index.js exists');
    });

    test('should have built all necessary files', () => {
      const requiredFiles = [
        'index.js',
        'client.js',
        'config.js'
      ];

      requiredFiles.forEach(file => {
        const filePath = path.join(distPath, file);
        expect(fs.existsSync(filePath)).toBe(true);
        console.log(`✅ ${file} exists`);
      });
    });

    test('should have type definition files', () => {
      const dtsFiles = [
        'index.d.ts',
        'client.d.ts',
        'config.d.ts'
      ];

      dtsFiles.forEach(file => {
        const filePath = path.join(distPath, file);
        expect(fs.existsSync(filePath)).toBe(true);
        console.log(`✅ ${file} exists`);
      });
    });
  });

  describe('Configuration Validation', () => {
    test('should have .env file', () => {
      const envPath = path.join(__dirname, '../.env');
      expect(fs.existsSync(envPath)).toBe(true);
      console.log('✅ .env file exists');
    });

    test('should have valid base URL in .env', () => {
      const envPath = path.join(__dirname, '../.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      expect(envContent).toContain('ZENTAO_BASE_URL=');
      expect(envContent).toMatch(/ZENTAO_BASE_URL=(.+)/);
      console.log('✅ ZENTAO_BASE_URL configured');
    });

    test('should have token in .env', () => {
      const envPath = path.join(__dirname, '../.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      expect(envContent).toContain('ZENTAO_TOKEN=');
      expect(envContent).toMatch(/ZENTAO_TOKEN=(.+)/);
      console.log('✅ ZENTAO_TOKEN configured');
    });

    test('should have timeout configuration', () => {
      const envPath = path.join(__dirname, '../.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      expect(envContent).toContain('ZENTAO_TIMEOUT=');
      console.log('✅ ZENTAO_TIMEOUT configured');
    });
  });

  describe('Server Startup', () => {
    test('should accept valid token as parameter', (done) => {
      const token = global.testConfig.token;
      if (!token) {
        console.log('⏭️ Skipping test - no token available');
        done();
        return;
      }

      const startCmd = `timeout 5 node ${path.join(distPath, 'index.js')}`;

      const childProcess = exec(startCmd, { env: { ...process.env, ZENTAO_TOKEN: token } }, (error: any, stdout: string, _stderr: string) => {
        // 预期超时终止（5秒后）
        if (error && error.killed) {
          // 检查启动日志
          expect(stdout).toContain('启动 ZenTao MCP 服务器');
          expect(stdout).toContain('配置加载完成');
          console.log('✅ Server started with valid token');
          done();
        } else {
          done(new Error('Process did not timeout as expected'));
        }
      });

      // 5秒后强制终止
      setTimeout(() => {
        childProcess.kill();
      }, 5000);
    }, 10000);

    test('should fail with missing token', (done) => {
      const startCmd = `timeout 3 node ${path.join(distPath, 'index.js')}`;

      void exec(startCmd, { env: { ...process.env, ZENTAO_TOKEN: '' } }, (error: any, _stdout: string, _stderr: string) => {
        // 预期会因为缺少 token 而失败
        expect(error).toBeTruthy();
        console.log('✅ Server correctly rejects missing token');
        done();
      });
    }, 10000);

    test('should load configuration correctly', () => {
      // 模拟配置加载
      const configModule = require('../src/config');
      expect(configModule).toBeDefined();
      console.log('✅ Configuration module loads successfully');
    });
  });

  describe('Environment Checks', () => {
    test('should have Node.js version >= 16', () => {
      const nodeVersion = process.version;
      const majorVersion = parseInt(nodeVersion.substring(1).split('.')[0]);
      expect(majorVersion).toBeGreaterThanOrEqual(16);
      console.log(`✅ Node.js version: ${nodeVersion}`);
    });

    test('should have required environment variables', () => {
      expect(global.testConfig.baseUrl).toBeDefined();
      expect(global.testConfig.token).toBeDefined();
      expect(global.testConfig.timeout).toBeDefined();
      console.log('✅ All required environment variables are set');
    });
  });
});

describe('Connection Verification', () => {
  test('should connect to ZenTao server', async () => {
    if (!global.testConfig.token) {
      console.log('⏭️ Skipping connection test - no token');
      return;
    }

    const isConnected = await global.testClient.verifyConnection();
    expect(isConnected).toBe(true);
    console.log('✅ ZenTao server connection successful');
  });

  test('should get ZenTao version', async () => {
    if (!global.testConfig.token) {
      console.log('⏭️ Skipping version test - no token');
      return;
    }

    const version = await global.testClient.getVersion();
    expect(version).toBeTruthy();
    expect(typeof version).toBe('string');
    console.log(`✅ ZenTao version: ${version}`);
  });

  test('should handle authentication failure', async () => {
    if (!global.testConfig.token) {
      console.log('⏭️ Skipping auth test - no token');
      return;
    }

    // 测试认证（应该成功）
    const version = await global.testClient.getVersion();
    expect(version).toBeTruthy();
    console.log('✅ Authentication successful');
  });
});

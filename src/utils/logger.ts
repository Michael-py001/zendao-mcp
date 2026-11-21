/**
 * 增强的日志工具
 */

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: any;
  error?: Error;
}

export class Logger {
  private level: LogLevel;
  private logHistory: LogEntry[] = [];
  private maxHistorySize: number;

  constructor(level: LogLevel = LogLevel.INFO, maxHistorySize: number = 1000) {
    this.level = level;
    this.maxHistorySize = maxHistorySize;
  }

  debug(message: string, data?: any): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: any): void {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: any): void {
    this.log(LogLevel.WARN, message, data);
  }

  error(message: string, error?: Error | any): void {
    this.log(LogLevel.ERROR, message, undefined, error);
  }

  private log(level: LogLevel, message: string, data?: any, error?: Error): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const timestamp = new Date().toISOString();
    const logEntry: LogEntry = {
      timestamp,
      level,
      message,
      data,
      error: error instanceof Error ? error : undefined
    };

    // 添加到历史记录
    this.addToHistory(logEntry);

    // 格式化输出
    const formattedMessage = this.formatMessage(logEntry);

    switch (level) {
      // 注意：这是 stdio 传输的 MCP 服务器，stdout 是 JSON-RPC 专用通道。
      // 日志必须走 stderr，否则会污染协议流导致客户端解析失败。
      case LogLevel.DEBUG:
        console.error(formattedMessage);
        break;
      case LogLevel.INFO:
        console.error(formattedMessage);
        break;
      case LogLevel.WARN:
        console.warn(formattedMessage);
        break;
      case LogLevel.ERROR:
        console.error(formattedMessage);
        if (error && error.stack) {
          console.error(error.stack);
        }
        break;
    }
  }

  private formatMessage(entry: LogEntry): string {
    const { timestamp, level, message, data } = entry;
    let formatted = `[${timestamp}] [${level}] ${message}`;

    if (data && Object.keys(data).length > 0) {
      formatted += ` | Data: ${JSON.stringify(data)}`;
    }

    if (entry.error) {
      formatted += ` | Error: ${entry.error.message}`;
    }

    return formatted;
  }

  private addToHistory(entry: LogEntry): void {
    this.logHistory.push(entry);
    if (this.logHistory.length > this.maxHistorySize) {
      this.logHistory.shift();
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    const currentLevelIndex = levels.indexOf(this.level);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex >= currentLevelIndex;
  }

  /**
   * 获取最近的日志历史
   */
  getHistory(count?: number): LogEntry[] {
    if (count) {
      return this.logHistory.slice(-count);
    }
    return [...this.logHistory];
  }

  /**
   * 清空日志历史
   */
  clearHistory(): void {
    this.logHistory = [];
  }

  /**
   * 获取指定级别的日志
   */
  getLogsByLevel(level: LogLevel): LogEntry[] {
    return this.logHistory.filter(entry => entry.level === level);
  }

  /**
   * 设置日志级别
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

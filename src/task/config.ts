/**
 * 任务配置
 * 
 * 注意：工具独立配置（timeoutMs, concurrency）已迁移到各工具的 config.ts
 * 此文件仅保留通用默认值和系统级配置
 */

/** 默认超时时间（用于未配置的工具） */
export const DEFAULT_TIMEOUT_MS = parseInt(process.env.TASK_DEFAULT_TIMEOUT_MS || '30000', 10);

/** 默认并发数（用于未配置的工具） */
export const DEFAULT_CONCURRENCY = parseInt(process.env.TASK_DEFAULT_CONCURRENCY || '5', 10);

/** 重试配置 */
export const RETRY_CONFIG = {
    /** 默认最大重试次数 */
    maxRetries: parseInt(process.env.TASK_RETRY_MAX || '2', 10),
    /** 基础延迟（毫秒） */
    baseDelayMs: parseInt(process.env.TASK_RETRY_BASE_DELAY_MS || '1000', 10),
    /** 最大延迟（毫秒） */
    maxDelayMs: parseInt(process.env.TASK_RETRY_MAX_DELAY_MS || '10000', 10),
    /** 可重试的错误关键词 */
    retryableErrors: [
        'TIMEOUT',
        'RATE_LIMIT',
        'ECONNRESET',
        'ETIMEDOUT',
        'ENOTFOUND',
        '429',
        '503',
        '504',
    ],
} as const;

/** 结果缓存时间（毫秒） */
export const CACHE_TTL = parseInt(process.env.TASK_CACHE_TTL_MS || '300000', 10);  // 默认 5 分钟

/** 任务保留时间（毫秒） */
export const TASK_RETENTION = parseInt(process.env.TASK_RETENTION_MS || '1800000', 10);  // 默认 30 分钟

/** 每个用户最大任务数 */
export const MAX_USER_TASKS = parseInt(process.env.TASK_MAX_USER_TASKS || '20', 10);

/** 清理间隔（毫秒） */
export const CLEANUP_INTERVAL = parseInt(process.env.TASK_CLEANUP_INTERVAL_MS || '300000', 10);  // 默认 5 分钟

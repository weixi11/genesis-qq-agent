/**
 * 任务类型定义
 */

/** 任务状态 */
export type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled';

/** 任务优先级 */
export type TaskPriority = 'high' | 'normal' | 'low';

/** 任务对象 */
export interface Task {
    /** 任务唯一ID (UUID) */
    id: string;

    /** 发起用户 */
    userId: number;

    /** 群ID（可选，私聊为空） */
    groupId?: number;

    /** 工具名称 */
    toolName: string;

    /** 工具参数 */
    params: Record<string, unknown>;

    /** 缓存哈希 (用于去重/缓存命中) */
    hash: string;

    /** 任务状态 */
    status: TaskStatus;

    /** 优先级 */
    priority: TaskPriority;

    /** 进度 0-100（可选） */
    progress?: number;

    /** 执行结果 */
    result?: {
        success: boolean;
        text: string;
        data?: unknown;
    };

    /** 错误信息 */
    error?: string;

    /** 创建时间 */
    createdAt: number;

    /** 开始执行时间 */
    startedAt?: number;

    /** 完成时间 */
    finishedAt?: number;

    /** 超时时间（毫秒） */
    timeoutMs: number;

    /** 重试次数 */
    retryCount: number;

    /** 最大重试次数 */
    maxRetries: number;

    /** 下次重试时间 */
    nextRetryAt?: number;

    /** 是否已取消 */
    cancelled: boolean;
}

/** 任务统计 */
export interface TaskStats {
    total: number;
    byStatus: Record<TaskStatus, number>;
    avgDuration: number;
}

/** 队列状态 */
export interface QueueStats {
    queued: number;
    running: number;
    maxConcurrency: number;
}


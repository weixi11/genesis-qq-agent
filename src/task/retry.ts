/**
 * 重试处理器 - 处理任务失败后的重试逻辑
 */

import { log } from '../logger.js';
import type { Task } from './types.js';
import { RETRY_CONFIG } from './config.js';

/**
 * 判断是否应该重试
 */
export function shouldRetry(task: Task, error: string): boolean {
    // 已取消的任务不重试
    if (task.cancelled) {
        return false;
    }

    // 检查是否超过最大重试次数
    if (task.retryCount >= task.maxRetries) {
        log.debug(`🚫 任务已达最大重试次数: ${task.toolName} (${task.retryCount}/${task.maxRetries})`);
        return false;
    }

    // 检查是否是可重试错误
    const isRetryable = RETRY_CONFIG.retryableErrors.some(
        keyword => error.toUpperCase().includes(keyword)
    );

    if (isRetryable) {
        log.debug(`✓ 错误可重试: "${error.slice(0, 50)}..."`);
    }

    return isRetryable;
}

/**
 * 计算重试延迟（指数退避）
 */
export function calculateRetryDelay(retryCount: number): number {
    // 指数退避: 1s, 2s, 4s, 8s... 最大 10s
    const delay = Math.min(
        RETRY_CONFIG.baseDelayMs * Math.pow(2, retryCount),
        RETRY_CONFIG.maxDelayMs
    );
    return delay;
}

/**
 * 准备任务重试
 */
export function prepareRetry(task: Task): void {
    task.retryCount++;
    task.status = 'pending';
    task.startedAt = undefined;
    task.finishedAt = undefined;
    task.error = undefined;
    task.result = undefined;
    task.nextRetryAt = Date.now() + calculateRetryDelay(task.retryCount);

    log.info(`🔄 任务将重试 (${task.retryCount}/${task.maxRetries}): ${task.toolName} (${task.id.slice(0, 8)}), 延迟 ${calculateRetryDelay(task.retryCount - 1)}ms`);
}

/**
 * 等待重试延迟
 */
export async function waitForRetry(task: Task): Promise<void> {
    if (task.nextRetryAt) {
        const waitTime = Math.max(0, task.nextRetryAt - Date.now());
        if (waitTime > 0) {
            log.debug(`⏳ 等待重试: ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
}

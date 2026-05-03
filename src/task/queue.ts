/**
 * 任务队列 - 每个工具独立队列，支持并发控制
 */

import { log } from '../logger.js';
import type { Task, TaskPriority } from './types.js';
import { DEFAULT_CONCURRENCY } from './config.js';
import { getModuleByName } from '../tools/index.js';

export class TaskQueue {
    /** 工具队列 (toolName -> Task[]) */
    private queues = new Map<string, Task[]>();

    /** 当前执行数 (toolName -> count) */
    private running = new Map<string, number>();

    /** 执行回调 */
    private executor: ((task: Task) => Promise<void>) | null = null;

    /** 设置执行器 */
    setExecutor(fn: (task: Task) => Promise<void>): void {
        this.executor = fn;
    }

    /** 入队任务 */
    enqueue(task: Task): { queued: boolean; position: number } {
        const queue = this.queues.get(task.toolName) || [];

        // 按优先级插入
        const insertIndex = queue.findIndex(
            t => this.priorityValue(t.priority) < this.priorityValue(task.priority)
        );

        if (insertIndex === -1) {
            queue.push(task);
        } else {
            queue.splice(insertIndex, 0, task);
        }

        this.queues.set(task.toolName, queue);
        const position = queue.indexOf(task) + 1;

        log.debug(`📥 任务入队: ${task.toolName} (位置: ${position}/${queue.length})`);

        // 尝试执行
        this.scheduleExecution(task.toolName, 'enqueue');

        return { queued: true, position };
    }

    /** 优先级数值 */
    private priorityValue(p: TaskPriority): number {
        return { high: 3, normal: 2, low: 1 }[p] || 2;
    }

    /** 获取工具并发限制（从工具配置动态获取） */
    private getMaxConcurrency(toolName: string): number {
        const loadedTool = getModuleByName(toolName);
        const toolConfig = loadedTool?.module.getTaskConfig?.();
        return toolConfig?.concurrency ?? DEFAULT_CONCURRENCY;
    }

    private scheduleExecution(toolName: string, reason: 'enqueue' | 'continue'): void {
        void this.tryExecute(toolName).catch(err => {
            const message = err instanceof Error ? err.stack || err.message : String(err);
            log.error(`浠诲姟闃熷垪鎵ц澶辫触 [${reason}] ${toolName}: ${message}`);
        });
    }

    /** 尝试执行队列任务 */
    private async tryExecute(toolName: string): Promise<void> {
        if (!this.executor) return;

        const queue = this.queues.get(toolName) || [];
        const currentRunning = this.running.get(toolName) || 0;
        const maxConcurrency = this.getMaxConcurrency(toolName);

        // 检查是否可以执行更多任务
        if (currentRunning >= maxConcurrency || queue.length === 0) {
            return;
        }

        // 取出任务（跳过已取消的）
        let task: Task | undefined;
        while (queue.length > 0) {
            const candidate = queue.shift();
            if (candidate && !candidate.cancelled) {
                task = candidate;
                break;
            }
        }

        if (!task) return;

        // 更新运行计数
        this.running.set(toolName, currentRunning + 1);
        log.debug(`▶️ 开始执行: ${toolName} (并发: ${currentRunning + 1}/${maxConcurrency})`);

        try {
            await this.executor(task);
        } finally {
            // 减少运行计数
            this.running.set(toolName, Math.max(0, (this.running.get(toolName) || 1) - 1));

            // 继续执行队列中的下一个任务
            this.scheduleExecution(toolName, 'continue');
        }
    }

    /** 取消任务 */
    cancel(taskId: string): boolean {
        for (const [_toolName, queue] of this.queues) {
            const index = queue.findIndex(t => t.id === taskId);
            if (index !== -1) {
                const task = queue[index];
                task.cancelled = true;
                task.status = 'cancelled';
                task.finishedAt = Date.now();
                queue.splice(index, 1);
                log.info(`🚫 任务已取消: ${task.toolName} (${taskId.slice(0, 8)})`);
                return true;
            }
        }
        return false;
    }

    /** 获取任务在队列中的位置 */
    getQueuePosition(taskId: string): { position: number; total: number } | null {
        for (const [_toolName, queue] of this.queues) {
            const index = queue.findIndex(t => t.id === taskId);
            if (index !== -1) {
                return { position: index + 1, total: queue.length };
            }
        }
        return null;
    }

    /** 获取队列状态 */
    getQueueStats(): Record<string, { queued: number; running: number; maxConcurrency: number }> {
        const stats: Record<string, { queued: number; running: number; maxConcurrency: number }> = {};

        // 收集所有已知工具
        const allTools = new Set([
            ...this.queues.keys(),
            ...this.running.keys(),
        ]);

        for (const toolName of allTools) {
            const queue = this.queues.get(toolName) || [];
            stats[toolName] = {
                queued: queue.length,
                running: this.running.get(toolName) || 0,
                maxConcurrency: this.getMaxConcurrency(toolName),
            };
        }

        return stats;
    }

    /** 获取指定工具的队列长度 */
    getQueueLength(toolName: string): number {
        return (this.queues.get(toolName) || []).length;
    }

    /** 获取指定工具当前运行数 */
    getRunningCount(toolName: string): number {
        return this.running.get(toolName) || 0;
    }

    /** 检查是否可以立即执行 */
    canExecuteImmediately(toolName: string): boolean {
        const currentRunning = this.running.get(toolName) || 0;
        const maxConcurrency = this.getMaxConcurrency(toolName);
        const queueLength = this.getQueueLength(toolName);
        return currentRunning < maxConcurrency && queueLength === 0;
    }
}

// 全局单例
export const taskQueue = new TaskQueue();

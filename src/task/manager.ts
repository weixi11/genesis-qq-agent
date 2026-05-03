/**
 * TaskManager - 任务生命周期管理
 * 
 * 职责：
 * - 任务状态追踪 (pending → running → success/failed/timeout)
 * - 结果缓存 (相同请求短时间内返回缓存)
 * - 任务去重 (正在执行的任务不重复创建)
 * - 超时控制 (自动标记超时任务)
 */

import { randomUUID, createHash } from 'crypto';
import { log } from '../logger.js';
import type { Task, TaskStatus, TaskStats } from './types.js';
import {
    DEFAULT_TIMEOUT_MS,
    CACHE_TTL,
    MAX_USER_TASKS,
    RETRY_CONFIG,
    TASK_RETENTION,
    CLEANUP_INTERVAL,
} from './config.js';
import { getModuleByName } from '../tools/index.js';
import { getGenesisDb, markDirty, readGenesisDbSnapshot } from '../storage/genesis-db.js';
import { isRecord, safeParseJson } from '../utils/json.js';

export class TaskManager {
    /** 所有任务 (taskId -> Task) */
    private tasks = new Map<string, Task>();

    /** 用户最近任务 (userId -> taskId[]) */
    private userTasks = new Map<number, string[]>();

    /** 缓存索引 (hash -> taskId) */
    private cacheIndex = new Map<string, string>();

    /** 清理定时器 */
    private cleanupTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.cleanupTimer = setInterval(() => {
            this.cleanup();
        }, CLEANUP_INTERVAL);
        this.cleanupTimer.unref?.();
        log.info('📋 TaskManager 已启动');
    }

    /** 重建辅助索引，避免残留过期记录 */
    private rebuildIndexes(): void {
        this.cacheIndex.clear();
        this.userTasks.clear();

        const sortedTasks = Array.from(this.tasks.values())
            .sort((a, b) => b.createdAt - a.createdAt);

        for (const task of sortedTasks) {
            if (!this.cacheIndex.has(task.hash)) {
                this.cacheIndex.set(task.hash, task.id);
            }

            const userTaskList = this.userTasks.get(task.userId) || [];
            userTaskList.push(task.id);
            this.userTasks.set(task.userId, userTaskList);
        }
    }

    private expireTimedOutTasks(now = Date.now()): void {
        for (const task of this.tasks.values()) {
            if (task.status !== 'pending' && task.status !== 'running') {
                continue;
            }

            const startedAt = task.startedAt || task.createdAt;
            if (startedAt <= 0 || task.timeoutMs <= 0) {
                continue;
            }

            if (now - startedAt < task.timeoutMs) {
                continue;
            }

            this.updateTask(task.id, {
                status: 'timeout',
                finishedAt: now,
                result: task.result || {
                    success: false,
                    text: '执行超时',
                },
                error: task.error || '执行超时',
            });
            log.warn(`⏱️ 任务超时: ${task.toolName} (${task.id.slice(0, 8)})`);
        }
    }

    /** 生成缓存哈希 */
    private generateHash(
        userId: number,
        toolName: string,
        params: Record<string, unknown>,
        cacheScope?: string
    ): string {
        // 排除某些不影响结果的参数
        const normalizedParams = { ...params };
        delete normalizedParams.text;  // 原始文本不参与哈希

        const key = JSON.stringify({
            userId,
            toolName,
            params: normalizedParams,
            cacheScope: cacheScope || '',
        });
        return createHash('sha256').update(key).digest('hex').slice(0, 16);
    }

    /** 检查缓存命中 */
    checkCache(
        userId: number,
        toolName: string,
        params: Record<string, unknown>,
        cacheScope?: string
    ): Task | null {
        this.expireTimedOutTasks();
        const hash = this.generateHash(userId, toolName, params, cacheScope);
        const taskId = this.cacheIndex.get(hash);

        if (!taskId) return null;

        const task = this.tasks.get(taskId);
        if (!task) {
            this.cacheIndex.delete(hash);
            return null;
        }

        // 检查是否成功完成且未过期
        if (task.status === 'success' && task.finishedAt) {
            const age = Date.now() - task.finishedAt;
            if (age < CACHE_TTL) {
                log.debug(`📦 任务缓存命中: ${toolName} (${taskId.slice(0, 8)}) 缓存剩余 ${Math.round((CACHE_TTL - age) / 1000)}s`);
                return task;
            }
        }

        // 检查是否正在执行
        if (task.status === 'pending' || task.status === 'running') {
            log.debug(`⏳ 相同任务执行中: ${toolName} (${taskId.slice(0, 8)})`);
            return task;
        }

        this.cacheIndex.delete(hash);
        return null;
    }

    /** 创建新任务 */
    createTask(
        userId: number,
        groupId: number | undefined,
        toolName: string,
        params: Record<string, unknown>,
        cacheScope?: string
    ): Task {
        const id = randomUUID();
        const hash = this.generateHash(userId, toolName, params, cacheScope);
        // 动态获取工具配置，回退到默认值
        const loadedTool = getModuleByName(toolName);
        const toolConfig = loadedTool?.module.getTaskConfig?.();
        const timeoutMs = toolConfig?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        const task: Task = {
            id,
            userId,
            groupId,
            toolName,
            params,
            hash,
            status: 'pending',
            priority: 'normal',
            createdAt: Date.now(),
            timeoutMs,
            retryCount: 0,
            maxRetries: RETRY_CONFIG.maxRetries,
            cancelled: false,
        };

        // 存储
        this.tasks.set(id, task);
        this.cacheIndex.set(hash, id);

        // 更新用户任务列表
        const userTaskList = this.userTasks.get(userId) || [];
        userTaskList.unshift(id);
        if (userTaskList.length > MAX_USER_TASKS) {
            userTaskList.pop();
        }
        this.userTasks.set(userId, userTaskList);

        log.debug(`📝 任务已创建: ${toolName} (${id.slice(0, 8)}) 超时=${timeoutMs / 1000}s`);

        // 持久化
        this.saveTaskToDb(task);

        return task;
    }

    /** 更新任务状态 */
    updateTask(taskId: string, updates: Partial<Task>): void {
        const task = this.tasks.get(taskId);
        if (task) {
            Object.assign(task, updates);
            this.saveTaskToDb(task);
        }
    }

    /** 标记任务开始 */
    startTask(taskId: string): void {
        this.updateTask(taskId, {
            status: 'running',
            startedAt: Date.now(),
        });
        const task = this.tasks.get(taskId);
        if (task) {
            log.debug(`▶️ 任务开始: ${task.toolName} (${taskId.slice(0, 8)})`);
        }
    }

    /** 标记任务完成 */
    completeTask(
        taskId: string,
        success: boolean,
        text: string,
        data?: unknown,
        error?: string
    ): void {
        const task = this.tasks.get(taskId);
        if (!task) return;

        const finishedAt = Date.now();
        const duration = finishedAt - (task.startedAt || task.createdAt);

        if (task.status === 'cancelled' || task.cancelled) {
            if (!task.finishedAt || !task.result) {
                this.updateTask(taskId, {
                    finishedAt: task.finishedAt || finishedAt,
                    result: task.result || {
                        success: false,
                        text: task.error || '任务已取消',
                    },
                    error: task.error || error || '用户取消',
                });
            }
            log.debug(`🚫 忽略已取消任务的完成回写: ${task.toolName} (${taskId.slice(0, 8)}) ${duration}ms`);
            return;
        }

        if (task.status === 'timeout') {
            if (!task.finishedAt || !task.result) {
                this.updateTask(taskId, {
                    finishedAt: task.finishedAt || finishedAt,
                    result: task.result || {
                        success: false,
                        text: task.error || '执行超时',
                    },
                    error: task.error || error || '执行超时',
                });
            }
            log.debug(`⏱️ 忽略已超时任务的完成回写: ${task.toolName} (${taskId.slice(0, 8)}) ${duration}ms`);
            return;
        }

        this.updateTask(taskId, {
            status: success ? 'success' : 'failed',
            finishedAt,
            result: { success, text, data },
            error,
        });

        const statusIcon = success ? '✅' : '❌';
        log.debug(`${statusIcon} 任务完成: ${task.toolName} (${taskId.slice(0, 8)}) ${duration}ms`);
    }

    /** 获取任务 */
    getTask(taskId: string): Task | undefined {
        this.expireTimedOutTasks();
        return this.tasks.get(taskId);
    }

    /** 获取用户最近任务 */
    getUserTasks(userId: number, limit = 5): Task[] {
        this.expireTimedOutTasks();
        const taskIds = this.userTasks.get(userId) || [];
        return taskIds
            .slice(0, limit)
            .map(id => this.tasks.get(id))
            .filter((t): t is Task => t !== undefined);
    }

    /** 获取用户最近任务（排除指定工具） */
    getUserTasksExcluding(userId: number, excludeTools: string[], limit = 5): Task[] {
        const taskIds = this.userTasks.get(userId) || [];
        return taskIds
            .map(id => this.tasks.get(id))
            .filter((t): t is Task => t !== undefined && !excludeTools.includes(t.toolName))
            .slice(0, limit);
    }

    /** 获取用户指定工具的最近任务（排除指定工具） */
    getUserToolTaskExcluding(userId: number, toolName: string, excludeTools: string[]): Task | undefined {
        const tasks = this.getUserTasksExcluding(userId, excludeTools, 20);
        return tasks.find(t => t.toolName === toolName);
    }

    /** 获取用户指定工具的最近任务 */
    getUserToolTask(userId: number, toolName: string): Task | undefined {
        const tasks = this.getUserTasks(userId, 10);
        return tasks.find(t => t.toolName === toolName);
    }

    /** 获取所有任务统计 */
    getStats(): TaskStats {
        this.expireTimedOutTasks();
        const all = Array.from(this.tasks.values());
        const byStatus: Record<TaskStatus, number> = {
            pending: 0,
            running: 0,
            success: 0,
            failed: 0,
            timeout: 0,
            cancelled: 0,
        };

        let totalDuration = 0;
        let completedCount = 0;

        for (const task of all) {
            byStatus[task.status]++;
            if (task.finishedAt && task.startedAt) {
                totalDuration += task.finishedAt - task.startedAt;
                completedCount++;
            }
        }

        return {
            total: all.length,
            byStatus,
            avgDuration: completedCount > 0 ? Math.round(totalDuration / completedCount) : 0,
        };
    }

    /** 获取所有任务列表（用于 API） */
    getAllTasks(limit = 50): Task[] {
        this.expireTimedOutTasks();
        return Array.from(this.tasks.values())
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, limit);
    }

    /** 获取所有任务列表（排除指定工具，按时间倒序） */
    getAllTasksExcluding(excludeTools: string[], limit = 10): Task[] {
        this.expireTimedOutTasks();
        return Array.from(this.tasks.values())
            .filter(t => !excludeTools.includes(t.toolName))
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, limit);
    }

    /** 获取所有任务中指定工具的最近任务（排除指定工具） */
    getAllToolTaskExcluding(toolName: string, excludeTools: string[]): Task | undefined {
        return this.getAllTasksExcluding(excludeTools, 50)
            .find(t => t.toolName === toolName);
    }

    /** 获取所有可取消任务（排除指定工具） */
    getAllCancellableTasks(excludeTools: string[] = []): Task[] {
        this.expireTimedOutTasks();
        return Array.from(this.tasks.values())
            .filter(t =>
                (t.status === 'pending' || t.status === 'running')
                && !t.cancelled
                && !excludeTools.includes(t.toolName)
            )
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    /** 清理过期任务 */
    private cleanup(): void {
        const now = Date.now();
        this.expireTimedOutTasks(now);
        let removed = 0;

        for (const [taskId, task] of this.tasks.entries()) {
            if (task.status === 'pending' || task.status === 'running') {
                continue;
            }

            const referenceTime = task.finishedAt || task.createdAt;
            if (now - referenceTime > TASK_RETENTION) {
                this.tasks.delete(taskId);
                removed++;
            }
        }

        if (removed > 0) {
            this.rebuildIndexes();
            log.debug(`🧹 已清理 ${removed} 条过期任务缓存`);
        }
    }

    /** 取消任务 */
    cancelTask(taskId: string): boolean {
        this.expireTimedOutTasks();
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }

        // 允许取消等待中或正在执行的任务
        if (task.status !== 'pending' && task.status !== 'running') {
            log.debug(`🚫 无法取消: ${task.toolName} 状态为 ${task.status}`);
            return false;
        }

        this.updateTask(taskId, {
            cancelled: true,
            status: 'cancelled',
            finishedAt: Date.now(),
            result: task.result || {
                success: false,
                text: '任务已取消',
            },
            error: '用户取消',
        });

        log.info(`🚫 任务已取消: ${task.toolName} (${taskId.slice(0, 8)})`);
        return true;
    }

    /** 获取用户可取消的任务列表（排除指定工具） */
    getCancellableTasks(userId: number, excludeTools: string[] = []): Task[] {
        this.expireTimedOutTasks();
        return this.getUserTasks(userId, 20).filter(
            t => (t.status === 'pending' || t.status === 'running')
                && !t.cancelled
                && !excludeTools.includes(t.toolName)
        );
    }

    /**
     * 获取指定会话中正在执行的任务
     * @param sessionKey 会话标识，格式为 "group:{groupId}" 或 "private:{userId}"
     */
    getRunningTasksForSession(sessionKey: string, requesterUserId?: number): Task[] {
        this.expireTimedOutTasks();
        // 解析 sessionKey 提取 groupId 或 userId
        const isGroup = sessionKey.startsWith('group:');
        const id = Number(sessionKey.split(':')[1]);

        if (isNaN(id)) return [];

        const running: Task[] = [];
        for (const task of this.tasks.values()) {
            if (task.status !== 'pending' && task.status !== 'running') continue;

            if (isGroup) {
                // 群聊：匹配 groupId
                if (task.groupId === id) {
                    running.push(task);
                }
            } else {
                // 私聊：匹配 userId 且无 groupId
                if (task.userId === id && !task.groupId) {
                    running.push(task);
                }
            }
        }

        return running;
    }

    isCancellationRequested(taskId: string): boolean {
        this.expireTimedOutTasks();
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }
        return task.cancelled || task.status === 'timeout' || task.status === 'cancelled';
    }

    /** 销毁 */
    destroy(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        log.info('📋 TaskManager 已停止');
    }

    // ===== 持久化 =====

    /** 保存任务到 SQLite */
    private saveTaskToDb(task: Task): void {
        try {
            const db = getGenesisDb();
            db.run(
                `INSERT OR REPLACE INTO tasks 
                (id, user_id, group_id, tool_name, params_json, hash, status, priority, progress, result_json, error, created_at, started_at, finished_at, timeout_ms, retry_count, max_retries, cancelled)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    task.id,
                    task.userId,
                    task.groupId || null,
                    task.toolName,
                    JSON.stringify(task.params),
                    task.hash,
                    task.status,
                    task.priority,
                    task.progress || null,
                    task.result ? JSON.stringify(task.result) : null,
                    task.error || null,
                    task.createdAt,
                    task.startedAt || null,
                    task.finishedAt || null,
                    task.timeoutMs,
                    task.retryCount,
                    task.maxRetries,
                    task.cancelled ? 1 : 0,
                ],
            );
            markDirty();
        } catch (err) {
            log.warn('💾 任务写入 SQLite 失败:', err);
        }
    }

    /** 从 SQLite 恢复任务记录 */
    loadFromDb(): void {
        try {
            const db = getGenesisDb();
            const stmt = db.prepare(
                'SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200',
            );

            this.tasks.clear();
            this.cacheIndex.clear();
            this.userTasks.clear();
            let count = 0;
            let interruptedCount = 0;

            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, unknown>;
                try {
                    const task = deserializeTaskRow(row);

                    // 重启后 running/pending 的任务标记为 failed（因被中断）
                    if (task.status === 'running' || task.status === 'pending') {
                        task.status = 'failed';
                        task.error = '程序重启导致任务中断';
                        task.finishedAt = Date.now();
                        interruptedCount++;
                        this.saveTaskToDb(task);
                    }

                    this.tasks.set(task.id, task);
                    count++;
                } catch {
                    // 跳过损坏的记录
                }
            }
            stmt.free();
            this.rebuildIndexes();

            if (interruptedCount > 0) {
                log.warn(`💾 ${interruptedCount} 个任务因重启被标记为失败`);
            }
            this.cleanup();
            log.info(`💾 恢复 ${count} 条任务记录`);
        } catch (err) {
            log.warn('💾 恢复任务记录失败:', err);
        }
    }
}

// 全局单例
export const taskManager = new TaskManager();

function parseTaskParams(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'string' || !raw.trim()) {
        return {};
    }

    const parsed = safeParseJson(raw);
    if (!parsed) {
        log.warn('💾 解析任务参数失败，已回退为空对象');
        return {};
    }
    if (!isRecord(parsed)) {
        return {};
    }
    return parsed;
}

function parseTaskResult(raw: unknown): Task['result'] | undefined {
    if (typeof raw !== 'string' || !raw.trim()) {
        return undefined;
    }

    const parsed = safeParseJson(raw);
    if (!parsed) {
        log.warn('💾 解析任务结果失败，已忽略损坏记录');
        return undefined;
    }

    if (!isRecord(parsed) || typeof parsed.success !== 'boolean' || typeof parsed.text !== 'string') {
        return undefined;
    }

    return {
        success: parsed.success,
        text: parsed.text,
        data: parsed.data,
    };
}

function deserializeTaskRow(row: Record<string, unknown>): Task {
    return {
        id: row.id as string,
        userId: row.user_id as number,
        groupId: (row.group_id as number) || undefined,
        toolName: row.tool_name as string,
        params: parseTaskParams(row.params_json),
        hash: row.hash as string,
        status: row.status as TaskStatus,
        priority: (row.priority as Task['priority']) || 'normal',
        progress: (row.progress as number) || undefined,
        result: parseTaskResult(row.result_json),
        error: (row.error as string) || undefined,
        createdAt: row.created_at as number,
        startedAt: (row.started_at as number) || undefined,
        finishedAt: (row.finished_at as number) || undefined,
        timeoutMs: (row.timeout_ms as number) || DEFAULT_TIMEOUT_MS,
        retryCount: (row.retry_count as number) || 0,
        maxRetries: (row.max_retries as number) || 0,
        cancelled: (row.cancelled as number) === 1,
    };
}

function calculateTaskStats(tasks: Task[]): TaskStats {
    const byStatus: Record<TaskStatus, number> = {
        pending: 0,
        running: 0,
        success: 0,
        failed: 0,
        timeout: 0,
        cancelled: 0,
    };

    let totalDuration = 0;
    let completedCount = 0;

    for (const task of tasks) {
        byStatus[task.status]++;
        if (task.finishedAt && task.startedAt) {
            totalDuration += task.finishedAt - task.startedAt;
            completedCount++;
        }
    }

    return {
        total: tasks.length,
        byStatus,
        avgDuration: completedCount > 0 ? Math.round(totalDuration / completedCount) : 0,
    };
}

export async function listTasksFromDisk(limit = 50, userId?: number): Promise<Task[]> {
    return readGenesisDbSnapshot((db) => {
        const sql = userId
            ? 'SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
            : 'SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?';
        const stmt = db.prepare(sql);
        stmt.bind(userId ? [userId, limit] : [limit]);

        const tasks: Task[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as Record<string, unknown>;
            try {
                tasks.push(deserializeTaskRow(row));
            } catch {
                // 跳过损坏记录
            }
        }
        stmt.free();
        return tasks;
    });
}

export async function getTaskFromDisk(taskId: string): Promise<Task | undefined> {
    return readGenesisDbSnapshot((db) => {
        const stmt = db.prepare('SELECT * FROM tasks WHERE id = ? LIMIT 1');
        stmt.bind([taskId]);

        let task: Task | undefined;
        if (stmt.step()) {
            const row = stmt.getAsObject() as Record<string, unknown>;
            task = deserializeTaskRow(row);
        }
        stmt.free();
        return task;
    });
}

export async function getTaskStatsFromDisk(limit = 100): Promise<TaskStats> {
    const tasks = await listTasksFromDisk(limit);
    return calculateTaskStats(tasks);
}

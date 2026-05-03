import {
    getGenesisDb,
    markDirty,
    mutateGenesisDbSnapshot,
    readGenesisDbSnapshot,
} from '../../storage/genesis-db.js';
import { log } from '../../logger.js';
import type { SchedulerTask, TaskLog, ScheduleType, LastStatus, TriggerSource, JsonValue } from './types.js';
import { config } from './config.js';
import { randomUUID } from 'node:crypto';
import { isRecord, safeParseJson } from '../../utils/json.js';

function toBoolean(val: unknown): boolean {
    return val === 1 || val === true;
}

function isJsonValue(value: unknown): value is JsonValue {
    if (value === null) return true;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return true;
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    if (isRecord(value)) {
        return Object.values(value).every(isJsonValue);
    }
    return false;
}

function parseJson(val: unknown): Record<string, JsonValue> {
    if (typeof val !== 'string') return {};
    const parsed = safeParseJson(val);
    if (!isRecord(parsed) || !isJsonValue(parsed)) {
        return {};
    }
    return parsed as Record<string, JsonValue>;
}

function toOptionalString(val: unknown): string | undefined {
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return String(val);
    return undefined;
}

function deserializeSchedulerTask(row: Record<string, unknown>): SchedulerTask {
    return {
        taskId: String(row.task_id),
        name: String(row.name),
        scheduleType: row.schedule_type as ScheduleType,
        runAt: toOptionalString(row.run_at),
        cron: toOptionalString(row.cron),
        timezone: String(row.timezone),
        toolName: String(row.tool_name),
        toolParams: parseJson(row.tool_params_json),
        enabled: toBoolean(row.enabled),
        retries: Number(row.retries) || 0,
        timeoutSec: Number(row.timeout_sec) || 0,
        maxConcurrency: Number(row.max_concurrency) || 1,
        notifyOnFail: toBoolean(row.notify_on_fail),
        createdBy: Number(row.created_by) || 0,
        createdAt: String(row.created_at),
        updatedBy: Number(row.updated_by) || 0,
        updatedAt: String(row.updated_at),
        nextRunTime: toOptionalString(row.next_run_time),
        lastRunTime: toOptionalString(row.last_run_time),
        lastStatus: row.last_status as LastStatus,
        lastError: toOptionalString(row.last_error),
        runCount: Number(row.run_count) || 0,
        runningCount: Number(row.running_count) || 0,
        groupId: row.group_id !== null ? Number(row.group_id) : undefined,
    };
}

function deserializeTaskLog(row: Record<string, unknown>): TaskLog {
    return {
        taskId: String(row.task_id),
        time: String(row.time),
        timeMs: Number(row.time_ms) || 0,
        status: row.status as 'success' | 'failed',
        message: String(row.message),
        durationMs: Number(row.duration_ms) || 0,
        triggerSource: row.trigger_source as TriggerSource,
        triggeredBy: Number(row.triggered_by) || 0,
        attempts: Number(row.attempts) || 0,
        errorCode: toOptionalString(row.error_code),
        errorMessage: toOptionalString(row.error_message),
    };
}

export interface SchedulerRunRequest {
    requestId: string;
    taskId: string;
    triggeredBy: number;
    status: 'pending' | 'running' | 'success' | 'failed';
    requestedAt: number;
    startedAt?: number;
    finishedAt?: number;
    resultMessage?: string;
    errorCode?: string;
    errorMessage?: string;
}

function deserializeRunRequest(row: Record<string, unknown>): SchedulerRunRequest {
    return {
        requestId: String(row.request_id),
        taskId: String(row.task_id),
        triggeredBy: Number(row.triggered_by) || 0,
        status: row.status as SchedulerRunRequest['status'],
        requestedAt: Number(row.requested_at) || 0,
        startedAt: row.started_at == null ? undefined : Number(row.started_at),
        finishedAt: row.finished_at == null ? undefined : Number(row.finished_at),
        resultMessage: toOptionalString(row.result_message),
        errorCode: toOptionalString(row.error_code),
        errorMessage: toOptionalString(row.error_message),
    };
}

function readAllTasks(database: { prepare: (sql: string) => { step: () => boolean; getAsObject: () => Record<string, unknown>; free: () => void } }): SchedulerTask[] {
    const result: SchedulerTask[] = [];
    try {
        const stmt = database.prepare('SELECT * FROM scheduler_tasks');
        while (stmt.step()) {
            result.push(deserializeSchedulerTask(stmt.getAsObject()));
        }
        stmt.free();
    } catch (err) {
        log.error('💾 从 SQLite 读取任务失败:', err);
    }
    return result;
}

const UPSERT_TASK_SQL = `INSERT OR REPLACE INTO scheduler_tasks (
    task_id, name, schedule_type, run_at, cron, timezone, tool_name, tool_params_json,
    enabled, retries, timeout_sec, max_concurrency, notify_on_fail, created_by, created_at,
    updated_by, updated_at, next_run_time, last_run_time, last_status, last_error, run_count,
    running_count, group_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function serializeSchedulerTask(task: SchedulerTask): unknown[] {
    return [
        task.taskId,
        task.name,
        task.scheduleType,
        task.runAt || null,
        task.cron || null,
        task.timezone,
        task.toolName,
        JSON.stringify(task.toolParams),
        task.enabled ? 1 : 0,
        task.retries,
        task.timeoutSec,
        task.maxConcurrency,
        task.notifyOnFail ? 1 : 0,
        task.createdBy,
        task.createdAt,
        task.updatedBy,
        task.updatedAt,
        task.nextRunTime || null,
        task.lastRunTime || null,
        task.lastStatus,
        task.lastError || null,
        task.runCount,
        task.runningCount,
        task.groupId !== undefined ? task.groupId : null,
    ];
}

export function getAllTasks(): SchedulerTask[] {
    return readAllTasks(getGenesisDb());
}

export async function getAllTasksFromDisk(): Promise<SchedulerTask[]> {
    return readGenesisDbSnapshot((db) => readAllTasks(db));
}

export function saveTask(task: SchedulerTask): void {
    try {
        const db = getGenesisDb();
        db.run(UPSERT_TASK_SQL, serializeSchedulerTask(task));
        markDirty();
    } catch (err) {
        log.error('💾 保存任务到 SQLite 失败:', err);
    }
}

export async function saveTaskToDisk(task: SchedulerTask): Promise<void> {
    await mutateGenesisDbSnapshot((db) => {
        db.run(UPSERT_TASK_SQL, serializeSchedulerTask(task));
    });
}

export function deleteTask(taskId: string): void {
    try {
        const db = getGenesisDb();
        db.run('DELETE FROM scheduler_tasks WHERE task_id = ?', [taskId]);
        db.run('DELETE FROM scheduler_logs WHERE task_id = ?', [taskId]);
        markDirty();
    } catch (err) {
        log.error('💾 从 SQLite 删除任务失败:', err);
    }
}

export async function deleteTaskFromDisk(taskId: string): Promise<void> {
    await mutateGenesisDbSnapshot((db) => {
        db.run('DELETE FROM scheduler_tasks WHERE task_id = ?', [taskId]);
        db.run('DELETE FROM scheduler_logs WHERE task_id = ?', [taskId]);
    });
}

export function getTaskLogs(taskId: string, limit: number = config.logsLimitPerTask): TaskLog[] {
    const result: TaskLog[] = [];
    try {
        const stmt = getGenesisDb().prepare('SELECT * FROM scheduler_logs WHERE task_id = ? ORDER BY time_ms DESC LIMIT ?');
        stmt.bind([taskId, limit]);
        while (stmt.step()) {
            result.push(deserializeTaskLog(stmt.getAsObject()));
        }
        stmt.free();
    } catch (err) {
        log.error('💾 从 SQLite 读取任务日志失败:', err);
    }
    return result;
}

function readTaskLogs(
    database: { prepare: (sql: string) => { bind: (values: unknown[]) => void; step: () => boolean; getAsObject: () => Record<string, unknown>; free: () => void } },
    taskId: string,
    limit: number,
): TaskLog[] {
    const result: TaskLog[] = [];
    try {
        const stmt = database.prepare('SELECT * FROM scheduler_logs WHERE task_id = ? ORDER BY time_ms DESC LIMIT ?');
        stmt.bind([taskId, limit]);
        while (stmt.step()) {
            result.push(deserializeTaskLog(stmt.getAsObject()));
        }
        stmt.free();
    } catch (err) {
        log.error('💾 从 SQLite 读取任务日志失败:', err);
    }
    return result;
}

export async function getTaskLogsFromDisk(taskId: string, limit: number = config.logsLimitPerTask): Promise<TaskLog[]> {
    return readGenesisDbSnapshot((db) => readTaskLogs(db, taskId, limit));
}

export async function getTaskFromDisk(taskId: string): Promise<SchedulerTask | undefined> {
    return readGenesisDbSnapshot((db) => {
        const stmt = db.prepare('SELECT * FROM scheduler_tasks WHERE task_id = ? LIMIT 1');
        stmt.bind([taskId]);

        let task: SchedulerTask | undefined;
        if (stmt.step()) {
            task = deserializeSchedulerTask(stmt.getAsObject());
        }
        stmt.free();
        return task;
    });
}

const INSERT_TASK_LOG_SQL = `INSERT INTO scheduler_logs (
    task_id, time, time_ms, status, message, duration_ms, trigger_source, triggered_by, attempts, error_code, error_message
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function serializeTaskLog(logItem: TaskLog): unknown[] {
    return [
        logItem.taskId,
        logItem.time,
        logItem.timeMs,
        logItem.status,
        logItem.message,
        logItem.durationMs,
        logItem.triggerSource,
        logItem.triggeredBy,
        logItem.attempts,
        logItem.errorCode || null,
        logItem.errorMessage || null,
    ];
}

export function saveTaskLog(logItem: TaskLog): void {
    try {
        const db = getGenesisDb();
        db.run(INSERT_TASK_LOG_SQL, serializeTaskLog(logItem));
        markDirty();
    } catch (err) {
        log.error('💾 保存任务日志到 SQLite 失败:', err);
    }
}

export async function saveTaskLogToDisk(logItem: TaskLog): Promise<void> {
    await mutateGenesisDbSnapshot((db) => {
        db.run(INSERT_TASK_LOG_SQL, serializeTaskLog(logItem));
    });
}

export function resetRunningCounts(): void {
    try {
        const db = getGenesisDb();
        db.run('UPDATE scheduler_tasks SET running_count = 0, last_status = CASE WHEN last_status = "running" THEN "failed" ELSE last_status END WHERE running_count > 0 OR last_status = "running"');
        markDirty();
    } catch (err) {
        log.error('💾 重置任务运行状态失败:', err);
    }
}

export async function resetRunningCountsOnDisk(): Promise<void> {
    await mutateGenesisDbSnapshot((db) => {
        db.run('UPDATE scheduler_tasks SET running_count = 0, last_status = CASE WHEN last_status = "running" THEN "failed" ELSE last_status END WHERE running_count > 0 OR last_status = "running"');
    });
}

export async function enqueueRunRequest(taskId: string, triggeredBy: number): Promise<SchedulerRunRequest> {
    const request: SchedulerRunRequest = {
        requestId: `sched_req_${Date.now()}_${randomUUID().slice(0, 8)}`,
        taskId,
        triggeredBy,
        status: 'pending',
        requestedAt: Date.now(),
    };

    await mutateGenesisDbSnapshot((db) => {
        db.run(
            `INSERT INTO scheduler_run_requests (
                request_id, task_id, triggered_by, status, requested_at, started_at, finished_at, result_message, error_code, error_message
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
            [request.requestId, request.taskId, request.triggeredBy, request.status, request.requestedAt],
        );
    });

    return request;
}

export async function claimPendingRunRequest(): Promise<SchedulerRunRequest | undefined> {
    return mutateGenesisDbSnapshot((db) => {
        const stmt = db.prepare(
            "SELECT * FROM scheduler_run_requests WHERE status = 'pending' ORDER BY requested_at ASC LIMIT 1",
        );

        let request: SchedulerRunRequest | undefined;
        if (stmt.step()) {
            const row = stmt.getAsObject();
            request = deserializeRunRequest(row);
        }
        stmt.free();

        if (!request) {
            return undefined;
        }

        const startedAt = Date.now();
        db.run(
            "UPDATE scheduler_run_requests SET status = 'running', started_at = ?, finished_at = NULL, result_message = NULL, error_code = NULL, error_message = NULL WHERE request_id = ?",
            [startedAt, request.requestId],
        );

        return {
            ...request,
            status: 'running',
            startedAt,
            finishedAt: undefined,
            resultMessage: undefined,
            errorCode: undefined,
            errorMessage: undefined,
        };
    });
}

export async function completeRunRequest(
    requestId: string,
    result: {
        status: 'success' | 'failed';
        resultMessage: string;
        errorCode?: string;
        errorMessage?: string;
    },
): Promise<void> {
    await mutateGenesisDbSnapshot((db) => {
        db.run(
            `UPDATE scheduler_run_requests
             SET status = ?, finished_at = ?, result_message = ?, error_code = ?, error_message = ?
             WHERE request_id = ?`,
            [
                result.status,
                Date.now(),
                result.resultMessage,
                result.errorCode || null,
                result.errorMessage || null,
                requestId,
            ],
        );
    });
}

export async function getRunRequest(requestId: string): Promise<SchedulerRunRequest | undefined> {
    return readGenesisDbSnapshot((db) => {
        const stmt = db.prepare('SELECT * FROM scheduler_run_requests WHERE request_id = ? LIMIT 1');
        stmt.bind([requestId]);

        let request: SchedulerRunRequest | undefined;
        if (stmt.step()) {
            request = deserializeRunRequest(stmt.getAsObject());
        }
        stmt.free();
        return request;
    });
}

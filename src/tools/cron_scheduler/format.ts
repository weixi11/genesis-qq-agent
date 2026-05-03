import type { SchedulerTask } from './types.js';
import type { ToolResult } from '../types.js';

export function taskState(task: SchedulerTask): string {
    if (!task.enabled) return 'disabled';
    if (task.lastStatus === 'running') return 'running';
    if (task.lastStatus === 'failed') return 'failed';
    if (task.lastStatus === 'success') return 'success';
    return 'idle';
}

export function toListTask(task: SchedulerTask): Record<string, unknown> {
    return {
        task_id: task.taskId,
        name: task.name,
        tool_name: task.toolName,
        schedule_type: task.scheduleType,
        cron: task.scheduleType === 'cron' ? (task.cron ?? null) : null,
        run_at: task.scheduleType === 'once' ? (task.runAt ?? null) : null,
        enabled: task.enabled,
        status: taskState(task),
        next_run_at: task.nextRunTime ?? null,
        last_run_at: task.lastRunTime ?? null,
        last_error: task.lastError ?? null,
        group_id: task.groupId ?? null,
    };
}

export function toPublicTask(task: SchedulerTask): Record<string, unknown> {
    return {
        task_id: task.taskId,
        name: task.name,
        schedule_type: task.scheduleType,
        run_at: task.runAt,
        cron: task.cron,
        timezone: task.timezone,
        tool_name: task.toolName,
        tool_params: task.toolParams,
        group_id: task.groupId,
        enabled: task.enabled,
        retries: task.retries,
        timeout_sec: task.timeoutSec,
        max_concurrency: task.maxConcurrency,
        notify_on_fail: task.notifyOnFail,
        created_by: task.createdBy,
        created_at: task.createdAt,
        updated_by: task.updatedBy,
        updated_at: task.updatedAt,
        next_run_at: task.nextRunTime,
        next_run_time: task.nextRunTime,
        last_run_at: task.lastRunTime,
        last_run_time: task.lastRunTime,
        status: taskState(task),
        state: taskState(task),
        last_status: task.lastStatus,
        last_error: task.lastError,
        run_count: task.runCount,
    };
}

export function fail(errorCode: string, errorMessage: string, extra?: Record<string, unknown>): ToolResult {
    return {
        success: false,
        text: `${errorCode}: ${errorMessage}`,
        data: {
            error_code: errorCode,
            error_message: errorMessage,
            message: errorMessage,
            ...(extra || {}),
        },
    };
}

type PreferredField = 'data' | 'items' | 'list' | 'records';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function getField(obj: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
        if (hasOwn(obj, key)) return obj[key];
    }
    return undefined;
}

function pickPreferredField(source: Record<string, unknown>): { key: PreferredField; value: unknown } | null {
    const keys: PreferredField[] = ['data', 'items', 'list', 'records'];
    for (const key of keys) {
        if (hasOwn(source, key)) return { key, value: source[key] };
    }
    return null;
}

function normalizeBackendResponse(raw: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...raw };
    const top = pickPreferredField(out);
    if (top) {
        let parsed: unknown = top.value;
        let parsedFrom: string = top.key;
        if (isRecord(parsed)) {
            const nested = pickPreferredField(parsed);
            if (nested) {
                parsed = nested.value;
                parsedFrom = `${parsedFrom}.${nested.key}`;
            }
        }
        out.preferred_source = parsedFrom;
        out.parsed = parsed;
    }
    const message = asString(out.message) ?? asString(out.msg);
    if (message) out.message = message;
    return out;
}

function extractDataRoot(payload: Record<string, unknown>): unknown {
    if (hasOwn(payload, 'data')) return payload.data;
    return payload;
}

function extractListItems(payload: Record<string, unknown>): unknown[] {
    const parsed = payload.parsed;
    if (Array.isArray(parsed)) return parsed;
    const root = extractDataRoot(payload);
    if (Array.isArray(root)) return root;
    if (isRecord(root)) {
        const inner = pickPreferredField(root);
        if (inner && Array.isArray(inner.value)) return inner.value;
    }
    const top = pickPreferredField(payload);
    if (top && Array.isArray(top.value)) return top.value;
    return [];
}

function asBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const v = value.toLowerCase();
        if (v === 'true' || v === '1') return true;
        if (v === 'false' || v === '0') return false;
    }
    return undefined;
}

function normalizeListRow(item: unknown): Record<string, unknown> {
    if (!isRecord(item)) {
        return {
            task_id: '', name: '', tool_name: '', schedule_type: '', cron: null, run_at: null,
            enabled: null, status: '', next_run_at: null, last_run_at: null, last_error: null, raw: item,
        };
    }

    const scheduleType = asString(getField(item, ['schedule_type', 'scheduleType'])) ?? '';
    return {
        task_id: asString(getField(item, ['task_id', 'taskId', 'id'])) ?? '',
        name: asString(getField(item, ['name'])) ?? '',
        tool_name: asString(getField(item, ['tool_name', 'toolName'])) ?? '',
        schedule_type: scheduleType,
        cron: asString(getField(item, ['cron'])) ?? null,
        run_at: asString(getField(item, ['run_at', 'runAt'])) ?? null,
        enabled: asBoolean(getField(item, ['enabled'])) ?? null,
        status: asString(getField(item, ['status', 'state', 'last_status', 'lastStatus'])) ?? '',
        next_run_at: asString(getField(item, ['next_run_at', 'next_run_time', 'nextRunAt', 'nextRunTime'])) ?? null,
        last_run_at: asString(getField(item, ['last_run_at', 'last_run_time', 'lastRunAt', 'lastRunTime'])) ?? null,
        last_error: asString(getField(item, ['last_error', 'lastError'])) ?? null,
    };
}

export function formatActionText(action: string, message: string, payload: Record<string, unknown>): string {
    if (action === 'list') {
        const rows = extractListItems(payload).map((it) => normalizeListRow(it));
        if (rows.length === 0) return `${message}（0 条）`;
        const lines = rows.slice(0, 20).map((row) => {
            const schedule = row.schedule_type === 'cron' ? `cron=${typeof row.cron === 'string' ? row.cron : '-'}` : `run_at=${typeof row.run_at === 'string' ? row.run_at : '-'}`;
            return `- ${String(row.task_id)} | ${String(row.name)} | ${String(row.tool_name)} | ${String(row.schedule_type)}(${schedule}) | enabled=${String(row.enabled)} | status=${String(row.status)} | next=${String(row.next_run_at)} | last=${String(row.last_run_at)} | err=${String(row.last_error)}`;
        });
        return `${message}（${rows.length} 条）\n${lines.join('\n')}`;
    }

    const root = extractDataRoot(payload);
    const rootRecord = isRecord(root) ? root : payload;
    const taskId = asString(getField(rootRecord, ['task_id'])) ?? asString(getField(payload, ['task_id']));

    if (action === 'create') {
        const nameVal = asString(getField(rootRecord, ['name']));
        const toolName = asString(getField(rootRecord, ['tool_name']));
        const scheduleType = asString(getField(rootRecord, ['schedule_type']));
        return `${message}${taskId ? ` task_id=${taskId}` : ''}${nameVal ? ` name=${nameVal}` : ''}${toolName ? ` tool=${toolName}` : ''}${scheduleType ? ` schedule=${scheduleType}` : ''}`;
    }

    if (action === 'get') {
        const taskObj = isRecord(getField(rootRecord, ['task'])) ? (getField(rootRecord, ['task']) as Record<string, unknown>) : undefined;
        const tid = taskObj ? asString(getField(taskObj, ['task_id'])) : taskId;
        return `${message}${tid ? ` task_id=${tid}` : ''}`;
    }

    if (action === 'delete') return `${message}${taskId ? ` task_id=${taskId}` : ''}`;
    if (action === 'enable' || action === 'disable' || action === 'update' || action === 'run_now') return `${message}${taskId ? ` task_id=${taskId}` : ''}`;

    return message;
}

export function success(action: string, raw: Record<string, unknown>, fallbackMessage: string): ToolResult {
    const normalized = normalizeBackendResponse(raw);
    const message = asString(normalized.message) ?? fallbackMessage;
    const text = formatActionText(action, message, normalized);
    return { success: true, text, data: normalized };
}

import { config } from './config.js';
import { schema } from './schema.js';
import { log } from '../../logger.js';
import { executeModule } from '../executor.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { z } from 'zod';
import { connector } from '../../connector.js';
import { persona } from '../../agents/persona.js';
import { config as appConfig } from '../../config.js';
import type { FormattedMessage } from '../../types.js';
import type { SchedulerTask, TriggerSource, JsonValue, ScheduleType } from './types.js';
import { TaskExecutionError } from './types.js';
import {
    claimPendingRunRequest,
    completeRunRequest,
    deleteTask as storeDeleteTask,
    deleteTaskFromDisk,
    enqueueRunRequest,
    getAllTasks,
    getAllTasksFromDisk,
    getRunRequest,
    getTaskFromDisk,
    getTaskLogs,
    getTaskLogsFromDisk,
    resetRunningCounts,
    saveTask,
    saveTaskLog,
    saveTaskLogToDisk,
    saveTaskToDisk,
} from './store.js';
import { isValidTimezone, computeNextCronRun, renderTemplates, parseCron } from './utils.js';
import { taskState, toListTask, toPublicTask, fail, success } from './format.js';
import type { MessageSegment } from '../../utils/message.js';
import type { FileAttachment } from '../../utils/file_attachment.js';
import { isRecord, safeParseJson } from '../../utils/json.js';

export const name = 'cron_scheduler';
export const description = '创建并管理定时/周期任务，调度白名单工具执行';
export const keywords = ['cron', 'scheduler', '定时任务', '周期任务', '任务管理'];

export function enabled(): boolean { return config.enabled; }

export { schema };

const tasks = new Map<string, SchedulerTask>();
let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerCommandTimer: NodeJS.Timeout | null = null;
let globalRunning = 0;
let recovered = false;
const SYSTEM_TASK_SENDER_ID_BASE = 1_000_000_000;
const SCHEDULED_RESULT_SEGMENT_DELAY_MS = 300;
const RUN_REQUEST_POLL_MS = 1000;

type TaskDeliveryTarget =
    | { type: 'group'; groupId: number }
    | { type: 'private'; userId: number };

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

function ensureSchedulerStarted(): void {
    if (!recovered) {
        resetRunningCounts();
        const items = getAllTasks();
        for (const t of items) tasks.set(t.taskId, t);
        recovered = true;
    }
    if (schedulerTimer) return;
    schedulerTimer = setInterval(() => { void processDueTasks(); }, config.tickMs);
    schedulerTimer.unref?.();
    if (!schedulerCommandTimer) {
        schedulerCommandTimer = setInterval(() => { void processQueuedRunRequests(); }, RUN_REQUEST_POLL_MS);
        schedulerCommandTimer.unref?.();
    }
}

function getGenesisProcessRole(): 'agent' | 'web' {
    const role = (process.env.GENESIS_PROCESS_ROLE || '').trim().toLowerCase();
    return role === 'web' ? 'web' : 'agent';
}

function isWebOnlyProcess(): boolean {
    return getGenesisProcessRole() === 'web';
}

async function refreshTasksFromDiskForWeb(): Promise<void> {
    if (!isWebOnlyProcess()) {
        return;
    }

    tasks.clear();
    const items = await getAllTasksFromDisk();
    for (const task of items) {
        tasks.set(task.taskId, task);
    }
    recovered = true;
}

async function persistTask(task: SchedulerTask): Promise<void> {
    if (isWebOnlyProcess()) {
        await saveTaskToDisk(task);
        return;
    }
    saveTask(task);
}

async function persistTaskLog(logItem: Parameters<typeof saveTaskLog>[0]): Promise<void> {
    if (isWebOnlyProcess()) {
        await saveTaskLogToDisk(logItem);
        return;
    }
    saveTaskLog(logItem);
}

async function persistTaskDeletion(taskId: string): Promise<void> {
    if (isWebOnlyProcess()) {
        await deleteTaskFromDisk(taskId);
        return;
    }
    storeDeleteTask(taskId);
}

export function startScheduler(): void {
    ensureSchedulerStarted();
}

function makeTaskId(): string {
    const rand = Math.random().toString(36).slice(2, 8);
    return `task_${Date.now()}_${rand}`;
}

function isJsonValue(value: unknown): value is JsonValue {
    if (value === null) return true;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return true;
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    if (typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).every(isJsonValue);
    }
    return false;
}

const toolParamsSchema = z.union([
    z.string().transform((val, ctx) => {
        const parsed = safeParseJson(val);
        if (!isRecord(parsed)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool_params 不是合法 JSON 对象字符串' });
            return z.NEVER;
        }
        if (!isJsonValue(parsed)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool_params 必须是合法 JSON 对象' });
            return z.NEVER;
        }
        return parsed as Record<string, JsonValue>;
    }),
    z.record(z.unknown()).superRefine((val, ctx) => {
        if (!isJsonValue(val)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool_params 必须是合法 JSON 对象' });
        }
    }).transform(val => val as Record<string, JsonValue>)
]);

const createGroupIdSchema = z.preprocess(
    (value) => value === '' || value === null ? undefined : value,
    z.coerce.number().int().positive().optional(),
);

const updateGroupIdSchema = z.preprocess(
    (value) => value === '' || value === null ? null : value,
    z.coerce.number().int().positive().nullable().optional(),
);

function parseBoolText(v: string | boolean) { return typeof v === 'string' ? (v === 'true' || v === '1') : v; }

function hasOwnParam(params: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(params, key);
}

function buildDisallowedToolFailure(toolName: string): ToolResult {
    const allowedTools = config.allowedTools;
    const sourceLabel = config.allowedToolsSource === 'env'
        ? 'CRON_SCHEDULER_ALLOWED_TOOLS'
        : '当前已启用工具';
    const allowedSummary = allowedTools.length > 0
        ? `当前允许的工具：${allowedTools.join(', ')}`
        : '当前没有可调度工具';

    return fail(
        'INVALID_PARAMS',
        `工具「${toolName}」不在定时任务白名单中。${allowedSummary}。来源：${sourceLabel}`,
        {
            tool_name: toolName,
            allowed_tools: allowedTools,
            allowed_tools_source: config.allowedToolsSource,
        },
    );
}

function resolveTaskSenderId(task: SchedulerTask): number {
    if (task.createdBy > 0) return task.createdBy;

    let hash = 0;
    for (const char of task.taskId) {
        hash = (hash * 33 + char.charCodeAt(0)) % 900_000_000;
    }

    return SYSTEM_TASK_SENDER_ID_BASE + hash;
}

function buildTaskDeliveryMessage(task: SchedulerTask): FormattedMessage {
    const senderId = resolveTaskSenderId(task);
    return {
        message_id: -Math.floor(Date.now() / 1000),
        time: Math.floor(Date.now() / 1000),
        time_str: new Date().toLocaleTimeString('zh-CN'),
        type: task.groupId ? 'group' : 'private',
        self_id: appConfig.botQQ || 0,
        summary: `[定时任务结果] ${task.name}`,
        sender_id: senderId,
        sender_name: task.createdBy === appConfig.masterQQ ? '主人' : '用户',
        group_id: task.groupId,
        text: task.name,
        images: [],
        videos: [],
        records: [],
        files: [],
        cards: [],
        mface_urls: [],
        at_users: [],
        at_all: false,
    };
}

async function renderTaskDeliveryText(task: SchedulerTask, rawText: string): Promise<string> {
    const deliveryMessage = buildTaskDeliveryMessage(task);
    const reasoning = task.scheduleType === 'once'
        ? '这是之前约定时间触发的一次性任务，现在要像按时兑现承诺一样自然汇报结果。'
        : '这是周期任务的一次执行结果，现在要像例行播报一样自然汇报结果。';

    try {
        return await persona.enhanceToolResult({
            message: deliveryMessage,
            toolName: task.toolName,
            toolNames: [task.toolName],
            toolResult: `定时任务「${task.name}」已到时间并执行完成。\n\n${rawText}`,
            toolSuccess: true,
            toolParams: task.toolParams,
            userOriginalText: task.name,
            taskContext: {
                goal: '向用户转述定时任务执行结果',
                reasoning,
                speakStyle: 'scheduled_result',
            },
        });
    } catch (err) {
        log.warn('[cron_scheduler] 定时任务结果润色失败，回退原文', err);
        return rawText;
    }
}

function resolveTaskDeliveryTarget(task: SchedulerTask): TaskDeliveryTarget | null {
    if (task.groupId) {
        return { type: 'group', groupId: task.groupId };
    }
    if (task.createdBy) {
        return { type: 'private', userId: task.createdBy };
    }
    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverTaskSegments(target: TaskDeliveryTarget, segments: MessageSegment[]): Promise<void> {
    for (const [index, segment] of segments.entries()) {
        await connector.send(target, [segment]);
        if (index < segments.length - 1) {
            await sleep(SCHEDULED_RESULT_SEGMENT_DELAY_MS);
        }
    }
}

async function deliverTaskFiles(target: TaskDeliveryTarget, files: FileAttachment[]): Promise<void> {
    for (const [index, file] of files.entries()) {
        await connector.sendFile(target, file);
        if (index < files.length - 1) {
            await sleep(SCHEDULED_RESULT_SEGMENT_DELAY_MS);
        }
    }
}

async function deliverTaskResult(
    task: SchedulerTask,
    rawText: string,
    segments: MessageSegment[] = [],
    files: FileAttachment[] = [],
): Promise<void> {
    if (!connector.connected) {
        log.info('[cron_scheduler] NapCat 未连接，跳过定时任务结果回发', { taskId: task.taskId });
        return;
    }

    const target = resolveTaskDeliveryTarget(task);
    if (!target) {
        log.warn('[cron_scheduler] 定时任务缺少投递目标，跳过结果发送', { taskId: task.taskId });
        return;
    }

    if (segments.length > 0) {
        try {
            await deliverTaskSegments(target, segments);
        } catch (err) {
            log.error('[cron_scheduler] 发送定时任务富媒体结果失败', err);
        }
    }
    if (files.length > 0) {
        try {
            await deliverTaskFiles(target, files);
        } catch (err) {
            log.error('[cron_scheduler] 发送定时任务文件结果失败', err);
        }
    }

    const trimmedText = rawText.trim();
    if (!trimmedText) {
        return;
    }

    const deliveryText = await renderTaskDeliveryText(task, trimmedText);
    if (target.type === 'group') {
        await connector.sendGroup(target.groupId, deliveryText);
        return;
    }
    await connector.sendPrivate(target.userId, deliveryText);
}

function claimScheduledRun(task: SchedulerTask, trigger: TriggerSource): void {
    if (trigger !== 'scheduler') return;

    if (task.scheduleType === 'once') {
        task.enabled = false;
        task.nextRunTime = undefined;
        return;
    }

    if (!task.cron) return;

    const scheduledTime = task.nextRunTime ? new Date(task.nextRunTime) : new Date();
    const referenceMs = Number.isFinite(scheduledTime.getTime())
        ? Math.max(scheduledTime.getTime(), Date.now())
        : Date.now();
    const safeReferenceTime = new Date(referenceMs);
    const next = computeNextCronRun(task.cron, task.timezone, safeReferenceTime);
    task.nextRunTime = next ? next.toISOString() : undefined;
}

function applySchedule(task: SchedulerTask, scheduleType: ScheduleType, runAtRaw: string | undefined, cronRaw: string | undefined): { ok: true } | { ok: false; code: string; message: string } {
    if (scheduleType === 'once') {
        if (!runAtRaw) return { ok: false, code: 'INVALID_PARAMS', message: 'once 任务必须提供 run_at' };
        const t = Date.parse(runAtRaw);
        if (!Number.isFinite(t)) return { ok: false, code: 'INVALID_TIME', message: 'run_at 不是合法时间' };
        if (t <= Date.now()) return { ok: false, code: 'TIME_IN_PAST', message: 'run_at 不能早于当前时间' };
        const runAtIso = new Date(t).toISOString();
        task.scheduleType = 'once';
        task.runAt = runAtIso;
        task.cron = undefined;
        task.nextRunTime = task.enabled ? runAtIso : undefined;
        return { ok: true };
    }

    if (!cronRaw) return { ok: false, code: 'INVALID_PARAMS', message: 'cron 任务必须提供 cron 表达式' };
    const parsed = parseCron(cronRaw);
    if (!parsed.ok) return { ok: false, code: 'INVALID_CRON', message: parsed.error };
    const next = computeNextCronRun(cronRaw, task.timezone, new Date());
    if (!next) return { ok: false, code: 'INVALID_CRON', message: '无法计算下一次执行时间' };

    task.scheduleType = 'cron';
    task.cron = cronRaw;
    task.runAt = undefined;
    task.nextRunTime = task.enabled ? next.toISOString() : undefined;
    return { ok: true };
}

interface ScheduleUpdateOptions {
    scheduleType?: ScheduleType;
    timezone?: string;
    runAt?: string;
    cron?: string;
    enabled?: boolean;
}

function shouldReapplySchedule(task: SchedulerTask, updates: ScheduleUpdateOptions): boolean {
    const nextScheduleType = updates.scheduleType ?? task.scheduleType;

    if (updates.scheduleType !== undefined || updates.runAt !== undefined || updates.cron !== undefined) {
        return true;
    }

    if (updates.timezone !== undefined && updates.timezone !== task.timezone && nextScheduleType === 'cron') {
        return true;
    }

    return updates.enabled === true && !task.enabled;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ms);
        promise.then((v) => { clearTimeout(timer); resolve(v); }).catch((e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); });
    });
}

function parseExecutionError(err: unknown): { code: string; message: string } {
    if (err instanceof TaskExecutionError) return { code: err.code, message: err.message };
    if (err instanceof Error) {
        if (err.message === 'timeout') return { code: 'EXEC_TIMEOUT', message: '执行超时' };
        if (err.message.includes('调度执行器不可用')) return { code: 'INVOKER_UNAVAILABLE', message: err.message };
        return { code: 'TOOL_EXEC_ERROR', message: err.message || '工具执行失败' };
    }
    return { code: 'TOOL_EXEC_ERROR', message: '未知错误' };
}

async function invokeTaskTool(task: SchedulerTask): Promise<ToolResult> {
    const now = new Date();
    const rendered = renderTemplates(task.toolParams, task.timezone, now) as Record<string, unknown>;
    return executeModule(task.toolName, rendered, {
        senderId: resolveTaskSenderId(task),
        groupId: task.groupId,
    });
}

interface RunTaskOutcome { started: boolean; success: boolean; code?: string; message: string; }

interface SuccessfulRunAttempt {
    success: true;
    code: string;
    message: string;
    text: string;
    segments: MessageSegment[];
    files: FileAttachment[];
}

interface FailedRunAttempt {
    success: false;
    code: string;
    message: string;
}

type RunAttemptResult = SuccessfulRunAttempt | FailedRunAttempt;

async function handleRunAttempt(task: SchedulerTask): Promise<RunAttemptResult> {
    try {
        const result = await withTimeout(invokeTaskTool(task), task.timeoutSec * 1000);
        if (!result.success) {
            const detail = typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data) ? result.data : undefined;
            const codeRaw = detail?.['error_code'] ?? detail?.['code'];
            const code = typeof codeRaw === 'string' ? codeRaw : undefined;
            throw new TaskExecutionError(code ?? 'TOOL_EXEC_FAILED', result.text || '工具执行失败', detail);
        }
        return {
            success: true,
            code: '',
            message: '',
            text: result.text,
            segments: result.segments ?? [],
            files: result.files ?? [],
        };
    } catch (err) {
        const parsed = parseExecutionError(err);
        return { success: false, code: parsed.code, message: parsed.message };
    }
}

async function performTaskRetries(task: SchedulerTask, maxAttempts: number): Promise<{ success: boolean; errorMessage: string; code: string; attempts: number }> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const res = await handleRunAttempt(task);
        if (res.success) {
            if (res.text.trim() || res.segments.length > 0 || res.files.length > 0) {
                void deliverTaskResult(task, res.text, res.segments, res.files).catch(e => log.error('发送定时任务结果失败', e));
            }
            return { success: true, errorMessage: '', code: '', attempts: attempt };
        }
        if (attempt === maxAttempts) {
            return { success: false, errorMessage: res.message, code: res.code, attempts: attempt };
        }
    }
    return { success: false, errorMessage: 'TIMEOUT', code: 'TIMEOUT', attempts: maxAttempts };
}

async function runTask(task: SchedulerTask, triggeredBy: number, trigger: TriggerSource): Promise<RunTaskOutcome> {
    if (globalRunning >= config.concurrency) return { started: false, success: false, code: 'CONCURRENCY_LIMIT', message: '全局并发已达上限' };
    if (task.runningCount >= task.maxConcurrency) return { started: false, success: false, code: 'TASK_CONCURRENCY_LIMIT', message: '任务并发已达上限' };

    globalRunning += 1;
    task.runningCount += 1;
    claimScheduledRun(task, trigger);
    task.lastStatus = 'running';
    task.updatedBy = triggeredBy;
    task.updatedAt = new Date().toISOString();
    await persistTask(task);

    const startedAt = Date.now();
    const maxAttempts = task.retries + 1;

    try {
        const res = await performTaskRetries(task, maxAttempts);
        const finalSuccess = res.success;
        const finalError = res.errorMessage;
        const finalCode = res.code;
        const usedAttempts = res.attempts;

        task.lastRunTime = new Date().toISOString();
        task.lastStatus = finalSuccess ? 'success' : 'failed';
        task.lastError = finalSuccess ? undefined : finalError;
        task.runCount += 1;
        task.updatedBy = triggeredBy;
        task.updatedAt = new Date().toISOString();
        await persistTaskLog({
            taskId: task.taskId,
            time: new Date().toISOString(),
            timeMs: Date.now(),
            status: finalSuccess ? 'success' : 'failed',
            message: finalSuccess ? '执行成功' : finalError,
            durationMs: Date.now() - startedAt,
            triggerSource: trigger,
            triggeredBy,
            attempts: usedAttempts,
            errorCode: finalSuccess ? undefined : finalCode,
            errorMessage: finalSuccess ? undefined : finalError,
        });

        if (!finalSuccess && task.notifyOnFail) {
            log.warn('[cron_scheduler] task failed', { taskId: task.taskId, toolName: task.toolName, error_code: finalCode, error_message: finalError, trigger });
        }

        return {
            started: true,
            success: finalSuccess,
            code: finalSuccess ? undefined : (finalCode || 'TASK_RUN_FAILED'),
            message: finalSuccess ? '执行成功' : (finalError || '执行失败'),
        };
    } finally {
        task.runningCount = Math.max(0, task.runningCount - 1);
        globalRunning = Math.max(0, globalRunning - 1);
        await persistTask(task);
    }
}

async function processDueTasks(): Promise<void> {
    if (!config.enabled) {
        return;
    }

    const now = Date.now();
    for (const task of tasks.values()) {
        if (!task.enabled || !task.nextRunTime) continue;
        const due = Date.parse(task.nextRunTime);
        if (!Number.isFinite(due) || due > now) continue;
        if (globalRunning >= config.concurrency) return;
        void runTask(task, 0, 'scheduler');
    }
}

async function processQueuedRunRequests(): Promise<void> {
    if (isWebOnlyProcess()) {
        return;
    }

    while (globalRunning < config.concurrency) {
        const request = await claimPendingRunRequest();
        if (!request) {
            return;
        }

        const task = await getTaskFromDisk(request.taskId);
        if (!task) {
            await completeRunRequest(request.requestId, {
                status: 'failed',
                resultMessage: '任务不存在',
                errorCode: 'TASK_NOT_FOUND',
                errorMessage: '任务不存在',
            });
            continue;
        }

        tasks.set(task.taskId, task);
        void (async () => {
            const outcome = await runTask(task, request.triggeredBy, 'run_now');
            await completeRunRequest(request.requestId, {
                status: outcome.started && outcome.success ? 'success' : 'failed',
                resultMessage: outcome.message,
                errorCode: outcome.started && outcome.success ? undefined : (outcome.code || 'TASK_RUN_FAILED'),
                errorMessage: outcome.started && outcome.success ? undefined : outcome.message,
            });
        })().catch(async (error) => {
            const message = error instanceof Error ? error.message : String(error);
            await completeRunRequest(request.requestId, {
                status: 'failed',
                resultMessage: message,
                errorCode: 'INTERNAL_ERROR',
                errorMessage: message,
            });
        });
    }
}

async function waitForRunRequestCompletion(
    requestId: string,
    timeoutMs: number,
): Promise<Awaited<ReturnType<typeof getRunRequest>> | undefined> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const request = await getRunRequest(requestId);
        if (!request) {
            return undefined;
        }
        if (request.status === 'success' || request.status === 'failed') {
            return request;
        }
        await sleep(500);
    }
    return getRunRequest(requestId);
}

async function handleCreate(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const CreateSchema = z.object({
        name: z.string().min(1, 'name 必填'),
        schedule_type: z.enum(['once', 'cron']),
        timezone: z.string().default(config.defaultTimezone).refine(isValidTimezone, '非法时区'),
        tool_name: z.string().min(1, 'tool_name 必填'),
        tool_params: toolParamsSchema.default({}),
        group_id: createGroupIdSchema,
        run_at: z.string().optional(),
        cron: z.string().optional(),
        enabled: z.union([z.boolean(), z.string().transform(parseBoolText)]).default(true),
        retries: z.coerce.number().min(0).default(config.defaultRetries),
        timeout_sec: z.coerce.number().min(1).default(config.defaultTimeoutSec),
        max_concurrency: z.coerce.number().min(1).default(config.defaultMaxConcurrency),
        notify_on_fail: z.union([z.boolean(), z.string().transform(parseBoolText)]).default(config.defaultNotifyOnFail),
    });

    const parsed = CreateSchema.safeParse(params);
    if (!parsed.success) return fail('INVALID_PARAMS', parsed.error.errors[0].message);
    const data = parsed.data;
    if (!config.allowedTools.includes(data.tool_name)) return buildDisallowedToolFailure(data.tool_name);

    const task: SchedulerTask = {
        taskId: makeTaskId(),
        name: data.name,
        scheduleType: data.schedule_type,
        timezone: data.timezone,
        toolName: data.tool_name,
        toolParams: data.tool_params,
        enabled: data.enabled !== undefined ? Boolean(data.enabled) : true,
        retries: data.retries,
        timeoutSec: data.timeout_sec,
        maxConcurrency: data.max_concurrency,
        notifyOnFail: data.notify_on_fail !== undefined ? Boolean(data.notify_on_fail) : config.defaultNotifyOnFail,
        createdBy: ctx.senderId,
        createdAt: new Date().toISOString(),
        updatedBy: ctx.senderId,
        updatedAt: new Date().toISOString(),
        lastStatus: 'never',
        runCount: 0,
        runningCount: 0,
        groupId: data.group_id ?? ctx.groupId,
    };

    const scheduleResult = applySchedule(task, data.schedule_type, data.run_at, data.cron);
    if (!scheduleResult.ok) return fail(scheduleResult.code, scheduleResult.message);

    tasks.set(task.taskId, task);
    await persistTask(task);

    return success('create', {
        message: '任务创建成功',
        data: {
            task_id: task.taskId,
            task: toPublicTask(task)
        },
    }, '任务创建成功');
}

async function handleUpdate(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const UpdateSchema = z.object({
        task_id: z.string().min(1, '缺少 task_id'),
        name: z.string().min(1).optional(),
        schedule_type: z.enum(['once', 'cron']).optional(),
        timezone: z.string().refine(t => isValidTimezone(t), '非法时区').optional(),
        tool_name: z.string().min(1).optional(),
        tool_params: toolParamsSchema.optional(),
        group_id: updateGroupIdSchema,
        run_at: z.string().optional(),
        cron: z.string().optional(),
        enabled: z.union([z.boolean(), z.string().transform(parseBoolText)]).optional(),
        retries: z.coerce.number().min(0).optional(),
        timeout_sec: z.coerce.number().min(1).optional(),
        max_concurrency: z.coerce.number().min(1).optional(),
        notify_on_fail: z.union([z.boolean(), z.string().transform(parseBoolText)]).optional(),
    });

    const taskIdRaw = params.task_id || params.id;
    if (typeof taskIdRaw !== 'string' || !taskIdRaw) return fail('INVALID_PARAMS', '缺少 task_id');

    const task = tasks.get(taskIdRaw);
    if (!task) return fail('TASK_NOT_FOUND', `任务不存在: ${taskIdRaw}`);

    const parsed = UpdateSchema.safeParse({ ...params, task_id: taskIdRaw });
    if (!parsed.success) return fail('INVALID_PARAMS', parsed.error.errors[0].message);
    const data = parsed.data;
    if (data.tool_name !== undefined && data.tool_name !== task.toolName && !config.allowedTools.includes(data.tool_name)) {
        return buildDisallowedToolFailure(data.tool_name);
    }

    const newTask = { ...task };
    const hasGroupIdOverride = hasOwnParam(params, 'group_id');

    if (data.name !== undefined) newTask.name = data.name;
    if (data.timezone !== undefined) newTask.timezone = data.timezone;
    if (data.tool_name !== undefined) newTask.toolName = data.tool_name;
    if (data.tool_params !== undefined) newTask.toolParams = data.tool_params;
    if (hasGroupIdOverride) newTask.groupId = data.group_id ?? undefined;
    if (data.enabled !== undefined) newTask.enabled = Boolean(data.enabled);
    if (data.retries !== undefined) newTask.retries = data.retries;
    if (data.timeout_sec !== undefined) newTask.timeoutSec = data.timeout_sec;
    if (data.max_concurrency !== undefined) newTask.maxConcurrency = data.max_concurrency;
    if (data.notify_on_fail !== undefined) newTask.notifyOnFail = Boolean(data.notify_on_fail);

    const newScheduleType = data.schedule_type || task.scheduleType;
    const runAt = data.run_at ?? task.runAt;
    const cron = data.cron ?? task.cron;
    const reapplySchedule = shouldReapplySchedule(task, {
        scheduleType: data.schedule_type,
        timezone: data.timezone,
        runAt: data.run_at,
        cron: data.cron,
        enabled: data.enabled,
    });

    if (reapplySchedule) {
        const scheduleResult = applySchedule(newTask, newScheduleType, runAt, cron);
        if (!scheduleResult.ok) return fail(scheduleResult.code, scheduleResult.message);
    } else if (!newTask.enabled) {
        newTask.nextRunTime = undefined;
    }

    newTask.updatedBy = ctx.senderId;
    newTask.updatedAt = new Date().toISOString();

    tasks.set(task.taskId, newTask);
    await persistTask(newTask);

    return success('update', {
        message: '任务更新成功',
        data: {
            result: 'updated',
            task_id: task.taskId,
            task: toPublicTask(newTask),
        },
    }, '任务更新成功');
}

function handleList(params: Record<string, unknown>): ToolResult {
    const ListSchema = z.object({
        page: z.coerce.number().min(1).default(1),
        page_size: z.coerce.number().min(1).max(config.maxPageSize).default(20),
        filters: z.union([
            z.string().transform((val) => {
                const parsed = safeParseJson(val);
                return isRecord(parsed) ? parsed : {};
            }),
            z.record(z.unknown())
        ]).default({})
    });

    const FiltersSchema = z.object({
        status: z.string().optional(),
        tool_name: z.string().optional(),
        created_by: z.coerce.number().optional(),
        enabled: z.union([z.boolean(), z.string().transform(parseBoolText)]).optional(),
    });

    const parsed = ListSchema.safeParse(params);
    if (!parsed.success) return fail('INVALID_PARAMS', parsed.error.errors[0].message);
    const data = parsed.data;

    const filtersParsed = FiltersSchema.safeParse(data.filters);
    const filters = filtersParsed.success ? filtersParsed.data : {};

    let items = Array.from(tasks.values());
    if (filters.status) items = items.filter(t => taskState(t) === filters.status);
    if (filters.tool_name) items = items.filter(t => t.toolName === filters.tool_name);
    if (typeof filters.created_by === 'number') items = items.filter(t => t.createdBy === filters.created_by);
    if (typeof filters.enabled === 'boolean') items = items.filter(t => t.enabled === filters.enabled);

    const total = items.length;
    const start = (data.page - 1) * data.page_size;
    const paged = items.slice(start, start + data.page_size).map(t => toListTask(t));

    return success('list', {
        message: '查询成功',
        data: {
            items: paged,
            pagination: { page: data.page, page_size: data.page_size, total, total_pages: Math.ceil(total / data.page_size) },
        },
    }, '查询成功');
}

async function handleGet(params: Record<string, unknown>): Promise<ToolResult> {
    const taskId = typeof params.task_id === 'string' ? params.task_id : (typeof params.id === 'string' ? params.id : '');
    if (!taskId) return fail('INVALID_PARAMS', '缺少 task_id');
    const task = tasks.get(taskId);
    if (!task) return fail('TASK_NOT_FOUND', `任务不存在: ${taskId}`);

    const logs = isWebOnlyProcess() ? await getTaskLogsFromDisk(taskId, 10) : getTaskLogs(taskId, 10);

    return success('get', {
        message: '查询成功',
        data: {
            task: toPublicTask(task),
            logs,
        },
    }, '查询成功');
}

async function handleDelete(params: Record<string, unknown>): Promise<ToolResult> {
    const taskId = typeof params.task_id === 'string' ? params.task_id : (typeof params.id === 'string' ? params.id : '');
    if (!taskId) return fail('INVALID_PARAMS', '缺少 task_id');
    if (!tasks.has(taskId)) return fail('TASK_NOT_FOUND', `任务不存在: ${taskId}`);

    tasks.delete(taskId);
    await persistTaskDeletion(taskId);
    return success('delete', {
        message: '任务已删除',
        data: { result: 'deleted', task_id: taskId },
    }, '任务已删除');
}

async function handleChangeStatus(params: Record<string, unknown>, ctx: ToolContext, isEnable: boolean): Promise<ToolResult> {
    const taskId = typeof params.task_id === 'string' ? params.task_id : (typeof params.id === 'string' ? params.id : '');
    if (!taskId) return fail('INVALID_PARAMS', '缺少 task_id');
    const task = tasks.get(taskId);
    if (!task) return fail('TASK_NOT_FOUND', `任务不存在: ${taskId}`);

    task.enabled = isEnable;
    task.updatedBy = ctx.senderId;
    task.updatedAt = new Date().toISOString();

    if (!task.enabled) {
        task.nextRunTime = undefined;
    } else {
        if (task.scheduleType === 'once' && task.runAt) {
            const t = Date.parse(task.runAt);
            if (!Number.isFinite(t) || t <= Date.now()) return fail('TIME_IN_PAST', '一次性任务 run_at 已过期，无法启用');
            task.nextRunTime = new Date(t).toISOString();
        }
        if (task.scheduleType === 'cron' && task.cron) {
            const next = computeNextCronRun(task.cron, task.timezone, new Date());
            task.nextRunTime = next ? next.toISOString() : undefined;
        }
    }

    await persistTask(task);

    return success(isEnable ? 'enable' : 'disable', {
        message: '状态更新成功',
        data: {
            result: isEnable ? 'enabled' : 'disabled',
            task_id: taskId,
            task: toPublicTask(task),
        },
    }, '状态更新成功');
}

async function handleRunNow(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const taskId = typeof params.task_id === 'string' ? params.task_id : (typeof params.id === 'string' ? params.id : '');
    if (!taskId) return fail('INVALID_PARAMS', '缺少 task_id');
    const task = tasks.get(taskId);
    if (!task) return fail('TASK_NOT_FOUND', `任务不存在: ${taskId}`);

    if (isWebOnlyProcess()) {
        const request = await enqueueRunRequest(taskId, ctx.senderId);
        const timeoutMs = Math.min(Math.max(task.timeoutSec * 1000 + 3000, 5000), 65000);
        const settled = await waitForRunRequestCompletion(request.requestId, timeoutMs);
        const latestTask = await getTaskFromDisk(taskId);
        const logItems = await getTaskLogsFromDisk(taskId, 10);

        if (!settled || settled.status === 'pending' || settled.status === 'running') {
            return success('run_now', {
                message: '任务已加入 genesis-agent 执行队列',
                data: {
                    result: 'queued',
                    request_id: request.requestId,
                    task_id: taskId,
                    task: latestTask ? toPublicTask(latestTask) : toPublicTask(task),
                    logs: logItems,
                },
            }, '任务已加入 genesis-agent 执行队列');
        }

        if (settled.status === 'failed') {
            return fail(settled.errorCode || 'TASK_RUN_FAILED', settled.errorMessage || settled.resultMessage || '执行失败', {
                request_id: settled.requestId,
                task_id: taskId,
                task: latestTask ? toPublicTask(latestTask) : toPublicTask(task),
                logs: logItems,
                last_status: latestTask?.lastStatus ?? task.lastStatus,
                last_error: latestTask?.lastError ?? task.lastError ?? null,
            });
        }

        return success('run_now', {
            message: settled.resultMessage || '任务执行成功',
            data: {
                result: 'executed',
                request_id: settled.requestId,
                task_id: taskId,
                task: latestTask ? toPublicTask(latestTask) : toPublicTask(task),
                logs: logItems,
                last_status: latestTask?.lastStatus ?? task.lastStatus,
                last_error: latestTask?.lastError ?? task.lastError ?? null,
            },
        }, '任务执行成功');
    }

    const outcome = await runTask(task, ctx.senderId, 'run_now');
    const logItems = getTaskLogs(taskId, 10);

    if (!outcome.started || !outcome.success) {
        return fail(outcome.code ?? 'TASK_RUN_FAILED', outcome.message, {
            task_id: taskId,
            task: toPublicTask(task),
            last_status: task.lastStatus,
            last_error: task.lastError ?? null,
            logs: logItems,
        });
    }

    return success('run_now', {
        message: '任务执行成功',
        data: {
            result: 'executed',
            task_id: taskId,
            task: toPublicTask(task),
            logs: logItems,
            last_status: task.lastStatus,
            last_error: task.lastError ?? null,
        },
    }, '任务执行成功');
}

export async function execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (isWebOnlyProcess()) {
        await refreshTasksFromDiskForWeb();
    } else {
        ensureSchedulerStarted();
    }

    try {
        const CommandSchema = z.object({ action: z.string().min(1) });
        const aliasParsed = CommandSchema.safeParse({ action: params.action ?? params.op ?? params.command });
        if (!aliasParsed.success) return fail('INVALID_ACTION', '缺少 action');

        const action = aliasParsed.data.action.toLowerCase();

        switch (action) {
            case 'create': return await handleCreate(params, ctx);
            case 'update': return await handleUpdate(params, ctx);
            case 'list': return handleList(params);
            case 'get': return await handleGet(params);
            case 'delete': return await handleDelete(params);
            case 'enable': return await handleChangeStatus(params, ctx, true);
            case 'disable': return await handleChangeStatus(params, ctx, false);
            case 'run_now': return await handleRunNow(params, ctx);
            default: return fail('INVALID_ACTION', `不支持的 action: ${action}`);
        }
    } catch (error) {
        log.error('[cron_scheduler] execute error', error);
        return fail('INTERNAL_ERROR', error instanceof Error ? error.message : '未知错误');
    }
}

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;

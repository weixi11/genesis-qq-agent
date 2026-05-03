/**
 * 定时调度器 Web API
 * 提供 cron_scheduler 的可视化管理接口
 */

import express from 'express';
import type { Router, Request, Response } from 'express';
import { z } from 'zod';
import { log } from '../../logger.js';

// 直接导入 cron_scheduler 模块
import cronScheduler from '../../tools/cron_scheduler/index.js';
import { config as schedulerConfig } from '../../tools/cron_scheduler/config.js';
import {
    getAllTasks,
    getAllTasksFromDisk,
    getRunRequest,
    getTaskFromDisk,
    getTaskLogs,
    getTaskLogsFromDisk,
} from '../../tools/cron_scheduler/store.js';
import { toPublicTask, taskState } from '../../tools/cron_scheduler/format.js';
import { getGenesisProcessRole, syncGenesisAgentProcess } from '../services/process_control.js';

export const schedulerRouter: Router = express.Router();

const toggleBodySchema = z.object({
    enabled: z.union([
        z.boolean(),
        z.string().transform((value) => value === 'true' || value === '1'),
        z.number().transform((value) => value !== 0),
    ]),
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getBodyParams(req: Request): Record<string, unknown> {
    return isRecord(req.body) ? req.body : {};
}

// 获取调度器配置
schedulerRouter.get('/scheduler/config', (_req: Request, res: Response) => {
    res.json({
        enabled: schedulerConfig.enabled,
        allowedTools: schedulerConfig.allowedTools,
        allowedToolsSource: schedulerConfig.allowedToolsSource,
        defaultTimezone: schedulerConfig.defaultTimezone,
        defaultRetries: schedulerConfig.defaultRetries,
        defaultTimeoutSec: schedulerConfig.defaultTimeoutSec,
        defaultMaxConcurrency: schedulerConfig.defaultMaxConcurrency,
        defaultNotifyOnFail: schedulerConfig.defaultNotifyOnFail,
        concurrency: schedulerConfig.concurrency,
        tickMs: schedulerConfig.tickMs,
    });
});

// 列出所有定时任务
schedulerRouter.get('/scheduler/tasks', async (_req: Request, res: Response) => {
    try {
        const tasks = getGenesisProcessRole() === 'web' ? await getAllTasksFromDisk() : getAllTasks();
        const result = tasks.map(t => ({
            ...toPublicTask(t),
            state: taskState(t),
        }));
        res.json({ success: true, tasks: result });
    } catch (err) {
        log.error('[scheduler-api] 获取任务列表失败:', err);
        res.status(500).json({ success: false, error: '获取任务列表失败' });
    }
});

// 获取任务详情 + 日志
schedulerRouter.get('/scheduler/tasks/:id', async (req: Request<{ id: string }>, res: Response) => {
    try {
        const taskId = req.params.id;
        const tasks = getGenesisProcessRole() === 'web' ? await getAllTasksFromDisk() : getAllTasks();
        const task = tasks.find(t => t.taskId === taskId);
        if (!task) {
            return res.status(404).json({ success: false, error: '任务不存在' });
        }
        const logs = getGenesisProcessRole() === 'web' ? await getTaskLogsFromDisk(taskId, 20) : getTaskLogs(taskId, 20);
        res.json({
            success: true,
            task: toPublicTask(task),
            logs,
        });
    } catch (err) {
        log.error('[scheduler-api] 获取任务详情失败:', err);
        res.status(500).json({ success: false, error: '获取任务详情失败' });
    }
});

async function maybeSyncAgentAfterSchedulerMutation(result: unknown): Promise<unknown> {
    if (getGenesisProcessRole() !== 'web') {
        return result;
    }

    if (!result || typeof result !== 'object') {
        return result;
    }

    const record = result as Record<string, unknown>;
    if (record.success === false) {
        return result;
    }

    const agentSync = await syncGenesisAgentProcess();
    return {
        ...record,
        agentSync,
        message: agentSync.applied
            ? record.message || '调度任务已更新，genesis-agent 已同步'
            : `${String(record.message || '调度任务已更新')}；genesis-agent 同步失败`,
    };
}

async function buildSchedulerRunRequestResponse(requestId: string) {
    const request = await getRunRequest(requestId);
    if (!request) {
        return { statusCode: 404, body: { success: false, error: '调度执行请求不存在' } };
    }

    const webOnly = getGenesisProcessRole() === 'web';
    const task = webOnly
        ? await getTaskFromDisk(request.taskId)
        : getAllTasks().find((item) => item.taskId === request.taskId);
    const logs = webOnly
        ? await getTaskLogsFromDisk(request.taskId, 10)
        : getTaskLogs(request.taskId, 10);
    const data = {
        request_id: request.requestId,
        task_id: request.taskId,
        task: task ? toPublicTask(task) : null,
        logs,
        last_status: task?.lastStatus ?? null,
        last_error: task?.lastError ?? null,
    };

    if (request.status === 'success') {
        return {
            statusCode: 200,
            body: {
                success: true,
                queued: true,
                completed: true,
                requestId: request.requestId,
                data: {
                    ...data,
                    result: 'executed',
                    message: request.resultMessage || '任务执行成功',
                },
            },
        };
    }

    if (request.status === 'failed') {
        const message = request.errorMessage || request.resultMessage || '执行失败';
        return {
            statusCode: 200,
            body: {
                success: false,
                queued: true,
                completed: true,
                requestId: request.requestId,
                error: message,
                data: {
                    ...data,
                    result: 'failed',
                    message,
                    error_code: request.errorCode || null,
                    error_message: request.errorMessage || null,
                },
            },
        };
    }

    return {
        statusCode: 200,
        body: {
            success: true,
            queued: true,
            completed: false,
            requestId: request.requestId,
            data: {
                ...data,
                result: 'queued',
                message: request.status === 'running'
                    ? '任务已被 genesis-agent 接收，正在执行中'
                    : '任务已加入 genesis-agent 执行队列',
            },
        },
    };
}

// 创建任务（通过 execute 函数调用）
schedulerRouter.post('/scheduler/tasks', async (req: Request, res: Response) => {
    try {
        const params = { action: 'create', ...getBodyParams(req) };
        const result = await cronScheduler.execute(params, { senderId: 0, groupId: undefined });
        res.json(await maybeSyncAgentAfterSchedulerMutation(result));
    } catch (err) {
        log.error('[scheduler-api] 创建任务失败:', err);
        res.status(500).json({ success: false, error: '创建任务失败' });
    }
});

// 更新任务
schedulerRouter.put('/scheduler/tasks/:id', async (req: Request, res: Response) => {
    try {
        const params = { action: 'update', task_id: req.params.id, ...getBodyParams(req) };
        const result = await cronScheduler.execute(params, { senderId: 0, groupId: undefined });
        res.json(await maybeSyncAgentAfterSchedulerMutation(result));
    } catch (err) {
        log.error('[scheduler-api] 更新任务失败:', err);
        res.status(500).json({ success: false, error: '更新任务失败' });
    }
});

// 删除任务
schedulerRouter.delete('/scheduler/tasks/:id', async (req: Request, res: Response) => {
    try {
        const params = { action: 'delete', task_id: req.params.id };
        const result = await cronScheduler.execute(params, { senderId: 0, groupId: undefined });
        res.json(await maybeSyncAgentAfterSchedulerMutation(result));
    } catch (err) {
        log.error('[scheduler-api] 删除任务失败:', err);
        res.status(500).json({ success: false, error: '删除任务失败' });
    }
});

// 启用/禁用任务
schedulerRouter.post('/scheduler/tasks/:id/toggle', async (req: Request, res: Response) => {
    try {
        const parsed = toggleBodySchema.safeParse(getBodyParams(req));
        if (!parsed.success) {
            return res.status(400).json({ success: false, error: 'enabled 字段无效' });
        }
        const enabled = parsed.data.enabled;
        const action = enabled ? 'enable' : 'disable';
        const params = { action, task_id: req.params.id };
        const result = await cronScheduler.execute(params, { senderId: 0, groupId: undefined });
        res.json(await maybeSyncAgentAfterSchedulerMutation(result));
    } catch (err) {
        log.error('[scheduler-api] 切换任务状态失败:', err);
        res.status(500).json({ success: false, error: '切换任务状态失败' });
    }
});

// 立即执行任务
schedulerRouter.post('/scheduler/tasks/:id/run', async (req: Request, res: Response) => {
    try {
        const params = { action: 'run_now', task_id: req.params.id };
        const result = await cronScheduler.execute(params, { senderId: 0, groupId: undefined });
        res.json(result);
    } catch (err) {
        log.error('[scheduler-api] 执行任务失败:', err);
        res.status(500).json({ success: false, error: '执行任务失败' });
    }
});

schedulerRouter.get('/scheduler/run-requests/:requestId', async (req: Request<{ requestId: string }>, res: Response) => {
    try {
        const response = await buildSchedulerRunRequestResponse(req.params.requestId);
        res.status(response.statusCode).json(response.body);
    } catch (err) {
        log.error('[scheduler-api] 获取执行请求状态失败:', err);
        res.status(500).json({ success: false, error: '获取执行请求状态失败' });
    }
});

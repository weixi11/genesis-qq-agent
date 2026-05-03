import { config } from './config.js';
import { schema } from './schema.js';
import { isMaster } from '../../utils/identity.js';
import { toolStats, type ToolUsageParams } from '../../web/store/tool_stats.js';
import { getStringParam, parseInteger, stringifyForDisplay, truncateText } from '../../utils/format.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

export const name = 'tool_log';
export const description = '查看最近工具执行日志和失败记录（仅主人可用）';
export const keywords = ['工具日志', '查看日志', '最近失败', '看看工具日志', '工具报错', '最近工具调用'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

type LogAction = 'recent' | 'failures' | 'summary';

interface QueryOptions {
    action: LogAction;
    toolName?: string;
    limit: number;
    userId?: number;
    taskId?: string;
    includeParams: boolean;
    includeResult: boolean;
}

function parseAction(params: Record<string, unknown>): LogAction | null {
    const action = getStringParam(params, 'action');
    if (action === 'recent' || action === 'failures' || action === 'summary') {
        return action;
    }
    return null;
}

function parseOptions(params: Record<string, unknown>): QueryOptions | null {
    const action = parseAction(params);
    if (!action) return null;

    const rawLimit = parseInteger(params.limit);
    const limit = Math.min(config.maxLimit, Math.max(1, rawLimit ?? config.defaultLimit));
    const includeParams = params.includeParams !== false;
    const includeResult = params.includeResult !== false;
    const userId = parseInteger(params.userId);
    const toolName = getStringParam(params, 'toolName') ?? getStringParam(params, 'tool_name');
    const taskId = getStringParam(params, 'taskId') ?? getStringParam(params, 'task_id');

    return {
        action,
        toolName,
        limit,
        userId,
        taskId,
        includeParams,
        includeResult,
    };
}

function matchesFilters(logItem: ToolUsageParams, options: QueryOptions): boolean {
    if (options.toolName && logItem.name !== options.toolName) return false;
    if (options.userId !== undefined && logItem.user.id !== options.userId) return false;
    if (options.taskId && logItem.taskId !== options.taskId) return false;
    if (options.action === 'failures' && logItem.success) return false;
    return true;
}

function formatLogLine(logItem: ToolUsageParams, options: QueryOptions): string {
    const header = `${new Date(logItem.time).toLocaleString('zh-CN', { hour12: false })} | ${logItem.success ? '✅成功' : '❌失败'} | ${logItem.name} | ${logItem.duration}ms | ${logItem.user.name || '未知用户'}(${logItem.user.id})`;
    const lines = [header];

    if (options.includeParams) {
        lines.push(`  params: ${stringifyForDisplay(logItem.params, { maxLen: config.maxParamsLength })}`);
    }
    if (options.includeResult) {
        lines.push(`  result: ${truncateText(logItem.result || '(空结果)', config.maxResultLength)}`);
    }
    if (logItem.taskId) {
        lines.push(`  taskId: ${logItem.taskId}`);
    }

    return lines.join('\n');
}

function renderRecentLogs(options: QueryOptions, logs: ToolUsageParams[]): ToolResult {
    if (logs.length === 0) {
        return { success: true, text: '最近没有匹配的工具日志。', data: { logs: [] } };
    }

    const title = options.action === 'failures' ? '最近失败日志' : '最近工具日志';
    const scope = options.toolName ? ` [${options.toolName}]` : '';
    const text = [
        `📒 ${title}${scope}`,
        ...logs.map((logItem) => formatLogLine(logItem, options)),
    ].join('\n\n');

    return { success: true, text, data: { logs } };
}

function renderSummary(logs: ToolUsageParams[], toolName?: string): ToolResult {
    if (logs.length === 0) {
        return { success: true, text: '最近没有匹配的工具日志。', data: { summary: [] } };
    }

    const summaryMap = new Map<string, { total: number; failures: number; latest: number }>();
    for (const logItem of logs) {
        const current = summaryMap.get(logItem.name) ?? { total: 0, failures: 0, latest: 0 };
        current.total += 1;
        current.failures += logItem.success ? 0 : 1;
        current.latest = Math.max(current.latest, logItem.time);
        summaryMap.set(logItem.name, current);
    }

    const summary = Array.from(summaryMap.entries())
        .map(([name, stats]) => ({
            name,
            total: stats.total,
            failures: stats.failures,
            successRate: `${Math.round(((stats.total - stats.failures) / stats.total) * 100)}%`,
            latest: new Date(stats.latest).toLocaleString('zh-CN', { hour12: false }),
        }))
        .sort((left, right) => right.total - left.total);

    const title = toolName ? `📊 工具日志摘要 [${toolName}]` : '📊 工具日志摘要';
    const text = [
        title,
        ...summary.map(item => `- ${item.name}: 总 ${item.total} 次，失败 ${item.failures} 次，成功率 ${item.successRate}，最近 ${item.latest}`),
    ].join('\n');

    return { success: true, text, data: { summary } };
}

export function execute(
    params: Record<string, unknown>,
    ctx: ToolContext,
): Promise<ToolResult> {
    if (!isMaster(ctx.senderId)) {
        return Promise.resolve({ success: false, text: '权限不足：只有主人才能查看工具日志哦~' });
    }

    const options = parseOptions(params);
    if (!options) {
        return Promise.resolve({ success: false, text: '参数错误：action 必须是 recent / failures / summary 之一。' });
    }

    const matchedLogs = toolStats.getLogs()
        .filter(logItem => matchesFilters(logItem, options))
        .slice(0, options.limit);

    if (options.action === 'summary') {
        return Promise.resolve(renderSummary(matchedLogs, options.toolName));
    }

    return Promise.resolve(renderRecentLogs(options, matchedLogs));
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;

/**
 * Task Detail 模块 - 查询任务的详细信息
 *
 * 与 task_status 不同，本工具返回任务的完整详情，
 * 包括调用参数、完整执行结果、错误信息、时间线等。
 */

import { taskManager } from '../../task/index.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Module, ModuleContext, ModuleResult } from '../types.js';
import { safeJsonStringify, stringifyForDisplay, truncateText } from '../../utils/format.js';

// ==================== 模块元数据 ====================

export const name = 'task_detail';
export const description = '查询任务的详细信息（参数、完整结果、错误、耗时等）';
export const keywords = ['任务详情', '任务结果', '看看参数', '执行结果', '任务信息'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 常量 ====================

/** 查询时排除的工具（避免查到自己） */
const SELF_EXCLUDED_TOOLS = ['task_detail', 'task_status', 'task_cancel'];

const TOOL_NAME_MAP: Record<string, string> = {
    draw: '绘图',
    vision: '识图',
    weather: '天气查询',
    music: '音乐搜索',
    cloud_music: '音乐搜索',
    read_video: '视频分析',
    read_audio: '音频分析',
    read_file: '文件解析',
    like: '点赞',
    poke: '戳一戳',
    profile: '画像查询',
    blog_article: '博客文章',
    blog_category: '博客分类',
    blog_tag: '博客标签',
    search_web: '网页搜索',
    anime_trace: '以图搜番',
    mute: '禁言',
    system_status: '系统状态',
};

const STATUS_MAP: Record<string, string> = {
    pending: '⏳ 等待执行',
    running: '🔄 正在执行',
    success: '✅ 执行成功',
    failed: '❌ 执行失败',
    timeout: '⏰ 执行超时',
    cancelled: '🚫 已取消',
};

const PRIORITY_MAP: Record<string, string> = {
    high: '🔴 高',
    normal: '🔵 中',
    low: '⚪ 低',
};

/** 结果文本最大长度 */
const MAX_RESULT_TEXT_LENGTH = 500;

/** 参数 JSON 最大长度 */
const MAX_PARAMS_TEXT_LENGTH = 300;

// ==================== 辅助函数 ====================

function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

function formatDuration(startedAt: number | undefined, finishedAt: number | undefined): string {
    if (finishedAt && startedAt) {
        const ms = finishedAt - startedAt;
        if (ms < 1000) return `${ms}ms`;
        return `${(ms / 1000).toFixed(1)}s`;
    }
    if (startedAt) {
        const ms = Date.now() - startedAt;
        return `${(ms / 1000).toFixed(1)}s (进行中)`;
    }
    return '-';
}

function formatParams(params: Record<string, unknown>): string {
    const json = safeJsonStringify(params, 2);
    if (json) {
        return truncateText(json, MAX_PARAMS_TEXT_LENGTH);
    }
    return stringifyForDisplay(params, { maxLen: MAX_PARAMS_TEXT_LENGTH });
}

// ==================== 模块执行 ====================

export function execute(
    params: Record<string, unknown>,
    ctx: ModuleContext
): Promise<ModuleResult> {
    const userId = ctx.senderId;
    if (userId === undefined || userId === null) {
        return Promise.resolve({ success: false, text: '无法识别用户身份' });
    }

    const taskId = params.taskId as string | undefined;
    const toolName = params.toolName as string | undefined;
    const isTestMode = userId === 0;

    // 查找任务
    let task;

    if (taskId) {
        // 按 ID 查找（支持短 ID）
        task = taskManager.getTask(taskId);
        if (!task) {
            // 尝试短 ID 匹配
            const allTasks = taskManager.getAllTasks(200);
            task = allTasks.find(t => t.id.startsWith(taskId));
        }
    } else if (toolName) {
        // 按工具名查找最近任务
        task = isTestMode
            ? taskManager.getAllToolTaskExcluding(toolName, SELF_EXCLUDED_TOOLS)
            : taskManager.getUserToolTaskExcluding(userId, toolName, SELF_EXCLUDED_TOOLS);
    } else {
        // 查找最近一个任务
        const tasks = isTestMode
            ? taskManager.getAllTasksExcluding(SELF_EXCLUDED_TOOLS, 1)
            : taskManager.getUserTasksExcluding(userId, SELF_EXCLUDED_TOOLS, 1);
        task = tasks[0];
    }

    if (!task) {
        return Promise.resolve({
            success: true,
            text: '没有找到相关的任务记录哦~ 先发起一个任务请求试试吧！',
        });
    }

    // 构建详情文本
    const toolLabel = TOOL_NAME_MAP[task.toolName] || task.toolName;
    const status = STATUS_MAP[task.status] || task.status;
    const priority = PRIORITY_MAP[task.priority] || task.priority || '-';
    const duration = formatDuration(task.startedAt, task.finishedAt);

    const lines: string[] = [
        `📋 **任务详情** [${task.id.slice(0, 8)}]`,
        '',
        `🔧 工具: ${toolLabel} (${task.toolName})`,
        `👤 用户: ${task.userId}`,
        `📊 状态: ${status}`,
        `⚡ 优先级: ${priority}`,
        `🕐 创建时间: ${formatTimestamp(task.createdAt)}`,
        `⏱️ 耗时: ${duration}`,
    ];

    // 开始 / 完成时间
    if (task.startedAt) {
        lines.push(`▶️ 开始时间: ${formatTimestamp(task.startedAt)}`);
    }
    if (task.finishedAt) {
        lines.push(`⏹️ 完成时间: ${formatTimestamp(task.finishedAt)}`);
    }

    // 参数
    lines.push('');
    lines.push('📝 **调用参数:**');
    lines.push(formatParams(task.params));

    // 执行结果
    lines.push('');
    if (task.result) {
        lines.push(`📤 **执行结果** (${task.result.success ? '成功' : '失败'}):`);
        lines.push(truncateText(task.result.text, MAX_RESULT_TEXT_LENGTH));
    } else if (task.status === 'pending' || task.status === 'running') {
        lines.push('📤 **执行结果:** (任务尚未完成)');
    } else {
        lines.push('📤 **执行结果:** (无结果)');
    }

    // 错误信息
    if (task.error) {
        lines.push('');
        lines.push(`⚠️ **错误信息:** ${task.error}`);
    }

    // 重试信息
    if (task.retryCount > 0) {
        lines.push('');
        lines.push(`🔁 已重试: ${task.retryCount}/${task.maxRetries} 次`);
    }

    return Promise.resolve({
        success: true,
        text: lines.join('\n'),
        data: {
            taskId: task.id,
            toolName: task.toolName,
            status: task.status,
            params: task.params,
            result: task.result,
            error: task.error,
        },
    });
}

// ==================== 任务配置 ====================

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

// ==================== 默认导出 ====================

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Module;

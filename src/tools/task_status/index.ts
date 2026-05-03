/**
 * Task Status 模块 - 查询任务执行状态
 */

import { taskManager } from '../../task/index.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Module, ModuleContext, ModuleResult } from '../types.js';

// ==================== 模块元数据 ====================

export const name = 'task_status';
export const description = '查询我的任务状态，比如"我的画完成了没"、"任务进度"';
export const keywords = ['任务', '进度', '完成了没', '好了吗', '画好了吗', '任务状态'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 常量 ====================

/** 查询时排除的工具（避免查到自己） */
const SELF_EXCLUDED_TOOLS = ['task_status', 'task_cancel'];

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
};

const STATUS_MAP: Record<string, string> = {
    pending: '⏳ 等待执行中...',
    running: '🔄 正在执行中...',
    success: '✅ 已完成！',
    failed: '❌ 执行失败',
    timeout: '⏰ 执行超时',
    cancelled: '🚫 已取消',
};

// ==================== 模块执行 ====================

export function execute(
    params: Record<string, unknown>,
    ctx: ModuleContext
): Promise<ModuleResult> {
    const userId = ctx.senderId;
    if (userId === undefined || userId === null) {
        return Promise.resolve({ success: false, text: '无法识别用户身份' });
    }

    const toolName = params.toolName as string | undefined;

    // 使用 Excluding 方法排除 task_status/task_cancel 自身，避免查到自己
    // 当 senderId 为 0 时（Web 测试），查询所有用户的任务
    const isTestMode = userId === 0;

    let task;
    if (toolName) {
        task = isTestMode
            ? taskManager.getAllToolTaskExcluding(toolName, SELF_EXCLUDED_TOOLS)
            : taskManager.getUserToolTaskExcluding(userId, toolName, SELF_EXCLUDED_TOOLS);
    } else {
        task = isTestMode
            ? taskManager.getAllTasksExcluding(SELF_EXCLUDED_TOOLS, 1)[0]
            : taskManager.getUserTasksExcluding(userId, SELF_EXCLUDED_TOOLS, 1)[0];
    }

    if (!task) {
        return Promise.resolve({
            success: true,
            text: '暂时没有找到你的任务记录哦~ 发起一个请求试试吧！',
        });
    }

    const toolLabel = TOOL_NAME_MAP[task.toolName] || task.toolName;
    const status = STATUS_MAP[task.status] || task.status;

    let response = `📋 **${toolLabel}任务状态**\n${status}`;

    if (task.status === 'running' && task.startedAt) {
        const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
        response += `\n⏱️ 已耗时: ${elapsed}秒`;
    }

    if (task.status === 'success' && task.result) {
        const resultText = task.result.text.length > 100
            ? task.result.text.slice(0, 100) + '...'
            : task.result.text;
        response += `\n\n📝 结果预览:\n${resultText}`;
    }

    if ((task.status === 'failed' || task.status === 'timeout') && task.error) {
        response += `\n\n⚠️ 错误: ${task.error}`;
    }

    if (!toolName) {
        response = `📋 **你的最近任务 (${toolLabel})**\n${status}`;
        if (task.status === 'running' && task.startedAt) {
            const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
            response += `\n⏱️ 已耗时: ${elapsed}秒`;
        }
    }

    return Promise.resolve({ success: true, text: response });
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Module;

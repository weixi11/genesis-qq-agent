/**
 * Task Cancel 模块 - 取消正在等待的任务
 */

import { taskManager } from '../../task/index.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Module, ModuleContext, ModuleResult } from '../types.js';

// ==================== 模块元数据 ====================

export const name = 'task_cancel';
export const description = '取消正在等待的任务，比如"不要了"、"取消绘图"';
export const keywords = ['取消', '不要了', '别画了', '别做了', '停止', '算了'];

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

    // 当 senderId 为 0 时（Web 测试），查询所有用户的可取消任务
    const cancellableTasks = userId === 0
        ? taskManager.getAllCancellableTasks(SELF_EXCLUDED_TOOLS)
        : taskManager.getCancellableTasks(userId, SELF_EXCLUDED_TOOLS);

    if (cancellableTasks.length === 0) {
        return Promise.resolve({
            success: true,
            text: '没有找到可以取消的任务哦~ 只有等待中或执行中的任务可以取消',
        });
    }

    const toolName = params.toolName as string | undefined;
    let taskToCancel = cancellableTasks[0];

    if (toolName) {
        const found = cancellableTasks.find(t => t.toolName === toolName);
        if (found) {
            taskToCancel = found;
        } else {
            const toolLabel = TOOL_NAME_MAP[toolName] || toolName;
            return Promise.resolve({
                success: true,
                text: `没有找到等待中的${toolLabel}任务`,
            });
        }
    }

    const wasRunning = taskToCancel.status === 'running';
    const cancelled = taskManager.cancelTask(taskToCancel.id);

    if (cancelled) {
        const toolLabel = TOOL_NAME_MAP[taskToCancel.toolName] || taskToCancel.toolName;
        return Promise.resolve({
            success: true,
            text: wasRunning
                ? `✅ 已请求取消${toolLabel}任务，若该任务正在收尾，结果将不会再记为成功`
                : `✅ 已取消${toolLabel}任务`,
        });
    } else {
        return Promise.resolve({
            success: false,
            text: '取消失败，任务可能已经开始执行了',
        });
    }
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Module;

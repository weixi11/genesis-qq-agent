/**
 * Like 模块
 * 
 * 给用户点赞（支持多人）
 */

import { log } from '../../logger.js';
import { connector } from '../../connector.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Module, ModuleContext, ModuleResult } from '../types.js';
import { parseInteger } from '../../utils/format.js';

// ==================== 模块元数据 ====================

export const name = 'like';
export const description = '给用户点赞';
export const keywords = ['点赞', '赞一下', '给.+赞', '点个赞', '赞他', '赞她', '赞我'];

/** 是否启用 */
export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 模块执行 ====================

/**
 * 执行点赞（支持多人）
 */
export async function execute(
    params: Record<string, unknown>,
    ctx: ModuleContext
): Promise<ModuleResult> {
    // 收集所有目标用户
    const targetUsers: number[] = [];

    // 优先级 1: 显式参数（支持 targetId 和 userId）
    const targetId = params.targetId || params.userId;
    if (targetId) {
        const id = parseInteger(targetId);
        if (id !== undefined) targetUsers.push(id);
    }
    // 优先级 2: 上下文 @提及 (仅当没有显式参数时使用)
    else if (ctx.atUsers && ctx.atUsers.length > 0) {
        const atUsers = ctx.atUsers.filter(id => id !== config.botQQ);
        targetUsers.push(...atUsers);
    }
    // 优先级 3: 发送者自己 (如果没有目标)
    else if (ctx.senderId) {
        targetUsers.push(ctx.senderId);
    }

    if (targetUsers.length === 0) {
        return { success: false, text: '要给谁点赞呀？@一下那个人或者告诉我QQ号喵~' };
    }

    const times = (params.times as number) || 10;
    log.info(`🔧 模块: 给 ${targetUsers.join(', ')} 点赞 ${times} 次`);

    // 并行给所有用户点赞
    const successUsers: number[] = [];
    const failedUsers: number[] = [];

    await Promise.all(
        targetUsers.map(async (userId) => {
            try {
                await connector.rpc('user.sendLike', [userId, times]);
                successUsers.push(userId);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                log.warn(`点赞 ${userId} 失败:`, message);
                failedUsers.push(userId);
            }
        })
    );

    // 构建结果文本
    const results: string[] = [];
    if (successUsers.length > 0) {
        if (successUsers.length === 1) {
            results.push(`已给 ${successUsers[0]} 点了 ${times} 个赞 💕`);
        } else {
            results.push(`已给 ${successUsers.length} 人各点了 ${times} 个赞 💕`);
            results.push(`成功: ${successUsers.join(', ')}`);
        }
    }

    if (failedUsers.length > 0) {
        results.push(`点赞失败: ${failedUsers.join(', ')}`);
    }

    return {
        success: successUsers.length > 0,
        text: results.join('\n'),
        data: { successUsers, failedUsers, times },
    };
}

// ==================== 默认导出 ====================

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Module;

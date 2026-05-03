/**
 * Poke 模块 - 戳一戳用户（支持多人）
 */

import { log } from '../../logger.js';
import { connector } from '../../connector.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Module, ModuleContext, ModuleResult } from '../types.js';
import { parseInteger } from '../../utils/format.js';

export const name = 'poke';
export const description = '戳一戳用户';
export const keywords = ['戳一戳', '戳一下', '戳他', '戳她', '戳他们'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

export async function execute(
    params: Record<string, unknown>,
    ctx: ModuleContext
): Promise<ModuleResult> {
    const targetSet = new Set<number>();

    const targetId = params.targetId || params.userId;
    if (targetId) {
        const id = parseInteger(targetId);
        if (id !== undefined && id !== config.botQQ) targetSet.add(id);
    } else {
        const atUsers = ctx.atUsers || [];
        for (const userId of atUsers) {
            if (userId && typeof userId === 'number' && userId !== config.botQQ) {
                targetSet.add(userId);
            }
        }
    }

    const targetUsers = Array.from(targetSet);

    if (targetUsers.length === 0) {
        return { success: false, text: '要戳谁呀？@一下那个人喵~' };
    }

    let times = 1;
    if (params.times !== undefined) {
        const parsed = Number(params.times);
        if (!isNaN(parsed) && parsed > 0) {
            times = Math.min(10, Math.floor(parsed));
        }
    }

    log.info(`🔧 模块: 戳一戳 ${targetUsers.join(', ')} ${times}次${ctx.groupId ? ` (群${ctx.groupId})` : ''}`);

    const successUsers: number[] = [];
    const failedUsers: number[] = [];

    await Promise.all(
        targetUsers.map(async (userId) => {
            try {
                for (let i = 0; i < times; i++) {
                    await connector.rpc('user.sendPoke', [userId, ctx.groupId]);
                    if (i < times - 1) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
                successUsers.push(userId);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                log.warn(`戳 ${userId} 失败:`, message);
                failedUsers.push(userId);
            }
        })
    );

    const results: string[] = [];
    if (successUsers.length > 0) {
        if (successUsers.length === 1) {
            results.push(`戳了 ${successUsers[0]} ${times}下~ 👉👈`);
        } else {
            results.push(`戳了 ${successUsers.length} 个人各 ${times}下~ 👉👈`);
            results.push(`被戳: ${successUsers.join(', ')}`);
        }
    }

    if (failedUsers.length > 0) {
        results.push(`戳失败: ${failedUsers.join(', ')}`);
    }

    return {
        success: successUsers.length > 0,
        text: results.join('\n'),
        data: { successUsers, failedUsers, groupId: ctx.groupId },
    };
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Module;

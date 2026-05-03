/**
 * Mute Status 模块 - 查询群内所有被禁言成员
 */

import { log } from '../../logger.js';
import { connector } from '../../connector.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { parseInteger, resolveOptionalGroupId } from '../../utils/format.js';

// ==================== 模块元数据 ====================

export const name = 'mute_status';
export const description = '查询群内所有被禁言成员';
export const keywords = ['禁言状态', '谁被禁言', '禁言列表', '禁言了谁', '有谁被禁'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 类型定义 ====================

interface GroupMemberInfo {
    user_id: number;
    role: 'owner' | 'admin' | 'member';
    card?: string;
    nickname?: string;
    shut_up_timestamp?: number;  // 禁言解除时间戳（秒）
}

interface MutedMember {
    userId: number;
    name: string;
    remainingSeconds: number;
    remainingText: string;
    unlockTime: string;
}

// ==================== 内部函数 ====================

/**
 * 获取群成员列表
 */
async function getGroupMemberList(groupId: number): Promise<GroupMemberInfo[]> {
    try {
        const result = await connector.callData<GroupMemberInfo[]>('get_group_member_list', {
            group_id: groupId,
            no_cache: true,
        });
        return result || [];
    } catch (err) {
        log.warn(`获取群成员列表失败: ${groupId}`, err);
        return [];
    }
}

/**
 * 格式化剩余时间
 */
function formatDuration(seconds: number): string {
    if (seconds <= 0) return '已解除';

    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分钟`);

    return parts.join('') || '不到1分钟';
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    ctx: ToolContext
): Promise<ToolResult> {
    // 1. 获取群号
    const rawGroupId = params.groupId ?? params.group_id;
    const groupId = resolveOptionalGroupId(rawGroupId, ctx.groupId);

    if (!groupId || isNaN(groupId)) {
        return { success: false, text: '请指定群号喵~' };
    }

    // 2. 获取群成员列表
    log.debug(`查询群 ${groupId} 禁言列表`);

    const members = await getGroupMemberList(groupId);
    if (members.length === 0) {
        return { success: false, text: '获取群成员列表失败，可能没有权限喵~' };
    }

    // 3. 筛选被禁言的成员
    const now = Math.floor(Date.now() / 1000);
    const mutedMembers: MutedMember[] = [];

    for (const member of members) {
        const shutUpTimestamp = member.shut_up_timestamp || 0;
        if (shutUpTimestamp > now) {
            const remainingSeconds = shutUpTimestamp - now;
            mutedMembers.push({
                userId: member.user_id,
                name: member.card || member.nickname || String(member.user_id),
                remainingSeconds,
                remainingText: formatDuration(remainingSeconds),
                unlockTime: new Date(shutUpTimestamp * 1000).toLocaleString('zh-CN'),
            });
        }
    }

    // 4. 按剩余时间排序（时间长的在前）
    mutedMembers.sort((a, b) => b.remainingSeconds - a.remainingSeconds);

    // 5. 构建响应
    if (mutedMembers.length === 0) {
        return {
            success: true,
            text: `群 ${groupId} 当前没有人被禁言哦~`,
            data: { groupId, mutedCount: 0, mutedMembers: [] },
        };
    }

    // 格式化列表
    const listText = mutedMembers
        .map((m, i) => `${i + 1}. ${m.name}(${m.userId}) - 剩余${m.remainingText}`)
        .join('\n');

    return {
        success: true,
        text: `群 ${groupId} 共有 ${mutedMembers.length} 人被禁言 🔇\n\n${listText}`,
        data: {
            groupId,
            mutedCount: mutedMembers.length,
            mutedMembers,
        },
    };
}

// ==================== 任务配置 ====================

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

// ==================== 默认导出 ====================

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;

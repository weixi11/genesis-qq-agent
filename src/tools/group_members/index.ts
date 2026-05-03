/**
 * Group Members 模块 - 查询本群的全部群成员
 */

import { log } from '../../logger.js';
import { connector } from '../../connector.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { parseInteger, resolveOptionalGroupId } from '../../utils/format.js';

// ==================== 模块元数据 ====================

export const name = 'group_members';
export const description = '查询本群的全部群成员列表';
export const keywords = ['群成员', '群里有谁', '多少人', '成员列表', '群友', '群员'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 类型定义 ====================

interface GroupMemberInfo {
    user_id: number;
    role: 'owner' | 'admin' | 'member';
    card?: string;      // 群昵称（群名片）
    nickname?: string;  // QQ 昵称
}

interface MemberDisplay {
    userId: number;
    name: string;       // 优先显示群昵称，没有则显示 QQ 昵称
    role: 'owner' | 'admin' | 'member';
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
 * 获取角色显示名称
 */
function getRoleLabel(role: 'owner' | 'admin' | 'member'): string {
    switch (role) {
        case 'owner':
            return '👑群主';
        case 'admin':
            return '🔧管理';
        default:
            return '👤成员';
    }
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
    log.debug(`查询群 ${groupId} 成员列表`);

    const members = await getGroupMemberList(groupId);
    if (members.length === 0) {
        return { success: false, text: '获取群成员列表失败，可能没有权限喵~' };
    }

    // 3. 处理成员信息
    const memberList: MemberDisplay[] = members.map(member => ({
        userId: member.user_id,
        name: member.card || member.nickname || String(member.user_id),
        role: member.role,
    }));

    // 4. 按角色排序：群主 > 管理 > 普通成员
    const roleOrder: Record<string, number> = { owner: 0, admin: 1, member: 2 };
    memberList.sort((a, b) => roleOrder[a.role] - roleOrder[b.role]);

    // 5. 统计角色分布
    const ownerCount = memberList.filter(m => m.role === 'owner').length;
    const adminCount = memberList.filter(m => m.role === 'admin').length;
    const memberCount = memberList.filter(m => m.role === 'member').length;

    // 6. 格式化列表
    const listText = memberList
        .map((m, i) => `${i + 1}. ${getRoleLabel(m.role)} ${m.name}(${m.userId})`)
        .join('\n');

    // 7. 构建响应
    const summaryText = `群 ${groupId} 共有 ${members.length} 人\n` +
        `👑群主: ${ownerCount} | 🔧管理: ${adminCount} | 👤成员: ${memberCount}`;

    return {
        success: true,
        text: `${summaryText}\n\n${listText}`,
        data: {
            groupId,
            totalCount: members.length,
            ownerCount,
            adminCount,
            memberCount,
            members: memberList,
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

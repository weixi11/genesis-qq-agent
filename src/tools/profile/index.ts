/**
 * Profile 模块 - 查询用户资料（支持多人、含群信息）
 */

import { log } from '../../logger.js';
import { connector } from '../../connector.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Module, ModuleContext, ModuleResult } from '../types.js';
import { parseInteger } from '../../utils/format.js';

// ==================== 类型定义 ====================

interface NapCatUserInfo {
    user_id: number;
    nickname: string;
    sex: 'male' | 'female' | 'unknown';
    age: number;
    qqLevel?: number;
    level?: number;
    long_nick?: string;
    longNick?: string;
    sign?: string;
    reg_time?: number;
    regTime?: number;
    nick?: string;
}

interface NapCatGroupMemberInfo {
    user_id: number;
    nickname: string;
    card: string;
    role: 'owner' | 'admin' | 'member';
    join_time?: number;
    joinTime?: number;
}

interface NapCatGroupInfo {
    group_id: number;
    group_name: string;
    groupName?: string;
    member_count: number;
}

// ==================== 模块元数据 ====================

export const name = 'profile';
export const description = '查询QQ用户资料';
export const keywords = ['查.*资料', '是谁', '个人资料', '查询.*信息', '他呢', '她呢', '这人', '那人', '这位', '那位'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 内部函数 ====================

function formatTime(timestamp: number): string {
    if (!timestamp) return '未知';
    const date = new Date(timestamp * 1000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function queryUser(userId: number, groupId?: number): Promise<string> {
    try {
        const response = await connector.rpc<{ data: NapCatUserInfo }>('user.info', [userId, false]);
        const data = response?.data;

        if (!data || (!data.user_id && !data.nickname && !data.nick)) {
            return `❌ ${userId}: 查不到资料`;
        }

        const lines: string[] = [];

        const nickname = data.nickname || data.nick || '未知';
        const sex = data.sex === 'male' ? '♂男' : data.sex === 'female' ? '♀女' : '未知';
        const age = data.age > 0 ? data.age : '保密';
        const qqLevel = data.qqLevel || data.level || 0;
        const sign = data.long_nick || data.longNick || data.sign || '';
        const regTime = formatTime(data.reg_time || data.regTime || 0);

        lines.push(`👤 ${nickname} (${userId})`);
        lines.push(`   性别: ${sex} | 年龄: ${age} | QQ等级: Lv.${qqLevel}`);
        lines.push(`   注册: ${regTime}`);

        const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=640`;
        lines.push(`   头像: ${avatarUrl}`);

        if (groupId) {
            try {
                const response = await connector.rpc<{ data: NapCatGroupMemberInfo }>('group.memberInfo', [groupId, userId, false]);
                const member = response?.data;

                if (member) {
                    const groupNick = member.card || member.nickname || nickname;
                    const joinTime = formatTime(member.join_time || member.joinTime || 0);
                    const role = member.role === 'owner' ? '👑群主' : member.role === 'admin' ? '🔧管理' : '👤成员';

                    lines.push(`   ─── 群内信息 ───`);
                    lines.push(`   群昵称: ${groupNick} | ${role}`);
                    lines.push(`   加群时间: ${joinTime}`);
                }
            } catch {
                // 忽略群成员信息查询失败
            }
        }

        if (sign) {
            lines.push(`   个签: ${sign}`);
        }

        return lines.join('\n');
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : '未知错误';
        return `❌ ${userId}: 查询失败 (${errMsg})`;
    }
}

// ==================== 模块执行 ====================

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
        return { success: false, text: '要查谁的资料呀？@一下那个人或者告诉我QQ号喵~' };
    }

    log.info(`🔧 模块: 查询用户资料 ${targetUsers.join(', ')}`);

    let groupInfo = '';
    if (ctx.groupId) {
        try {
            const response = await connector.rpc<{ data: NapCatGroupInfo }>('group.info', [ctx.groupId, false]);
            const group = response?.data;
            if (group) {
                const groupName = group.group_name || group.groupName || '未知群';
                groupInfo = `📌 群: ${groupName} (${ctx.groupId})\n`;
            }
        } catch {
            // 忽略群信息查询失败
        }
    }

    const results = await Promise.all(
        targetUsers.map(userId => queryUser(userId, ctx.groupId))
    );

    const text = groupInfo + results.join('\n\n');

    return {
        success: true,
        text,
        data: { userCount: targetUsers.length, users: targetUsers },
    };
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Module;

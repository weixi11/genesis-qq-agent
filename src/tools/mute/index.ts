/**
 * Mute 模块 - 群禁言功能
 *
 * 权限规则：
 * - master: 可禁言任何人（除 bot）
 * - global admin: 按群主级别处理
 * - owner: 可禁言 admin 和 member
 * - admin: 只能禁言 member
 * - member: 只能禁言自己（包括给自己解禁）
 */

import { log } from '../../logger.js';
import { connector } from '../../connector.js';
import { parseInteger, resolveOptionalGroupId } from '../../utils/format.js';
import { isGlobalAdmin } from '../../utils/identity.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import {
    buildRequesterNoPermissionText,
    buildTargetPrivilegeText,
    getGroupMemberInfo,
    getMemberDisplay,
    getMemberName,
    type GroupMemberInfo,
} from '../group_admin_common.js';

// ==================== 模块元数据 ====================

export const name = 'mute';
export const description = '禁言群成员';
export const keywords = ['禁言', '禁止发言', '闭嘴', '封口', '解除禁言', '解禁'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 类型定义 ====================

type Role = 'owner' | 'admin' | 'member';

// ==================== 权限等级 ====================

const ROLE_LEVEL: Record<Role | 'master', number> = {
    master: 100,
    owner: 80,
    admin: 50,
    member: 10,
};

// ==================== 内部函数 ====================

/**
 * 获取用户权限等级
 */
function getUserLevel(userId: number, role?: Role): number {
    if (userId === config.masterQQ) {
        return ROLE_LEVEL.master;
    }
    if (isGlobalAdmin(userId)) {
        return ROLE_LEVEL.owner;
    }
    return ROLE_LEVEL[role || 'member'];
}

/**
 * 检查 bot 是否有管理权限
 */
async function checkBotPermission(groupId: number): Promise<boolean> {
    if (!config.botQQ) {
        log.warn('未配置 BOT_QQ，无法检查 bot 权限');
        return true;
    }

    const botInfo = await getGroupMemberInfo(groupId, config.botQQ);
    if (!botInfo) {
        return false;
    }

    return botInfo.role === 'owner' || botInfo.role === 'admin';
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    ctx: ToolContext
): Promise<ToolResult> {
    // 1. 获取群号（优先从参数获取，支持 Web 测试）
    const rawGroupId = params.groupId ?? params.group_id;
    const groupId = resolveOptionalGroupId(rawGroupId, ctx.groupId);

    if (!groupId || Number.isNaN(groupId)) {
        return { success: false, text: '禁言功能只能在群里使用喵~ 请指定群号' };
    }

    // 2. 解析参数 - 支持多种参数名
    let targetId: number | undefined;

    const rawTargetId = params.targetId ?? params.user_id ?? params.userId ?? params.target;
    if (rawTargetId !== undefined) {
        targetId = parseInteger(rawTargetId);
    }

    if (!targetId && ctx.atUsers && ctx.atUsers.length > 0) {
        targetId = ctx.atUsers[0];
    }

    if (!targetId) {
        return { success: false, text: '要禁言谁呀？告诉我 QQ 号或者 @那个人喵~' };
    }

    if (targetId === config.botQQ) {
        return { success: false, text: '不能禁言我自己啦！💢' };
    }

    // 3. 解析禁言时长
    let duration = typeof params.duration === 'number'
        ? params.duration
        : config.defaultDuration;

    if (duration >= 60 && duration % 60 === 0) {
        const possibleMinutes = duration / 60;
        if (possibleMinutes >= 1 && possibleMinutes <= 1440) {
            log.debug(`智能转换时长: ${duration}秒 -> ${possibleMinutes}分钟`);
            duration = possibleMinutes;
        }
    }

    if (config.maxDuration > 0 && duration > config.maxDuration) {
        duration = config.maxDuration;
    }

    const durationSeconds = duration * 60;
    const isUnmute = durationSeconds === 0;
    const isSelfTarget = targetId === ctx.senderId;

    // 4. 检查操作者权限
    const operatorLevel = getUserLevel(ctx.senderId, ctx.senderRole);
    if (operatorLevel <= ROLE_LEVEL.member && !isSelfTarget) {
        const requesterInfo = await getGroupMemberInfo(groupId, ctx.senderId);
        return {
            success: false,
            text: buildRequesterNoPermissionText(getMemberName(ctx.senderId, requesterInfo), '去禁言别人'),
        };
    }

    // 5. 获取目标用户信息
    const targetInfo = await getGroupMemberInfo(groupId, targetId);
    if (!targetInfo) {
        return { success: false, text: `找不到用户 ${targetId}，可能不在群里喵~` };
    }

    // 6. 检查目标权限（不能禁言权限 >= 自己的人）
    const targetLevel = getUserLevel(targetId, targetInfo.role);
    if (!isSelfTarget && targetLevel >= operatorLevel) {
        const targetRoleName = targetId === config.masterQQ ? '主人'
            : isGlobalAdmin(targetId) ? '全局管理员'
                : targetInfo.role === 'owner' ? '群主'
                    : targetInfo.role === 'admin' ? '管理员'
                        : '群员';
        return {
            success: false,
            text: buildTargetPrivilegeText(getMemberDisplay(targetId, targetInfo), '禁言', targetRoleName),
        };
    }

    // 7. 检查 bot 权限
    const botHasPermission = await checkBotPermission(groupId);
    if (!botHasPermission) {
        return { success: false, text: '我不是管理员，没法禁言别人呢 QAQ' };
    }

    // 8. 执行禁言/解禁
    const targetName = getMemberName(targetId, targetInfo);
    const targetDisplay = getMemberDisplay(targetId, targetInfo);

    log.info(`🔧 模块: ${isUnmute ? '解除禁言' : '禁言'} ${targetId}(${targetName}) ${isUnmute ? '' : `${duration}分钟`} (群${groupId})`);

    try {
        await connector.callData('set_group_ban', {
            group_id: groupId,
            user_id: targetId,
            duration: durationSeconds,
        });

        if (isUnmute) {
            return {
                success: true,
                text: `已解除 ${targetDisplay} 的禁言 ✨`,
                data: { targetId, targetName, action: 'unmute' },
            };
        }

        return {
            success: true,
            text: `已禁言 ${targetDisplay} ${duration}分钟 🔇`,
            data: { targetId, targetName, duration, action: 'mute' },
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('禁言操作失败:', err);

        if (message.includes('permission') || message.includes('权限')) {
            return { success: false, text: '禁言失败，可能我的权限不够呢 QAQ' };
        }

        return { success: false, text: `禁言操作失败了喵: ${message}` };
    }
}

// ==================== 任务配置 ====================

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

// ==================== 默认导出 ====================

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;

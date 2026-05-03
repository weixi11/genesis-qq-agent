
import { log } from '../../logger.js';
import { connector } from '../../connector.js';
import { config } from './config.js';
import { config as globalConfig } from '../../config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { isMaster, isGlobalAdmin, getUserLevel, ROLE_LEVEL } from '../../utils/identity.js';
import {
    buildRequesterNoPermissionText,
    buildTargetPrivilegeText,
    getGroupMemberInfo,
    getMemberDisplay,
    getMemberName,
    getPrivilegeLabel,
} from '../group_admin_common.js';

export const name = 'group_kick';
export const description = '移出群成员';
export const keywords = ['踢人', '移出群', '踢出群', '踹飞'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// Helper to check bot permission
async function checkBotPermission(groupId: number): Promise<boolean> {
    if (!globalConfig.botQQ) return true;
    try {
        const botInfo = await connector.callData<{ role: string }>('get_group_member_info', {
            group_id: groupId,
            user_id: globalConfig.botQQ,
            no_cache: true,
        });
        return botInfo?.role === 'owner' || botInfo?.role === 'admin';
    } catch (e) {
        log.warn('Failed to check bot permission', e);
        return false;
    }
}

export async function execute(
    params: Record<string, unknown>,
    ctx: ToolContext
): Promise<ToolResult> {
    const groupId = ctx.groupId;
    if (!groupId) {
        return { success: false, text: '只能在群里踢人哦~' };
    }

    let targetId = params.user_id as number | undefined;
    if (!targetId) targetId = params.userId as number | undefined;
    if (!targetId && ctx.atUsers && ctx.atUsers.length > 0) {
        targetId = ctx.atUsers[0];
    }

    if (!targetId) {
        return { success: false, text: '请指定要移出的成员喵~' };
    }

    const rejectAddRequest = params.reject_add_request as boolean || false;

    // 1. Permission Check (Requester)
    const requesterLevel = getUserLevel(ctx.senderId, ctx.senderRole);
    if (requesterLevel < ROLE_LEVEL.admin) {
        const requesterInfo = await getGroupMemberInfo(groupId, ctx.senderId);
        return {
            success: false,
            text: buildRequesterNoPermissionText(getMemberName(ctx.senderId, requesterInfo), '踢别人出群'),
        };
    }

    const targetInfo = await getGroupMemberInfo(groupId, targetId);
    const targetDisplay = getMemberDisplay(targetId, targetInfo);

    // Protection
    if (isMaster(targetId) || isGlobalAdmin(targetId)) {
        return {
            success: false,
            text: buildTargetPrivilegeText(targetDisplay, '移出群', getPrivilegeLabel(targetId, targetInfo?.role)),
        };
    }

    // 2. Check Bot Permission
    const botHasPermission = await checkBotPermission(groupId);
    if (!botHasPermission) {
        return { success: false, text: '我不是管理员，没法移出成员呢 QAQ' };
    }

    // 3. Permission Check (Target)
    const targetLevel = getUserLevel(targetId, targetInfo?.role);

    if (targetLevel >= requesterLevel && !isMaster(ctx.senderId)) {
        return {
            success: false,
            text: buildTargetPrivilegeText(targetDisplay, '移出群', getPrivilegeLabel(targetId, targetInfo?.role)),
        };
    }

    try {
        await connector.callData('set_group_kick', {
            group_id: groupId,
            user_id: targetId,
            reject_add_request: rejectAddRequest,
        });

        return {
            success: true,
            text: `已将 ${targetDisplay} 移出群聊${rejectAddRequest ? '，并拒绝再次加入' : ''} 👋`,
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Group kick failed:', err);

        if (message.includes('permission') || message.includes('权限')) {
            return { success: false, text: '移出失败，可能是对方权限比我高，或者我不是管理员喵 QAQ' };
        }

        return { success: false, text: `操作失败了喵: ${message}` };
    }
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;

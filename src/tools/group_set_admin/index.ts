
import { log } from '../../logger.js';
import { connector } from '../../connector.js';
import { config } from './config.js';
import { config as globalConfig } from '../../config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { getUserLevel, ROLE_LEVEL } from '../../utils/identity.js';
import {
    buildRequesterNoPermissionText,
    getGroupMemberInfo,
    getMemberDisplay,
    getMemberName,
} from '../group_admin_common.js';

export const name = 'group_set_admin';
export const description = '设置/取消管理员';
export const keywords = ['升管理', '降管理', '设置管理员', '取消管理员', '设为管理'];

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
        return botInfo?.role === 'owner'; // Must be OWNER to set admins
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
        return { success: false, text: '管理管理员只能在群里操作哦~' };
    }

    let targetId = params.user_id as number | undefined;
    if (!targetId) targetId = params.userId as number | undefined;
    if (!targetId && ctx.atUsers && ctx.atUsers.length > 0) {
        targetId = ctx.atUsers[0];
    }

    if (!targetId) {
        return { success: false, text: '请指定要操作的用户喵~' };
    }

    let enable = params.enable as boolean;
    if (typeof enable === 'string') {
        enable = (enable === 'true');
    }

    if (enable === undefined) {
        return { success: false, text: '是要设置为管理员还是取消管理员呢？' };
    }

    // 1. Permission Check (Requester)
    // Master or Owner only. Admin cannot set other Admins.
    const requesterLevel = getUserLevel(ctx.senderId, ctx.senderRole);
    if (requesterLevel < ROLE_LEVEL.owner) {
        const requesterInfo = await getGroupMemberInfo(groupId, ctx.senderId);
        return {
            success: false,
            text: buildRequesterNoPermissionText(getMemberName(ctx.senderId, requesterInfo), '动群管理员'),
        };
    }

    // 2. Check Bot Permission
    // Bot must be Owner to set admins
    const botHasPermission = await checkBotPermission(groupId);
    if (!botHasPermission) {
        return { success: false, text: '我不是群主，没法任命管理员呢 QAQ' };
    }

    const targetInfo = await getGroupMemberInfo(groupId, targetId);
    const targetDisplay = getMemberDisplay(targetId, targetInfo);

    try {
        await connector.callData('set_group_admin', {
            group_id: groupId,
            user_id: targetId,
            enable: enable,
        });

        const actionStr = enable ? '晋升为管理员' : '取消管理员身份';
        return {
            success: true,
            text: `已将 ${targetDisplay} ${actionStr} ✨`,
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Set group admin failed:', err);
        return { success: false, text: `操作失败了喵: ${message}` };
    }
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;

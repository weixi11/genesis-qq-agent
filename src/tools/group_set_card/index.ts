
import { log } from '../../logger.js';
import { connector } from '../../connector.js';
import { config } from './config.js';
import { config as globalConfig } from '../../config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { getUserLevel, ROLE_LEVEL, isMaster } from '../../utils/identity.js';
import {
    buildRequesterNoPermissionText,
    buildTargetPrivilegeText,
    getGroupMemberInfo,
    getMemberDisplay,
    getMemberName,
    getPrivilegeLabel,
} from '../group_admin_common.js';

export const name = 'group_set_card';
export const description = '修改群昵称';
export const keywords = ['改名片', '改昵称', '设置名片'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// Helper to check bot permission
async function checkBotPermission(groupId: number): Promise<boolean> {
    if (!globalConfig.botQQ) return true; // Assume true if botQQ not configured
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
        return { success: false, text: '改群昵称当然要在群里用啦~' };
    }

    const newCard = params.card as string;
    if (!newCard) {
        return { success: false, text: '请告诉我新的昵称是什么呢？' };
    }

    // Default to bot if not specified
    let targetId = params.user_id as number | undefined;

    // Support generic param names from LLM
    if (!targetId) {
        targetId = params.userId as number | undefined;
    }

    let isBot = false;
    if (!targetId) {
        targetId = globalConfig.botQQ;
        isBot = true;
    } else if (targetId === globalConfig.botQQ) {
        isBot = true;
    }

    if (!targetId) {
        return { success: false, text: '未配置 Bot QQ，且未指定目标用户，无法执行操作' };
    }
    const ensuredTargetId = targetId;
    const targetInfo = isBot ? null : await getGroupMemberInfo(groupId, ensuredTargetId);

    // 1. Check Bot Permission
    // Special Case: Bot changing its own card usually doesn't require Admin, unless group settings forbid it.
    // We try anyway.
    if (!isBot) {
        const botHasPermission = await checkBotPermission(groupId);
        if (!botHasPermission) {
            return { success: false, text: '我不是管理员，没法修改别人的群名片呢 QAQ' };
        }
    }

    // 2. Permission Check (Requester vs Target)
    const requesterLevel = getUserLevel(ctx.senderId, ctx.senderRole);

    if (isBot) {
        // Modifying bot's card
        // Requester should be at least Admin (or Owner/Master) to change BOT's card?
        // User rule: "面对自身的资料修改，机器人本身是有权限的" (Bot has permission to change self)
        // But WHO is asking the bot to change? The user.
        // Should regular members be able to ask bot to change its name? Probably not.
        // But the error was "Bot not admin, cannot change card".
        // So the BLOCKER was the bot permission check.
        // Use case: Admin asks bot to change bot's name. Bot failed because Bot wasn't Admin.
        // Step 1 check (Bot Permission) is now skipped if isBot.

        // NOW check Requester Permission:
        // Regular member shouldn't change Bot's name.
        if (requesterLevel < ROLE_LEVEL.admin) {
            const requesterInfo = await getGroupMemberInfo(groupId, ctx.senderId);
            return {
                success: false,
                text: buildRequesterNoPermissionText(getMemberName(ctx.senderId, requesterInfo), '改我的群名片'),
            };
        }
    } else {
        // Modifying other's card
        // Requester must be admin/owner/master AND have higher level than target
        if (requesterLevel < ROLE_LEVEL.admin) {
            const requesterInfo = await getGroupMemberInfo(groupId, ctx.senderId);
            return {
                success: false,
                text: buildRequesterNoPermissionText(getMemberName(ctx.senderId, requesterInfo), '改别人的群名片'),
            };
        }

        // Check target level
        const targetLevel = getUserLevel(ensuredTargetId, targetInfo?.role);

        if (targetLevel >= requesterLevel && !isMaster(ctx.senderId)) {
            return {
                success: false,
                text: buildTargetPrivilegeText(
                    getMemberDisplay(ensuredTargetId, targetInfo),
                    '改群名片',
                    getPrivilegeLabel(ensuredTargetId, targetInfo?.role),
                ),
            };
        }
    }

    try {
        await connector.callData('set_group_card', {
            group_id: groupId,
            user_id: targetId,
            card: newCard,
        });

        const targetName = isBot ? '我' : getMemberDisplay(targetId, targetInfo);
        return {
            success: true,
            text: `已将 ${targetName} 的群昵称修改为：${newCard} ✨`,
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Modify group card failed:', err);
        return { success: false, text: `修改昵称失败了喵: ${message}` };
    }
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;


import { log } from '../../logger.js';
import { connector } from '../../connector.js';
import { config } from './config.js';
import { schema } from './schema.js';
import { config as globalConfig } from '../../config.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { getUserLevel, ROLE_LEVEL } from '../../utils/identity.js';
import { buildRequesterNoPermissionText, getGroupMemberInfo, getMemberName } from '../group_admin_common.js';

export const name = 'group_set_name';
export const description = '修改当前群名称';
export const keywords = ['修改群名', '改群名', '设置群名'];

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
        return { success: false, text: '只能在群里改名哦~' };
    }

    const newName = params.name as string;
    if (!newName) {
        return { success: false, text: '请告诉我新的群名称是什么呢？' };
    }

    // 1. Permission Check (Requester)
    // Only Admin or Owner or Master can change group name
    const operatorLevel = getUserLevel(ctx.senderId, ctx.senderRole);
    if (operatorLevel < ROLE_LEVEL.admin) { // Admin (50) or higher
        const requesterInfo = await getGroupMemberInfo(groupId, ctx.senderId);
        return {
            success: false,
            text: buildRequesterNoPermissionText(getMemberName(ctx.senderId, requesterInfo), '改群名'),
        };
    }

    // 2. Check Bot Permission
    // Bot must be Admin or Owner to change group name
    const botHasPermission = await checkBotPermission(groupId);
    if (!botHasPermission) {
        return { success: false, text: '我不是管理员，没法修改群名称呢 QAQ' };
    }

    // 3. Perform Action
    try {
        await connector.callData('set_group_name', {
            group_id: groupId,
            group_name: newName,
        });
        return {
            success: true,
            text: `群名称已修改为：${newName} ✨`,
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Modify group name failed:', err);
        return { success: false, text: `修改群名失败了喵: ${message}` };
    }
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;

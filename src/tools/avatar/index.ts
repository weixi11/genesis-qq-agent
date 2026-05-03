/**
 * Avatar 模块 - 获取 QQ 用户头像或群头像
 *
 * 双模式：
 * - describe: 返回头像 URL，供 Router 链式调用 vision 识图描述
 * - send（默认）: 直接以图片消息段返回头像
 */

import { log } from '../../logger.js';
import { connector } from '../../connector.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { parseInteger, resolveOptionalGroupId } from '../../utils/format.js';

// ==================== 模块元数据 ====================

export const name = 'avatar';
export const description = '获取QQ用户头像或群头像的图链';
export const keywords = ['头像', '头像是什么', '看.*头像', '发.*头像', '头像发', '获取头像'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 常量 ====================

/** 用户头像 URL 模板 */
const USER_AVATAR_URL_TEMPLATE = 'https://q1.qlogo.cn/g?b=qq&nk={id}&s=640';

/** 群头像 URL 模板 */
const GROUP_AVATAR_URL_TEMPLATE = 'https://p.qlogo.cn/gh/{id}/{id}/640';

// ==================== 类型定义 ====================

/** 操作类型 */
type AvatarAction = 'describe' | 'send';

/** 头像类型 */
type AvatarType = 'user' | 'group';

// ==================== 内部函数 ====================

/**
 * 构造用户头像 URL
 */
function buildUserAvatarUrl(userId: number): string {
    return USER_AVATAR_URL_TEMPLATE.replace('{id}', String(userId));
}

/**
 * 构造群头像 URL
 */
function buildGroupAvatarUrl(groupId: number): string {
    return GROUP_AVATAR_URL_TEMPLATE.replaceAll('{id}', String(groupId));
}

/**
 * 解析目标用户 ID
 * 优先级：targetId 参数 > @用户 > 发送者自身
 */
function resolveTargetUserId(
    params: Record<string, unknown>,
    ctx: ToolContext
): number | null {
    // 1. 从参数中解析
    const rawTargetId = params.targetId ?? params.target_id ?? params.userId ?? params.user_id;
    if (rawTargetId !== undefined) {
        const id = parseInteger(rawTargetId);
        if (id !== undefined && id > 0) return id;
    }

    // 2. 从 @ 用户中获取（排除 bot 自身）
    const atUsers = ctx.atUsers || [];
    const validAtUsers = atUsers.filter(id => id !== config.botQQ);
    if (validAtUsers.length > 0) return validAtUsers[0];

    // 3. 使用发送者自身
    if (ctx.senderId && ctx.senderId > 0) return ctx.senderId;

    return null;
}

/**
 * 解析群 ID
 */
function resolveGroupId(
    params: Record<string, unknown>,
    ctx: ToolContext
): number | null {
    const rawGroupId = params.groupId ?? params.group_id;
    return resolveOptionalGroupId(rawGroupId, ctx.groupId) ?? null;
}

/**
 * 直接通过 OneBot API 发送图片
 * 使用 callData 绕过 SDK RPC，确保外部 URL 图片可靠发送
 */
async function sendImageDirectly(
    ctx: ToolContext,
    imageUrl: string
): Promise<boolean> {
    try {
        const message = [{ type: 'image', data: { file: imageUrl } }];

        if (ctx.groupId) {
            await connector.callData('send_group_msg', {
                group_id: ctx.groupId,
                message,
            });
        } else if (ctx.senderId) {
            await connector.callData('send_private_msg', {
                user_id: ctx.senderId,
                message,
            });
        } else {
            return false;
        }

        log.info(`🖼️ 头像图片已直接发送: ${imageUrl}`);
        return true;
    } catch (err) {
        log.warn(`🖼️ 直接发送图片失败，将通过 segments 回退:`, err);
        return false;
    }
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    ctx: ToolContext
): Promise<ToolResult> {
    // 1. 解析参数
    const avatarType: AvatarType = params.type === 'group' ? 'group' : 'user';
    const action: AvatarAction = params.action === 'describe' ? 'describe' : 'send';

    // 2. 构造头像 URL
    let avatarUrl: string;
    let targetLabel: string;

    if (avatarType === 'group') {
        const groupId = resolveGroupId(params, ctx);
        if (!groupId) {
            return { success: false, text: '需要指定群号才能获取群头像喵~' };
        }
        avatarUrl = buildGroupAvatarUrl(groupId);
        targetLabel = `群 ${groupId}`;
        log.info(`🖼️ 获取群头像: ${groupId} (action=${action})`);
    } else {
        const userId = resolveTargetUserId(params, ctx);
        if (!userId) {
            return { success: false, text: '要获取谁的头像呀？@一下那个人或告诉我QQ号喵~' };
        }
        avatarUrl = buildUserAvatarUrl(userId);
        targetLabel = `用户 ${userId}`;
        log.info(`🖼️ 获取用户头像: ${userId} (action=${action})`);
    }

    // 3. 根据 action 决定返回方式
    if (action === 'send') {
        // 主动发送图片（使用 OneBot API 确保可靠投递）
        const sent = await sendImageDirectly(ctx, avatarUrl);

        return {
            success: true,
            text: `${targetLabel} 的头像`,
            // 如果直接发送失败，保留 segments 作为回退
            segments: sent ? undefined : [{ type: 'image', data: { file: avatarUrl } }],
            data: { avatarUrl, type: avatarType, action, imageSent: sent },
        };
    }

    // describe 模式：返回 URL 供 vision 工具识图
    return {
        success: true,
        text: `${targetLabel} 的头像链接: ${avatarUrl}`,
        data: { avatarUrl, type: avatarType, action },
    };
}

// ==================== 任务配置 ====================

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

// ==================== 默认导出 ====================

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;

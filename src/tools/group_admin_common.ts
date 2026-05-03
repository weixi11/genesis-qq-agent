import { connector } from '../connector.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { isGlobalAdmin } from '../utils/identity.js';

export type GroupRole = 'owner' | 'admin' | 'member';

export interface GroupMemberInfo {
    user_id: number;
    role?: GroupRole;
    card?: string;
    nickname?: string;
}

export async function getGroupMemberInfo(groupId: number, userId: number): Promise<GroupMemberInfo | null> {
    try {
        const result = await connector.callData<GroupMemberInfo>('get_group_member_info', {
            group_id: groupId,
            user_id: userId,
            no_cache: true,
        });
        return result ?? null;
    } catch (err) {
        log.warn(`获取群成员信息失败: ${userId}`, err);
        return null;
    }
}

export function getMemberName(userId: number, info?: Pick<GroupMemberInfo, 'card' | 'nickname'> | null): string {
    const card = info?.card?.trim();
    if (card) {
        return card;
    }

    const nickname = info?.nickname?.trim();
    if (nickname) {
        return nickname;
    }

    return `用户${userId}`;
}

export function getMemberDisplay(userId: number, info?: Pick<GroupMemberInfo, 'card' | 'nickname'> | null): string {
    return `${getMemberName(userId, info)}(${userId})`;
}

export function getPrivilegeLabel(userId: number, role?: string): string {
    if (userId === config.masterQQ) {
        return '主人';
    }
    if (isGlobalAdmin(userId)) {
        return '全局管理员';
    }
    if (role === 'owner') {
        return '群主';
    }
    if (role === 'admin') {
        return '管理员';
    }
    return '群员';
}

export function buildRequesterNoPermissionText(requesterName: string, action: string): string {
    return `${requesterName}，你又不是管理员/群主/主人，凭什么命令我${action}`;
}

export function buildTargetPrivilegeText(targetDisplay: string, action: string, targetRoleLabel: string): string {
    return `${targetDisplay} 可不是你能${action}的，人家可是${targetRoleLabel}`;
}

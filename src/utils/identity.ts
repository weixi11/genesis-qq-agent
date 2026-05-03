
import { config } from '../config.js';

export type UserRole = 'owner' | 'admin' | 'member';

/**
 * Check if the user is the Master (Bot Owner).
 * Master has the highest permission level.
 */
export function isMaster(userId: number): boolean {
    return userId === config.masterQQ;
}

/**
 * Check if the user is a Global Admin (configured in .env).
 */
export function isGlobalAdmin(userId: number): boolean {
    return config.adminQQ.includes(userId);
}

/**
 * Check if the user is the Owner of the group (based on role string).
 */
export function isOwner(role?: string): boolean {
    return role === 'owner';
}

/**
 * Check if the user is an Admin or Owner of the group (based on role string).
 */
export function isAdmin(role?: string): boolean {
    return role === 'admin' || role === 'owner';
}

export const ROLE_LEVEL: Record<string, number> = {
    'master': 100,
    'owner': 80,
    'admin': 50,
    'member': 10,
};

/**
 * Get the numeric permission level for a user role.
 * Masters get level 100.
 */
export function getUserLevel(userId: number, role?: string): number {
    if (isMaster(userId)) return ROLE_LEVEL.master;
    if (isGlobalAdmin(userId)) return ROLE_LEVEL.owner; // Treat global admin as owner level for now? Or just check isGlobalAdmin separately.
    return ROLE_LEVEL[role || 'member'] || 10;
}

/**
 * Check if requester has permission to operate on target.
 * Hierarchy: Master > Owner > Admin > Member.
 * Returns true if requester's level is strict greater than target's level.
 * 
 * Exception: Master can operate on anyone (except maybe other Masters, but logic handles it as equal).
 */
export function checkPermission(
    requester: { userId: number; role?: string },
    target: { userId: number; role?: string }
): boolean {
    // 1. Master is god
    if (isMaster(requester.userId)) return true;

    // 2. Compare levels
    const reqLevel = getUserLevel(requester.userId, requester.role);
    const targetLevel = getUserLevel(target.userId, target.role);

    return reqLevel > targetLevel;
}

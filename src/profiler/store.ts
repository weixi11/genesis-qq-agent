/**
 * 用户画像存储管理
 * 代理到 SQLite 后端，保持 API 兼容
 */

import { log } from '../logger.js';
import type { UserProfile, ProfileMemoryInput } from '../types.js';
import {
    flushProfilesDbToFile,
    getProfileFromSqlite,
    getOrCreateProfileFromSqlite,
    saveProfileToSqlite,
    updateProfileInSqlite,
    recordActivityInSqlite,
    adjustFavorabilityInSqlite,
    addTraitsInSqlite,
    addInterestsInSqlite,
    addProfileEvidenceInSqlite,
    addProfileMemoriesInSqlite,
    getProfileSummaryFromSqlite,
    listAllProfilesFromSqlite,
    deleteProfileFromSqlite,
    deleteAllProfilesFromSqlite,
    initProfilesDb,
} from '../storage/profiles-sqlite.js';

// 重导出初始化函数
export { initProfilesDb };

// 内存缓存（减少数据库查询）
const profileCache = new Map<number, { profile: UserProfile; timestamp: number }>();
const CACHE_TTL = 60000;  // 缓存 60 秒

function isWebOnlyProcess(): boolean {
    return (process.env.GENESIS_PROCESS_ROLE || '').trim().toLowerCase() === 'web';
}

/**
 * 更新缓存
 */
function updateCache(profile: UserProfile): void {
    profileCache.set(profile.userId, {
        profile,
        timestamp: Date.now(),
    });
}

/**
 * 获取用户画像（同步版本）
 */
export function getProfile(userId: number): UserProfile | undefined {
    if (isWebOnlyProcess()) {
        return getProfileFromSqlite(userId);
    }

    // 先检查缓存
    const cached = profileCache.get(userId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.profile;
    }

    // 从 SQLite 读取
    const profile = getProfileFromSqlite(userId);
    if (profile) {
        updateCache(profile);
    }
    return profile;
}

/**
 * 获取用户画像（异步版本 - 兼容旧接口）
 */
export function getProfileAsync(userId: number): UserProfile | undefined {
    return getProfile(userId);
}

/**
 * 获取或创建用户画像
 */
export function getOrCreateProfile(userId: number, nickname: string): UserProfile {
    if (isWebOnlyProcess()) {
        return getOrCreateProfileFromSqlite(userId, nickname);
    }

    // 先检查缓存
    const cached = profileCache.get(userId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        // 更新昵称（可能会变）
        if (cached.profile.nickname !== nickname) {
            cached.profile.nickname = nickname;
            saveProfileToSqlite(cached.profile);
        }
        return cached.profile;
    }

    // 从 SQLite 获取或创建
    const profile = getOrCreateProfileFromSqlite(userId, nickname);
    updateCache(profile);
    return profile;
}

/**
 * 更新用户画像
 */
export function updateProfile(userId: number, updates: Partial<UserProfile>): UserProfile | undefined {
    if (isWebOnlyProcess()) {
        return updateProfileInSqlite(userId, updates);
    }

    const profile = updateProfileInSqlite(userId, updates);
    if (profile) {
        updateCache(profile);
    }
    return profile;
}

/**
 * 记录用户活动
 */
export function recordActivity(userId: number, nickname: string): void {
    recordActivityInSqlite(userId, nickname);
    if (isWebOnlyProcess()) {
        return;
    }
    // 清除缓存以获取最新数据
    profileCache.delete(userId);
}

/**
 * 调整好感度
 */
export function adjustFavorability(
    userId: number,
    emotionScore: number,
    keywordBonus: number,
    frequencyBonus: number
): void {
    adjustFavorabilityInSqlite(userId, emotionScore, keywordBonus, frequencyBonus);
    if (isWebOnlyProcess()) {
        return;
    }
    // 清除缓存
    profileCache.delete(userId);
}

/**
 * 添加性格标签
 */
export function addTraits(userId: number, traits: string[]): void {
    addTraitsInSqlite(userId, traits);
    if (isWebOnlyProcess()) {
        return;
    }
    profileCache.delete(userId);
}

/**
 * 添加兴趣爱好
 */
export function addInterests(userId: number, interests: string[]): void {
    addInterestsInSqlite(userId, interests);
    if (isWebOnlyProcess()) {
        return;
    }
    profileCache.delete(userId);
}

export function addProfileEvidence(
    userId: number,
    section:
        | 'identityFacts'
        | 'likes'
        | 'dislikes'
        | 'redLines'
        | 'emotionPatterns'
        | 'emotionalTriggers'
        | 'calmingSignals'
        | 'relationshipNotes'
        | 'boundaryNotes',
    values: string[],
): void {
    addProfileEvidenceInSqlite(userId, section, values);
    if (isWebOnlyProcess()) {
        return;
    }
    profileCache.delete(userId);
}

export function addProfileMemories(
    userId: number,
    section: 'importantMemories' | 'conflictRecords',
    entries: ProfileMemoryInput[],
): void {
    addProfileMemoriesInSqlite(userId, section, entries);
    if (isWebOnlyProcess()) {
        return;
    }
    profileCache.delete(userId);
}

/**
 * 获取用户画像摘要
 */
export function getProfileSummary(userId: number): string | undefined {
    return getProfileSummaryFromSqlite(userId);
}

/**
 * 获取所有用户画像
 */
export function getAllProfiles(): UserProfile[] {
    if (isWebOnlyProcess()) {
        return listAllProfilesFromSqlite(1000);
    }
    return listAllProfilesFromSqlite(1000);  // 最多返回 1000 条
}

/**
 * 删除用户画像
 */
export function deleteProfile(userId: number): boolean {
    if (isWebOnlyProcess()) {
        return deleteProfileFromSqlite(userId);
    }

    profileCache.delete(userId);
    return deleteProfileFromSqlite(userId);
}

export function deleteAllProfiles(): number {
    if (isWebOnlyProcess()) {
        return deleteAllProfilesFromSqlite();
    }

    profileCache.clear();
    return deleteAllProfilesFromSqlite();
}

/**
 * 保存所有缓存到数据库
 * SQLite 模式下是即时保存的，这个函数仅用于兼容
 */
export function saveProfilesAsync(): void {
    const profiles = Array.from(profileCache.values());
    for (const { profile } of profiles) {
        saveProfileToSqlite(profile);
    }
    flushProfilesDbToFile();
    log.debug(`📊 已保存 ${profiles.length} 个用户画像到 SQLite`);
}

/**
 * 同步保存（兼容旧接口）
 */
export function saveProfiles(): void {
    saveProfilesAsync();
}

/**
 * 加载用户画像（兼容旧接口，现在是空操作）
 */
export function loadProfiles(): void {
    // SQLite 模式下不需要预加载
}

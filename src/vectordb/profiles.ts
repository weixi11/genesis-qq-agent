/**
 * 用户画像 LanceDB 存储
 * 替代 JSON 文件，支持大规模用户
 */

import type { Table } from '@lancedb/lancedb';
import { log } from '../logger.js';
import { getDb } from './client.js';
import type { UserProfile, ProfileTagEvidence } from '../types.js';
import { createDefaultProfile } from '../types.js';
import { FAVORABILITY_CONFIG, getFavorabilityRelationLevel } from '../utils/favorability.js';
import { safeParseJson } from '../utils/json.js';

import type { ProfileItem } from './types.js';

// 表名
const PROFILES_TABLE = 'user_profiles';

// 表缓存
let profilesTable: Table | null = null;

function parseJsonStringArray(raw: string | undefined): string[] {
    if (!raw) {
        return [];
    }

    const parsed = safeParseJson(raw);
    if (!Array.isArray(parsed)) {
        return [];
    }

    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function buildLegacyEvidence(values: string[], lastSeen: number): ProfileTagEvidence[] {
    return values.map((value) => ({
        value,
        score: 1,
        lastSeen,
        count: 1,
        source: 'legacy',
    }));
}

/**
 * 获取或创建画像表
 */
async function getProfilesTable(): Promise<Table> {
    if (profilesTable) return profilesTable;

    const database = await getDb();
    const tableNames = await database.tableNames();

    if (tableNames.includes(PROFILES_TABLE)) {
        profilesTable = await database.openTable(PROFILES_TABLE);
        return profilesTable;
    }

    // 创建新表（需要至少一条数据，schema 必须包含所有字段）
    const initialRecord: ProfileItem = {
        userId: 0,
        nickname: 'system',
        gender: undefined,
        ageRange: undefined,
        traits: '[]',
        interests: '[]',
        favorability: FAVORABILITY_CONFIG.BASELINE,
        mood: 'neutral',
        messageCount: 0,
        lastSeen: Date.now(),
        lastAnalyzed: 0,
        notes: '',  // 必须包含 notes 字段
        vector: new Array(768).fill(0) as unknown as number[],  // 正确的向量维度
    };

    profilesTable = await database.createTable(PROFILES_TABLE, [initialRecord as unknown as Record<string, unknown>]);
    log.info(`📊 创建用户画像表: ${PROFILES_TABLE}`);

    return profilesTable;
}

/**
 * 将 UserProfile 转换为 LanceDB 记录
 */
function toRecord(profile: UserProfile): ProfileItem {
    return {
        userId: profile.userId,
        nickname: profile.nickname,
        gender: profile.gender,
        ageRange: profile.ageRange,
        traits: JSON.stringify(profile.traits),
        interests: JSON.stringify(profile.interests),
        favorability: profile.favorability,
        mood: profile.mood,
        messageCount: profile.messageCount,
        lastSeen: profile.lastSeen,
        lastAnalyzed: profile.lastAnalyzed,
        notes: profile.notes,
        vector: [0],
    };
}

/**
 * 将 LanceDB 记录转换为 UserProfile
 */
/**
 * 将 LanceDB 记录转换为 UserProfile
 */
function fromRecord(record: ProfileItem): UserProfile {
    const lastSeen = record.lastSeen || Date.now();
    const traits = parseJsonStringArray(record.traits);
    const interests = parseJsonStringArray(record.interests);
    const profile = createDefaultProfile(record.userId, record.nickname);

    profile.gender = record.gender as 'male' | 'female' | 'unknown' | undefined;
    profile.ageRange = record.ageRange;
    profile.traits = traits;
    profile.traitEvidence = buildLegacyEvidence(traits, lastSeen);
    profile.interests = interests;
    profile.interestEvidence = buildLegacyEvidence(interests, lastSeen);
    profile.favorability = record.favorability;
    profile.favorabilityUpdatedAt = record.lastAnalyzed || lastSeen;
    profile.mood = (record.mood || 'neutral') as 'neutral' | 'positive' | 'negative';
    profile.messageCount = record.messageCount || 0;
    profile.lastSeen = lastSeen;
    profile.lastAnalyzed = record.lastAnalyzed || 0;
    profile.notes = record.notes;

    return profile;
}

/**
 * 获取用户画像
 */
export async function getProfileFromDb(userId: number): Promise<UserProfile | undefined> {
    try {
        log.debug(`📋 查询画像: ${userId}...`);
        const table = await getProfilesTable();
        log.debug(`📋 表获取成功，执行查询...`);

        // LanceDB WHERE 子句在某些情况下不稳定，改用内存过滤
        const allResults = await table.query().limit(500).toArray();
        const results = (allResults as unknown as ProfileItem[]).filter((r) => r.userId === userId);
        log.debug(`📋 查询完成: ${results.length} 条 (全表 ${allResults.length} 条)`);

        if (results.length === 0 || results[0].userId === 0) {
            return undefined;
        }

        return fromRecord(results[0]);
    } catch (err: unknown) {
        log.error('获取用户画像失败:', err instanceof Error ? err.message : String(err));
        return undefined;
    }
}

/**
 * 获取或创建用户画像
 */
export async function getOrCreateProfileFromDb(userId: number, nickname: string): Promise<UserProfile> {
    const existing = await getProfileFromDb(userId);
    if (existing) {
        // 更新昵称（可能变了）
        if (nickname && nickname !== existing.nickname) {
            existing.nickname = nickname;
        }
        return existing;
    }

    // 创建新画像
    const profile = createDefaultProfile(userId, nickname);
    await saveProfileToDb(profile);
    log.info(`📊 创建新用户画像: ${nickname} (${userId})`);
    return profile;
}

/**
 * 保存用户画像（upsert 语义）
 */
export async function saveProfileToDb(profile: UserProfile): Promise<void> {
    try {
        const table = await getProfilesTable();
        const record = toRecord(profile);

        // LanceDB 的 WHERE 删除不稳定，改用读取-过滤-重写方式
        // 读取所有非目标用户的记录
        const allRecords = await table.query().limit(1000).toArray();
        const otherRecords = (allRecords as unknown as ProfileItem[])
            .filter((r) => r.userId !== profile.userId)
            // 只保留 schema 定义的字段，过滤掉 LanceDB 内部字段（如 _distance, vector.isValid）
            .map((r) => ({
                userId: r.userId,
                nickname: r.nickname,
                gender: r.gender,
                ageRange: r.ageRange,
                traits: r.traits,
                interests: r.interests,
                favorability: r.favorability,
                mood: r.mood,
                messageCount: r.messageCount,
                lastSeen: r.lastSeen,
                lastAnalyzed: r.lastAnalyzed,
                notes: r.notes,
                // vector 可能是 LanceDB 特殊对象，需要转为纯数组
                vector: Array.isArray(r.vector) ? [...(r.vector as unknown as number[])] : Array.from((r.vector as unknown as number[]) || []),
            }));

        // 删除所有记录（包括旧的目标用户记录）
        try {
            await table.delete('1=1');  // 删除所有
        } catch {
            // Intentionally ignore delete-all failures
        }

        // 重新插入：其他用户 + 新记录
        const newRecords = [...otherRecords, record] as unknown as Record<string, unknown>[];
        if (newRecords.length > 0) {
            await table.add(newRecords);
        }
    } catch (err: unknown) {
        log.error('保存用户画像失败:', err instanceof Error ? err.message : String(err));
    }
}

/**
 * 更新用户画像
 */
export async function updateProfileInDb(userId: number, updates: Partial<UserProfile>): Promise<UserProfile | undefined> {
    const profile = await getProfileFromDb(userId);
    if (!profile) {
        log.warn(`更新失败: 用户 ${userId} 不存在`);
        return undefined;
    }

    // 合并更新
    Object.assign(profile, updates);

    // 确保好感度在范围内
    profile.favorability = Math.max(0, Math.min(100, profile.favorability));

    await saveProfileToDb(profile);
    return profile;
}

/**
 * 记录用户活跃
 */
export async function recordActivityInDb(userId: number, nickname: string): Promise<void> {
    const profile = await getOrCreateProfileFromDb(userId, nickname);
    profile.messageCount++;
    profile.lastSeen = Date.now();

    // 更新昵称
    if (nickname && nickname !== profile.nickname) {
        profile.nickname = nickname;
    }

    await saveProfileToDb(profile);
}

/**
 * 调整好感度
 */
export async function adjustFavorabilityInDb(
    userId: number,
    emotionScore: number,
    keywordBonus: number = 0,
    frequencyBonus: number = 0
): Promise<number> {
    const profile = await getProfileFromDb(userId);
    if (!profile) return 50;

    const emotionWeight = 5;
    const delta = (emotionScore * emotionWeight) + keywordBonus + frequencyBonus;

    const oldFav = profile.favorability;
    profile.favorability = Math.max(0, Math.min(100, oldFav + delta));

    log.debug(`💕 好感度变化: ${profile.nickname} ${oldFav.toFixed(1)} -> ${profile.favorability.toFixed(1)} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)})`);

    await saveProfileToDb(profile);
    return profile.favorability;
}

/**
 * 添加性格标签
 */
export async function addTraitsInDb(userId: number, newTraits: string[]): Promise<void> {
    const profile = await getProfileFromDb(userId);
    if (!profile) return;

    const existing = new Set(profile.traits);
    for (const trait of newTraits) {
        if (trait && !existing.has(trait)) {
            profile.traits.push(trait);
            existing.add(trait);
        }
    }

    // 最多保留 20 个
    if (profile.traits.length > 20) {
        profile.traits = profile.traits.slice(-20);
    }

    await saveProfileToDb(profile);
}

/**
 * 添加兴趣爱好
 */
export async function addInterestsInDb(userId: number, newInterests: string[]): Promise<void> {
    const profile = await getProfileFromDb(userId);
    if (!profile) return;

    const existing = new Set(profile.interests);
    for (const interest of newInterests) {
        if (interest && !existing.has(interest)) {
            profile.interests.push(interest);
            existing.add(interest);
        }
    }

    // 最多保留 20 个
    if (profile.interests.length > 20) {
        profile.interests = profile.interests.slice(-20);
    }

    await saveProfileToDb(profile);
}

/**
 * 获取用户画像摘要（用于 Persona）
 */
export async function getProfileSummaryFromDb(userId: number): Promise<string | undefined> {
    const profile = await getProfileFromDb(userId);
    if (!profile) return undefined;

    const parts: string[] = [];

    parts.push(`关系: ${getFavorabilityRelationLevel(profile.favorability)}`);

    if (profile.traits.length > 0) {
        parts.push(`性格: ${profile.traits.slice(-5).join(', ')}`);
    }

    if (profile.interests.length > 0) {
        parts.push(`兴趣: ${profile.interests.slice(-5).join(', ')}`);
    }

    return parts.join(' | ');
}

/**
 * 列出所有用户画像
 */
export async function listAllProfiles(limit: number = 20): Promise<UserProfile[]> {
    try {
        const table = await getProfilesTable();
        const results = await table
            .query()
            .limit(limit + 1)
            .toArray();

        return (results as unknown as ProfileItem[])
            .filter((r) => r.userId !== 0)  // 过滤初始化记录
            .slice(0, limit)
            .map((r) => fromRecord(r));
    } catch (err: unknown) {
        log.error('获取画像列表失败:', err instanceof Error ? err.message : String(err));
        return [];
    }
}

/**
 * 获取画像统计
 */
export async function getProfileStats(): Promise<{ total: number; avgFavorability: number }> {
    try {
        const table = await getProfilesTable();
        const results = await table.query().toArray();
        log.debug(`📋 画像统计查询: ${results.length} 条记录`);

        const profiles = (results as unknown as ProfileItem[]).filter((r) => r.userId !== 0);
        const total = profiles.length;
        const avgFavorability = total > 0
            ? profiles.reduce((sum, r) => sum + r.favorability, 0) / total
            : FAVORABILITY_CONFIG.BASELINE;

        return { total, avgFavorability };
    } catch (err: unknown) {
        log.error('画像统计查询失败:', err instanceof Error ? err.message : String(err));
        return { total: 0, avgFavorability: FAVORABILITY_CONFIG.BASELINE };
    }
}

/**
 * 删除用户画像
 */
export async function deleteProfileFromDb(userId: number): Promise<boolean> {
    try {
        const table = await getProfilesTable();

        // LanceDB WHERE 删除不稳定，改用读取-过滤-重写方式
        const allRecords = await table.query().limit(1000).toArray();
        const remainingRecords = (allRecords as unknown as ProfileItem[])
            .filter((r) => r.userId !== userId && r.userId !== 0)
            .map((r) => ({
                userId: r.userId,
                nickname: r.nickname,
                gender: r.gender,
                ageRange: r.ageRange,
                traits: r.traits,
                interests: r.interests,
                favorability: r.favorability,
                mood: r.mood,
                messageCount: r.messageCount,
                lastSeen: r.lastSeen,
                lastAnalyzed: r.lastAnalyzed,
                notes: r.notes,
                vector: Array.isArray(r.vector) ? [...(r.vector as unknown as number[])] : Array.from((r.vector as unknown as number[]) || []),
            }));

        // 检查是否有被删除的记录
        const deletedCount = (allRecords as unknown as ProfileItem[]).filter((r) => r.userId === userId).length;
        if (deletedCount === 0) {
            return false;  // 未找到要删除的记录
        }

        // 删除全部
        try {
            await table.delete('1=1');
        } catch {
            // Intentionally ignore delete-all failures
        }

        // 重新插入剩余记录（如果有的话）+ 初始化记录
        const initRecord = {
            userId: 0,
            nickname: 'system',
            traits: '[]',
            interests: '[]',
            favorability: FAVORABILITY_CONFIG.BASELINE,
            mood: 'neutral',
            messageCount: 0,
            lastSeen: Date.now(),
            lastAnalyzed: 0,
            vector: new Array(768).fill(0),
        };

        const newRecords = remainingRecords.length > 0
            ? remainingRecords
            : [initRecord];
        await table.add(newRecords as unknown as Record<string, unknown>[]);

        log.info(`📋 删除用户画像: ${userId}`);
        return true;
    } catch (err: unknown) {
        log.error('删除用户画像失败:', err instanceof Error ? err.message : String(err));
        return false;
    }
}


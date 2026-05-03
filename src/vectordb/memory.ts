/**
 * 用户记忆存储
 * 存储和检索用户的重要记忆
 */

import { log } from '../logger.js';
import { generateEmbedding } from './embedding.js';
import { getMemoryTable, type MemoryItem } from './client.js';

/**
 * 存储用户记忆
 */
export async function storeMemory(params: {
    userId: number;
    text: string;
    type?: 'chat' | 'fact' | 'preference';
    importance?: number;
}): Promise<void> {
    const { userId, text, type = 'chat', importance = 3 } = params;

    // 生成向量
    const vector = await generateEmbedding(text);

    // 创建记录
    const record: MemoryItem = {
        id: `${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        userId,
        text,
        vector,
        type,
        importance,
        timestamp: Date.now(),
    };

    // 插入数据库
    const table = await getMemoryTable();
    await table.add([record as unknown as Record<string, unknown>]);

    log.debug(`📝 存储记忆: [${type}] ${text.slice(0, 50)}...`);
}

/**
 * 搜索相关记忆
 */
export async function searchMemories(params: {
    userId: number;
    query: string;
    limit?: number;
    minImportance?: number;
}): Promise<Array<{ text: string; type: string; importance: number; score: number }>> {
    const { userId, query, limit = 5, minImportance = 1 } = params;

    try {
        // 生成查询向量
        const queryVector = await generateEmbedding(query);

        // 搜索（使用 cosine 距离度量，对归一化向量效果更好）
        const table = await getMemoryTable();
        const results = await table
            .search(queryVector)
            // .metricType('cosine')  // 暂不支持显式设置
            .where(`userId = ${userId} AND importance >= ${minImportance}`)
            .limit(limit)
            .toArray() as (MemoryItem & { _distance?: number })[];

        // 过滤掉初始化记录
        const filtered = results.filter((r) => r.id !== 'init');

        log.debug(`🔍 搜索记忆 "${query.slice(0, 20)}...": ${filtered.length} 条结果`);

        // L2 distance -> similarity: use 1/(1+distance) for [0,1] range
        return filtered.map((r) => ({
            text: r.text,
            type: r.type,
            importance: r.importance,
            score: r._distance != null ? 1 / (1 + r._distance) : 1,
        }));
    } catch (err: unknown) {
        log.error('搜索记忆失败:', err instanceof Error ? err.message : String(err));
        return [];
    }
}

/**
 * 获取用户最近的记忆
 */
export async function getRecentMemories(userId: number, limit: number = 10): Promise<MemoryItem[]> {
    try {
        const table = await getMemoryTable();

        // 查询该用户的记忆
        const results = await table
            .query()
            .where(`userId = ${userId}`)
            .limit(limit)
            .toArray();

        // 过滤掉初始化记录，按时间排序
        const records = results as unknown as MemoryItem[];
        return records
            .filter((r) => r.id !== 'init')
            .sort((a, b) => b.timestamp - a.timestamp);
    } catch (err: unknown) {
        log.error('获取记忆失败:', err instanceof Error ? err.message : String(err));
        return [];
    }
}

/**
 * 删除用户记忆
 */
export async function deleteMemory(memoryId: string): Promise<boolean> {
    try {
        const table = await getMemoryTable();
        await table.delete(`id = "${memoryId}"`);
        log.debug(`🗑️ 删除记忆: ${memoryId}`);
        return true;
    } catch (err: unknown) {
        log.error('删除记忆失败:', err instanceof Error ? err.message : String(err));
        return false;
    }
}

/**
 * 清空用户的所有记忆
 */
export async function clearUserMemories(userId: number): Promise<number> {
    try {
        const table = await getMemoryTable();

        // 先查询数量
        const memories = await table.query().where(`userId = ${userId}`).toArray();
        const count = memories.length;

        // 删除
        await table.delete(`userId = ${userId}`);
        log.info(`🗑️ 清空用户 ${userId} 的 ${count} 条记忆`);

        return count;
    } catch (err: unknown) {
        log.error('清空记忆失败:', err instanceof Error ? err.message : String(err));
        return 0;
    }
}

/**
 * 分析消息是否值得存储为记忆
 * 返回重要性评分 (0-5)，0 表示不存储
 * 
 * 改进：
 * - 增加最小长度要求
 * - 需要更完整的语义匹配
 * - 排除反问句和对他人的描述
 */
export function analyzeImportance(text: string): number {
    // 太短的消息直接跳过
    if (text.length < 8) return 0;

    // 排除问句（正在问别人，而非陈述自己）
    if (/[?？]$/.test(text.trim())) return 0;
    if (/^(你|他|她|它|谁|什么|哪|怎么|为什么|是不是)/.test(text)) return 0;

    // === 高价值信息 (5分) ===
    // 自我介绍：需要完整的"我是/叫 + 内容"
    if (/我(是|叫|名字是?).{1,10}/.test(text)) return 5;
    // 英文自我介绍
    if (/my name is|i('m| am) /i.test(text)) return 5;

    // === 偏好信息 (4分) ===
    // 需要"我"+ 偏好动词 + 实际内容（至少2个字）
    if (/我(喜欢|特别喜欢|最喜欢|热爱|爱).{2,}/.test(text)) return 4;
    if (/我(讨厌|不喜欢|不爱|受不了).{2,}/.test(text)) return 4;
    // 兴趣爱好
    if (/我的(爱好|兴趣|特长)是?/.test(text)) return 4;

    // === 个人信息 (3分) ===
    // 需要更具体的匹配
    if (/我(今年|现在)?\d{1,3}岁/.test(text)) return 3;  // 年龄
    if (/我(住在?|在|来自).{2,}/.test(text)) return 3;   // 地点
    if (/我(是|在).{1,6}(工作|上班|读书|上学)/.test(text)) return 3;  // 职业/学业
    if (/我(会|擅长|精通).{2,}/.test(text)) return 3;    // 技能
    if (/我有(一?个?)?(男|女)?(朋友|老婆|老公|儿子|女儿)/.test(text)) return 3;  // 家庭

    // === 计划意向 (2分) ===
    // 需要有具体内容
    if (/我(想|要|打算|计划|准备).{3,}/.test(text)) return 2;

    // 默认不存储
    return 0;
}


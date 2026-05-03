/**
 * RAG 知识库管理
 * 文档切片、向量存储、相似度检索
 */

import type { Table } from '@lancedb/lancedb';
import { log } from '../logger.js';
import { generateEmbedding, VECTOR_DIMENSION } from './embedding.js';
import { getDb } from './client.js';
import type { KnowledgeItem } from './types.js';

// 配置
const CHUNK_SIZE = 500;           // 每个切片最大字符数
const CHUNK_OVERLAP = 50;         // 切片重叠字符数
const MIN_SCORE_THRESHOLD = 0.4;  // 相似度阈值（适配 text-embedding-3-small 1536维）

// 表名
const KNOWLEDGE_TABLE = 'knowledge_base';

// 移除本地 KnowledgeRecord 定义，使用 KnowledgeItem
export type { KnowledgeItem } from './types.js';

/**
 * 知识库表缓存
 */
let knowledgeTable: Table | null = null;

/**
 * 获取或创建知识库表
 */
async function getKnowledgeTable(): Promise<Table> {
    if (knowledgeTable) return knowledgeTable;

    const database = await getDb();
    const tableNames = await database.tableNames();

    // 定义初始记录（确保 Schema 包含所有字段）
    const initialRecord: KnowledgeItem = {
        id: 'init',
        text: 'system init',
        vector: new Array(VECTOR_DIMENSION).fill(0),
        source: 'system',
        category: 'system', // 明确包含 category 字段
        createdAt: Date.now(),
    };

    if (tableNames.includes(KNOWLEDGE_TABLE)) {
        knowledgeTable = await database.openTable(KNOWLEDGE_TABLE);

        // --- Schema 迁移检查 ---
        try {
            const preview = await knowledgeTable.query().limit(1).toArray();
            if (preview.length > 0) {
                // 检查第一条记录是否包含 category 字段
                const hasCategory = Object.prototype.hasOwnProperty.call(preview[0], 'category');

                if (!hasCategory) {
                    log.warn('⚠️ 检测到 Knowledge 表缺少 category 字段，正在执行自动迁移...');

                    // 1. 读取所有数据
                    const allData = await knowledgeTable.query().toArray() as Record<string, unknown>[];
                    log.info(`📦 备份数据: ${allData.length} 条`);

                    // 2. 删除旧表
                    await database.dropTable(KNOWLEDGE_TABLE);

                    // 3. 重建表 (使用带 category 的 initialRecord)
                    knowledgeTable = await database.createTable(KNOWLEDGE_TABLE, [initialRecord as unknown as Record<string, unknown>]);

                    // 4. 恢复数据 (注入默认 category)
                    const dataToRestore = allData
                        .filter((r) => r.id !== 'init') // 过滤旧的 init
                        .map((r) => ({
                            ...r,
                            category: r.category || '', // 确保有值
                            vector: (r.vector as number[]) || new Array(VECTOR_DIMENSION).fill(0) // 防御性
                        }));

                    if (dataToRestore.length > 0) {
                        await knowledgeTable.add(dataToRestore);
                    }
                    log.info(`✅ Schema 迁移完成，已恢复 ${dataToRestore.length} 条数据`);
                }
            }
        } catch (e: unknown) {
            log.error('Schema 迁移检查失败:', e instanceof Error ? e.message : String(e));
        }
        // -----------------------

        return knowledgeTable;
    }

    knowledgeTable = await database.createTable(KNOWLEDGE_TABLE, [initialRecord as unknown as Record<string, unknown>]);
    log.info(`📚 创建知识库表: ${KNOWLEDGE_TABLE}`);

    return knowledgeTable;
}

/**
 * 文本切片（按段落或固定长度）
 */
export function chunkText(text: string, source: string): Array<{ text: string; source: string }> {
    const chunks: Array<{ text: string; source: string }> = [];

    // 先按段落分割
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);

    for (const para of paragraphs) {
        if (para.length <= CHUNK_SIZE) {
            // 段落够短，直接作为一个 chunk
            chunks.push({ text: para.trim(), source });
        } else {
            // 段落太长，按固定长度切片（带重叠）
            let start = 0;
            while (start < para.length) {
                const end = Math.min(start + CHUNK_SIZE, para.length);
                const chunk = para.slice(start, end).trim();
                if (chunk.length > 0) {
                    chunks.push({ text: chunk, source });
                }
                start = end - CHUNK_OVERLAP;
                if (start >= para.length - CHUNK_OVERLAP) break;
            }
        }
    }

    return chunks;
}

/**
 * 添加知识（自动切片）
 */
export async function addKnowledge(text: string, source: string = '手动添加', category?: string): Promise<number> {
    const chunks = chunkText(text, source);
    const table = await getKnowledgeTable();
    let added = 0;

    for (const chunk of chunks) {
        try {
            const vector = await generateEmbedding(chunk.text);
            const record: KnowledgeItem = {
                id: `k_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                text: chunk.text,
                vector,
                source: chunk.source,
                category,
                createdAt: Date.now(),
            };
            await table.add([record as unknown as Record<string, unknown>]);
            added++;
        } catch (err: unknown) {
            log.error('添加知识失败:', err instanceof Error ? err.message : String(err));
        }
    }

    log.info(`📚 知识库添加 ${added} 条 (来源: ${source})`);
    return added;
}

async function getKnowledgeRecordById(id: string): Promise<KnowledgeItem | null> {
    try {
        const table = await getKnowledgeTable();
        const results = await table.query().toArray() as KnowledgeItem[];
        const matched = results.find((item) => item.id === id);
        return matched || null;
    } catch (err: unknown) {
        log.error('获取知识原始记录失败:', err instanceof Error ? err.message : String(err));
        return null;
    }
}

export async function updateKnowledge(
    id: string,
    text: string,
    source: string = '手动修改',
    category?: string,
): Promise<boolean> {
    const existing = await getKnowledgeRecordById(id);
    if (!existing || existing.id === 'init') {
        return false;
    }

    const nextText = text.trim();
    if (!nextText) {
        return false;
    }

    const table = await getKnowledgeTable();
    const vector = await generateEmbedding(nextText);
    const nextRecord: KnowledgeItem = {
        id: existing.id,
        text: nextText,
        vector,
        source,
        category,
        createdAt: existing.createdAt,
    };

    try {
        await table.delete(`id = "${id}"`);
        await table.add([nextRecord as unknown as Record<string, unknown>]);
        log.info(`📚 更新知识: ${id}`);
        return true;
    } catch (err: unknown) {
        log.error('更新知识失败:', err instanceof Error ? err.message : String(err));
        try {
            await table.delete(`id = "${id}"`);
            await table.add([existing as unknown as Record<string, unknown>]);
        } catch (restoreErr: unknown) {
            log.error('恢复旧知识记录失败:', restoreErr instanceof Error ? restoreErr.message : String(restoreErr));
        }
        return false;
    }
}

/**
 * 检索相关知识（带相似度阈值和超时）
 */
export async function searchKnowledge(query: string, limit: number = 3): Promise<Array<{ text: string; source: string; score: number }>> {
    // 5 秒超时
    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('知识检索超时')), 5000)
    );

    try {
        const searchPromise = (async () => {
            const queryVector = await generateEmbedding(query);
            const table = await getKnowledgeTable();

            // LanceDB search API (metricType is not available, defaults to L2)
            const results = await table
                .search(queryVector)
                .limit(limit + 5)
                .toArray() as (KnowledgeItem & { _distance?: number })[];

            // 过滤掉初始化记录和低相似度结果
            const filtered = results
                .filter((r) => r.id !== 'init')
                .map((r) => ({
                    text: r.text,
                    source: r.source,
                    // L2 distance -> similarity: use 1/(1+distance) for [0,1] range
                    score: r._distance != null ? 1 / (1 + r._distance) : 0,
                }))
                .filter((r) => r.score >= MIN_SCORE_THRESHOLD)
                .slice(0, limit);

            // Debug: log raw distances
            log.debug(`📚 Raw distances: ${results.slice(0, 3).map(r => `${r.text.slice(0, 10)}=${r._distance}`).join(', ')}`);

            log.debug(`📚 知识检索 "${query.slice(0, 20)}...": ${filtered.length} 条 (阈值 ${MIN_SCORE_THRESHOLD})`);
            return filtered;
        })();

        return await Promise.race([searchPromise, timeoutPromise]);
    } catch (err: unknown) {
        log.warn('知识检索失败或超时:', err instanceof Error ? err.message : String(err));
        return [];
    }
}

/**
 * 获取所有知识（分页）
 */
export async function listKnowledge(limit: number = 20, offset: number = 0): Promise<KnowledgeItem[]> {
    try {
        const table = await getKnowledgeTable();
        const results = await table
            .query()
            .limit(limit + offset)
            .toArray();

        return (results as unknown as KnowledgeItem[])
            .filter((r) => r.id !== 'init')
            .slice(offset, offset + limit)
            .map((r) => ({
                id: r.id,
                text: r.text,
                source: r.source,
                category: r.category,
                createdAt: r.createdAt,
                vector: [],  // 不返回向量
            }));
    } catch (err: unknown) {
        log.error('获取知识列表失败:', err instanceof Error ? err.message : String(err));
        return [];
    }
}

/**
 * 获取单个知识
 */
export async function getKnowledge(id: string): Promise<KnowledgeItem | null> {
    try {
        const r = await getKnowledgeRecordById(id);
        if (!r) return null;
        return {
            id: r.id,
            text: r.text,
            source: r.source,
            category: r.category,
            createdAt: r.createdAt,
            vector: [],
        };
    } catch (err: unknown) {
        log.error('获取知识详情失败:', err instanceof Error ? err.message : String(err));
        return null;
    }
}

/**
 * 删除知识
 */
export async function deleteKnowledge(id: string): Promise<boolean> {
    try {
        const table = await getKnowledgeTable();
        await table.delete(`id = "${id}"`);
        log.info(`📚 删除知识: ${id}`);
        return true;
    } catch (err: unknown) {
        log.error('删除知识失败:', err instanceof Error ? err.message : String(err));
        return false;
    }
}

/**
 * 获取知识库统计
 */
export async function getKnowledgeStats(): Promise<{ total: number }> {
    try {
        const table = await getKnowledgeTable();
        const results = await table.query().toArray();
        const count = (results as unknown as KnowledgeItem[]).filter((r) => r.id !== 'init').length;
        return { total: count };
    } catch {
        return { total: 0 };
    }
}

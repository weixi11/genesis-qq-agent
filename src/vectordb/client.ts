/**
 * LanceDB 客户端
 * 向量数据库连接和表管理
 */

import * as path from 'path';
import { log } from '../logger.js';
import { VECTOR_DIMENSION } from './embedding.js';

import type { Connection, Table } from '@lancedb/lancedb';
import type lancedb from '@lancedb/lancedb';
import type { MemoryItem } from './types.js';

// 数据库路径
const DB_PATH = path.join(process.cwd(), 'data', 'lancedb');

// LanceDB 模块（懒加载）
let lancedbModule: typeof lancedb | null = null;

// 数据库连接（懒加载）
let db: Connection | null = null;

/**
 * 动态加载 LanceDB 模块
 */
async function getLanceDb(): Promise<typeof lancedb> {
    if (!lancedbModule) {
        const imported = await import('@lancedb/lancedb');
        lancedbModule = (imported.default || imported) as typeof lancedb;
    }
    return lancedbModule;
}

/**
 * 获取数据库连接
 */
export async function getDb(): Promise<Connection> {
    if (!db) {
        const lancedb = await getLanceDb();
        db = await lancedb.connect(DB_PATH);
        log.info(`📊 LanceDB 已连接: ${DB_PATH}`);
    }
    return db!;
}

/**
 * 用户记忆记录类型
 */
// 移除本地 MemoryRecord 定义，使用 MemoryItem
export type { MemoryItem } from './types.js';

// 表名
const MEMORY_TABLE = 'user_memories';

/**
 * 获取或创建记忆表
 */
export async function getMemoryTable(): Promise<Table> {
    const database = await getDb();
    const tableNames = await database.tableNames();

    if (tableNames.includes(MEMORY_TABLE)) {
        return database.openTable(MEMORY_TABLE);
    }

    // 创建新表（需要至少一条数据）
    const initialRecord: MemoryItem = {
        id: 'init',
        userId: 0,
        text: 'system init',
        vector: new Array(VECTOR_DIMENSION).fill(0),
        type: 'fact',
        importance: 1,
        timestamp: Date.now(),
    };

    const table = await database.createTable(MEMORY_TABLE, [initialRecord as unknown as Record<string, unknown>]);
    log.info(`📊 创建记忆表: ${MEMORY_TABLE}`);

    return table;
}

/**
 * 关闭数据库连接
 */
export function closeDb(): void {
    if (db) {
        // LanceDB 连接不需要显式关闭
        db = null;
        log.info('📊 LanceDB 已关闭');
    }
}

/**
 * 工具调用记录存储
 *
 * 持久化策略：
 * - 写入时同步操作 sql.js 内存（微秒级），文件写入由 genesis-db 防抖
 * - 启动时从 SQLite 恢复最近记录
 */

import { getGenesisDb, markDirty, mutateGenesisDbSnapshot } from '../../storage/genesis-db.js';
import { log } from '../../logger.js';
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { getGenesisProcessRole } from '../services/process_control.js';
import { isRecord, safeParseJson } from '../../utils/json.js';

export interface ToolUsageParams {
    name: string;
    params: Record<string, unknown>;
    result: string;
    success: boolean;
    duration: number;
    time: number;
    user: {
        id: number;
        name: string;
    };
    taskId?: string;
}

/** 结果截断大小 */
const MAX_RESULT_SIZE = 2048;
const GENESIS_DB_PATH = path.resolve(process.cwd(), 'data', 'genesis.db');
const LOG_FLUSH_DEBOUNCE_MS = 300;

function parseToolParams(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'string' || !raw.trim()) {
        return {};
    }

    const parsed = safeParseJson(raw);
    return isRecord(parsed) ? parsed : {};
}

export class ToolStatsStore {
    private logs: ToolUsageParams[] = [];
    private maxLogs = 50;

    add(record: ToolUsageParams): void {
        // 内存缓存
        this.logs.unshift(record);
        if (this.logs.length > this.maxLogs) {
            this.logs.pop();
        }

        const values = [
            record.time,
            record.name,
            JSON.stringify(record.params),
            record.result,
            record.success ? 1 : 0,
            record.duration,
            record.user.id,
            record.user.name,
            record.taskId || null,
        ];

        if (getGenesisProcessRole() === 'web') {
            void mutateGenesisDbSnapshot((db) => {
                db.run(
                    `INSERT INTO tool_logs (time, name, params_json, result, success, duration, user_id, user_name, task_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    values,
                );
            }).catch((err) => {
                log.warn('💾 Web 进程写入工具日志失败:', err);
            });
        } else {
            try {
                const db = getGenesisDb();
                db.run(
                    `INSERT INTO tool_logs (time, name, params_json, result, success, duration, user_id, user_name, task_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    values,
                );
                markDirty({ flushDelayMs: LOG_FLUSH_DEBOUNCE_MS });
            } catch (err) {
                log.warn('💾 工具日志写入 SQLite 失败:', err);
            }
        }
    }

    getLogs(): ToolUsageParams[] {
        return this.logs;
    }

    clear(): void {
        this.logs = [];
        if (getGenesisProcessRole() === 'web') {
            void mutateGenesisDbSnapshot((db) => {
                db.run('DELETE FROM tool_logs');
            }).catch((err) => {
                log.warn('💾 Web 进程清空工具日志失败:', err);
            });
            return;
        }

        try {
            const db = getGenesisDb();
            db.run('DELETE FROM tool_logs');
            markDirty({ flushDelayMs: LOG_FLUSH_DEBOUNCE_MS });
        } catch (err) {
            log.warn('💾 清空工具日志失败:', err);
        }
    }

    /**
     * 从 SQLite 恢复日志到内存
     */
    loadFromDb(): void {
        try {
            const db = getGenesisDb();
            const stmt = db.prepare(
                'SELECT * FROM tool_logs ORDER BY time DESC LIMIT ?',
            );
            stmt.bind([this.maxLogs]);

            const records: ToolUsageParams[] = [];
            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, unknown>;
                try {
                    records.push({
                        name: row.name as string,
                        params: parseToolParams(row.params_json),
                        result: (row.result as string) || '',
                        success: (row.success as number) === 1,
                        duration: row.duration as number,
                        time: row.time as number,
                        user: {
                            id: (row.user_id as number) || 0,
                            name: (row.user_name as string) || '',
                        },
                        taskId: (row.task_id as string) || undefined,
                    });
                } catch {
                    // 跳过损坏的记录
                }
            }
            stmt.free();

            this.logs = records;
            log.info(`💾 恢复 ${records.length} 条工具调用日志`);
        } catch (err) {
            log.warn('💾 恢复工具日志失败:', err);
        }
    }

    async reloadFromDisk(): Promise<void> {
        if (!fs.existsSync(GENESIS_DB_PATH)) {
            this.logs = [];
            return;
        }

        let tempDb: import('sql.js').Database | null = null;
        try {
            const SQL = await initSqlJs();
            const buffer = fs.readFileSync(GENESIS_DB_PATH);
            tempDb = new SQL.Database(buffer);
            const stmt = tempDb.prepare(
                'SELECT * FROM tool_logs ORDER BY time DESC LIMIT ?',
            );
            stmt.bind([this.maxLogs]);

            const records: ToolUsageParams[] = [];
            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, unknown>;
                try {
                    records.push({
                        name: row.name as string,
                        params: parseToolParams(row.params_json),
                        result: (row.result as string) || '',
                        success: (row.success as number) === 1,
                        duration: row.duration as number,
                        time: row.time as number,
                        user: {
                            id: (row.user_id as number) || 0,
                            name: (row.user_name as string) || '',
                        },
                        taskId: (row.task_id as string) || undefined,
                    });
                } catch {
                    // 跳过损坏的记录
                }
            }
            stmt.free();
            this.logs = records;
        } catch (err) {
            log.warn('💾 从磁盘重载工具日志失败:', err);
        } finally {
            tempDb?.close();
        }
    }
}

export const toolStats = new ToolStatsStore();

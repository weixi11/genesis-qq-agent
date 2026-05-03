/**
 * LLM 调用记录存储
 * 记录所有 LLM API 调用的详细信息
 * 
 * 持久化策略：
 * - 写入时同步操作内存 sql.js（微秒级），文件写入由 genesis-db 防抖
 * - 启动时从 SQLite 恢复最近记录
 * - 写盘前对大字段做结构化裁剪，避免日志把主库写胖
 */

import { getGenesisDb, markDirty, mutateGenesisDbSnapshot } from '../../storage/genesis-db.js';
import { log } from '../../logger.js';
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { getGenesisProcessRole } from '../services/process_control.js';
import { isRecord, safeParseJson } from '../../utils/json.js';

/** 截断大小限制 */
const MAX_JSON_SIZE = 8192;
const GENESIS_DB_PATH = path.resolve(process.cwd(), 'data', 'genesis.db');
const LOG_FLUSH_DEBOUNCE_MS = 300;
const MAX_STRING_LENGTH = 1200;
const MAX_ARRAY_ITEMS = 24;
const MAX_OBJECT_KEYS = 48;
const MAX_DEPTH = 6;

/**
 * 将日志对象裁剪为适合持久化的紧凑结构，避免超大请求体拖慢热路径。
 */
function safeStringify(obj: unknown): string {
    const seen = new WeakSet<object>();

    const truncateString = (value: string, maxLength: number = MAX_STRING_LENGTH): string => {
        if (value.length <= maxLength) {
            return value;
        }
        return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
    };

    const compactValue = (value: unknown, depth = 0): unknown => {
        if (typeof value === 'string') {
            return truncateString(value);
        }

        if (
            value === null
            || value === undefined
            || typeof value === 'number'
            || typeof value === 'boolean'
        ) {
            return value;
        }

        if (typeof value === 'bigint') {
            return value.toString();
        }

        if (typeof value === 'function') {
            return `[Function ${value.name || 'anonymous'}]`;
        }

        if (depth >= MAX_DEPTH) {
            return '[MaxDepth]';
        }

        if (Array.isArray(value)) {
            const items = value
                .slice(0, MAX_ARRAY_ITEMS)
                .map((item) => compactValue(item, depth + 1));
            if (value.length > MAX_ARRAY_ITEMS) {
                items.push(`[+${value.length - MAX_ARRAY_ITEMS} more items]`);
            }
            return items;
        }

        if (typeof value === 'object') {
            if (seen.has(value)) {
                return '[Circular]';
            }
            seen.add(value);

            if (value instanceof Date) {
                return value.toISOString();
            }

            if (value instanceof Error) {
                return {
                    name: value.name,
                    message: value.message,
                    stack: truncateString(value.stack || ''),
                };
            }

            if (ArrayBuffer.isView(value)) {
                return `[${value.constructor.name} length=${value.byteLength}]`;
            }

            const entries = Object.entries(value as Record<string, unknown>);
            const next: Record<string, unknown> = {};
            for (const [key, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
                next[key] = compactValue(entryValue, depth + 1);
            }
            if (entries.length > MAX_OBJECT_KEYS) {
                next._truncatedKeys = entries.length - MAX_OBJECT_KEYS;
            }
            return next;
        }

        return String(value);
    };

    const compacted = compactValue(obj);
    const result = JSON.stringify(compacted) || '{}';
    if (result.length <= MAX_JSON_SIZE) {
        return result;
    }

    return JSON.stringify({
        _truncated: true,
        summary: 'payload exceeded storage limit',
        preview: truncateString(result, Math.max(256, MAX_JSON_SIZE - 160)),
    });
}

function parseSafe(raw: string): Record<string, unknown> {
    if (!raw) return {};
    if (raw.endsWith('...[truncated]')) {
        return { _parseError: '数据已被暴力截断，无法解析为 JSON', rawPreview: raw.slice(0, 100) };
    }
    const parsed = safeParseJson(raw);
    return isRecord(parsed)
        ? parsed
        : { _parseError: '解析失败', rawPreview: raw.slice(0, 100) };
}

export interface LlmCallRecord {
    id: string;                    // 唯一 ID
    time: number;                  // 时间戳
    caller: string;                // 调用方 (sentry/router/persona/tech/tool:xxx)
    model: string;                 // 模型名
    request: {                     // 请求报文
        model: string;
        messages: Array<{ role: string; content: unknown }>;
        temperature?: number;
        max_tokens?: number;
        tools?: unknown[];         // Function calling
        stream?: boolean;
    };
    response: {                    // 响应报文
        content: string;
        input_tokens?: number;
        output_tokens?: number;
        tool_calls?: unknown[];
        thinking?: string;
    };
    duration: number;              // 耗时 ms
    success: boolean;
    error?: string;
}


export class LlmStatsStore {
    private logs: LlmCallRecord[] = [];
    private maxLogs = 100;
    private idCounter = 0;

    add(record: Omit<LlmCallRecord, 'id'>): string {
        const id = `llm_${Date.now()}_${++this.idCounter}`;
        const fullRecord: LlmCallRecord = { id, ...record };

        // 内存缓存
        this.logs.unshift(fullRecord);
        if (this.logs.length > this.maxLogs) {
            this.logs.pop();
        }

        const values = [
            id,
            record.time,
            record.caller,
            record.model,
            safeStringify(record.request),
            safeStringify(record.response),
            record.duration,
            record.success ? 1 : 0,
            record.error || null,
        ];

        if (getGenesisProcessRole() === 'web') {
            void mutateGenesisDbSnapshot((db) => {
                db.run(
                    `INSERT OR REPLACE INTO llm_logs (id, time, caller, model, request_json, response_json, duration, success, error)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    values,
                );
            }).catch((err) => {
                log.warn('💾 Web 进程写入 LLM 日志失败:', err);
            });
        } else {
            try {
                const db = getGenesisDb();
                db.run(
                    `INSERT OR REPLACE INTO llm_logs (id, time, caller, model, request_json, response_json, duration, success, error)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    values,
                );
                markDirty({ flushDelayMs: LOG_FLUSH_DEBOUNCE_MS });
            } catch (err) {
                log.warn('💾 LLM 日志写入 SQLite 失败:', err);
            }
        }

        return id;
    }

    getLogs(): LlmCallRecord[] {
        return this.logs;
    }

    getById(id: string): LlmCallRecord | undefined {
        return this.logs.find(entry => entry.id === id);
    }

    getStats(): {
        total: number;
        success: number;
        failed: number;
        avgDuration: number;
        totalInputTokens: number;
        totalOutputTokens: number;
    } {
        const total = this.logs.length;
        const success = this.logs.filter(l => l.success).length;
        const failed = total - success;
        const avgDuration = total > 0
            ? Math.round(this.logs.reduce((sum, l) => sum + l.duration, 0) / total)
            : 0;
        const totalInputTokens = this.logs.reduce((sum, l) => sum + (l.response.input_tokens || 0), 0);
        const totalOutputTokens = this.logs.reduce((sum, l) => sum + (l.response.output_tokens || 0), 0);

        return { total, success, failed, avgDuration, totalInputTokens, totalOutputTokens };
    }

    clear(): void {
        this.logs = [];
        if (getGenesisProcessRole() === 'web') {
            void mutateGenesisDbSnapshot((db) => {
                db.run('DELETE FROM llm_logs');
            }).catch((err) => {
                log.warn('💾 Web 进程清空 LLM 日志失败:', err);
            });
            return;
        }

        try {
            const db = getGenesisDb();
            db.run('DELETE FROM llm_logs');
            markDirty({ flushDelayMs: LOG_FLUSH_DEBOUNCE_MS });
        } catch (err) {
            log.warn('💾 清空 LLM 日志失败:', err);
        }
    }

    /**
     * 从 SQLite 恢复日志到内存
     */
    loadFromDb(): void {
        try {
            const db = getGenesisDb();
            const stmt = db.prepare(
                'SELECT * FROM llm_logs ORDER BY time DESC LIMIT ?',
            );
            stmt.bind([this.maxLogs]);

            const records: LlmCallRecord[] = [];
            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, unknown>;

                try {
                    records.push({
                        id: row.id as string,
                        time: row.time as number,
                        caller: row.caller as string,
                        model: row.model as string,
                        request: parseSafe(row.request_json as string) as LlmCallRecord['request'],
                        response: parseSafe(row.response_json as string) as LlmCallRecord['response'],
                        duration: row.duration as number,
                        success: (row.success as number) === 1,
                        error: (row.error as string) || undefined,
                    });
                } catch {
                    // 仅当基本字段都错误时才跳过
                }
            }
            stmt.free();

            this.logs = records;
            log.info(`💾 恢复 ${records.length} 条 LLM 调用日志`);
        } catch (err) {
            log.warn('💾 恢复 LLM 日志失败:', err);
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
                'SELECT * FROM llm_logs ORDER BY time DESC LIMIT ?',
            );
            stmt.bind([this.maxLogs]);

            const records: LlmCallRecord[] = [];
            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, unknown>;
                try {
                    records.push({
                        id: row.id as string,
                        time: row.time as number,
                        caller: row.caller as string,
                        model: row.model as string,
                        request: parseSafe(row.request_json as string) as LlmCallRecord['request'],
                        response: parseSafe(row.response_json as string) as LlmCallRecord['response'],
                        duration: row.duration as number,
                        success: (row.success as number) === 1,
                        error: (row.error as string) || undefined,
                    });
                } catch {
                    // 跳过损坏记录
                }
            }
            stmt.free();
            this.logs = records;
        } catch (err) {
            log.warn('💾 从磁盘重载 LLM 日志失败:', err);
        } finally {
            tempDb?.close();
        }
    }
}

export const llmStats = new LlmStatsStore();

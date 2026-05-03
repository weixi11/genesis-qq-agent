/**
 * Genesis 统一 SQLite 数据库管理
 * 
 * 使用 sql.js（纯 JS 实现），与 profiles-sqlite.ts 模式一致。
 * 
 * 性能优化：
 * - sql.js 操作内存数据库（INSERT/SELECT）是微秒级的
 * - 文件写入使用防抖机制，每 5 秒最多写一次
 * - 关闭时强制保存
 */

import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { log } from '../logger.js';
import { isRecord, safeParseJson } from '../utils/json.js';

// ==================== 常量 ====================

/** 数据库文件路径 */
export const GENESIS_DB_PATH = path.resolve(process.cwd(), 'data', 'genesis.db');
const GENESIS_DB_LOCK_PATH = `${GENESIS_DB_PATH}.lock`;

/** 防抖写入间隔（毫秒） */
const SAVE_DEBOUNCE_MS = 5000;
const MIN_SAVE_DEBOUNCE_MS = 0;
const DB_LOCK_POLL_MS = 25;
const DB_LOCK_TIMEOUT_MS = 15_000;
const DB_LOCK_STALE_MS = 30_000;

/** 数据保留策略 */
const RETENTION = {
    /** LLM 日志保留天数 */
    LLM_LOGS_DAYS: 7,
    /** 工具日志保留天数 */
    TOOL_LOGS_DAYS: 7,
    /** 上下文消息保留小时数 */
    CONTEXT_HOURS: 24,
    /** 任务记录保留天数 */
    TASKS_DAYS: 3,
    /** 哨兵状态保留小时数 */
    SENTRY_HOURS: 4,
    /** 媒体引用保留小时数 */
    MEDIA_HOURS: 24,
    /** 定时任务日志保留天数 */
    SCHEDULER_LOGS_DAYS: 7,
    /** 手动调度请求保留天数 */
    SCHEDULER_REQUESTS_DAYS: 3,
    /** 画像重算请求保留天数 */
    PROFILER_REANALYZE_REQUESTS_DAYS: 3,
    /** Web 工具测试请求保留天数 */
    TOOL_TEST_REQUESTS_DAYS: 3,
} as const;

// ==================== 内部状态 ====================

let db: SqlJsDatabase | null = null;
let initialized = false;
let dirty = false;
let saveTimer: NodeJS.Timeout | null = null;
let saveDueAt = 0;
let cleanupTimer: NodeJS.Timeout | null = null;
let dbMode: GenesisDbMode = 'readwrite';
let lockFd: number | null = null;

export type GenesisDbMode = 'readwrite' | 'readonly';

interface InitGenesisDbOptions {
    mode?: GenesisDbMode;
}

function sleepSync(ms: number): void {
    const view = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(view, 0, 0, ms);
}

function isLockFileStale(): boolean {
    try {
        const raw = fs.readFileSync(GENESIS_DB_LOCK_PATH, 'utf8');
        const payload = safeParseJson(raw);
        if (!isRecord(payload)) {
            return true;
        }
        const createdAt = typeof payload.createdAt === 'number' ? payload.createdAt : 0;
        if (createdAt > 0 && Date.now() - createdAt > DB_LOCK_STALE_MS) {
            return true;
        }
        const pid = typeof payload.pid === 'number' ? payload.pid : 0;
        if (!pid || pid === process.pid) {
            return false;
        }
        try {
            process.kill(pid, 0);
            return false;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
    } catch {
        return true;
    }
}

function cleanupStaleLockSync(): void {
    if (!fs.existsSync(GENESIS_DB_LOCK_PATH)) {
        return;
    }
    if (!isLockFileStale()) {
        return;
    }
    try {
        fs.unlinkSync(GENESIS_DB_LOCK_PATH);
    } catch {
        // 其他进程可能已接管或删除，忽略即可
    }
}

function releaseLock(): void {
    if (lockFd === null) {
        return;
    }

    const fd = lockFd;
    lockFd = null;
    if (fd !== null) {
        try {
            fs.closeSync(fd);
        } catch {
            // ignore
        }
    }
    try {
        fs.unlinkSync(GENESIS_DB_LOCK_PATH);
    } catch {
        // ignore
    }
}

function acquireGenesisDbFileLockSync(timeoutMs = DB_LOCK_TIMEOUT_MS): () => void {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        try {
            const fd = fs.openSync(GENESIS_DB_LOCK_PATH, 'wx');
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
            lockFd = fd;
            return releaseLock;
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code !== 'EEXIST') {
                throw err;
            }
            cleanupStaleLockSync();
            sleepSync(DB_LOCK_POLL_MS);
        }
    }

    throw new Error(`acquire genesis db lock timeout after ${timeoutMs}ms`);
}

async function acquireGenesisDbFileLock(timeoutMs = DB_LOCK_TIMEOUT_MS): Promise<() => void> {
    return acquireGenesisDbFileLockSync(timeoutMs);
}

// ==================== 核心 API ====================

/**
 * 初始化 Genesis 数据库
 */
export async function initGenesisDb(options: InitGenesisDbOptions = {}): Promise<void> {
    if (db && initialized) return;
    dbMode = options.mode || 'readwrite';

    const SQL = await initSqlJs();

    // 确保目录存在
    const dir = path.dirname(GENESIS_DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // 加载或创建数据库
    if (fs.existsSync(GENESIS_DB_PATH)) {
        const buffer = fs.readFileSync(GENESIS_DB_PATH);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }

    // 创建所有表
    createTables(db);

    initialized = true;
    log.info('💾 Genesis 数据库已连接 (genesis.db)');

    // 只在可写进程中做周期清理，避免 web 进程竞争持久化
    if (dbMode === 'readwrite' && !cleanupTimer) {
        cleanupTimer = setInterval(() => {
            cleanupExpiredData();
        }, 60 * 60 * 1000);
        cleanupTimer.unref?.();
    }
}

/**
 * 获取数据库实例（同步）
 */
export function getGenesisDb(): SqlJsDatabase {
    if (!db || !initialized) {
        throw new Error('Genesis DB not initialized. Call initGenesisDb() first.');
    }
    return db;
}

/**
 * 标记数据已变更，触发防抖写入
 */
export function markDirty(options: { flushDelayMs?: number } = {}): void {
    if (dbMode === 'readonly') {
        return;
    }
    dirty = true;
    const flushDelayMs = options.flushDelayMs ?? SAVE_DEBOUNCE_MS;
    if (flushDelayMs <= 0) {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        saveDueAt = 0;
        saveGenesisDbNow();
        return;
    }
    scheduleSave(flushDelayMs);
}

/**
 * 强制立即保存到文件
 */
export function saveGenesisDbNow(): void {
    if (!db || !dirty || dbMode === 'readonly') return;

    const release = acquireGenesisDbFileLockSync();
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        writeGenesisDbFileUnlocked(buffer);
        dirty = false;
    } catch (err) {
        log.error('💾 Genesis DB 保存失败:', err);
    } finally {
        release();
    }
}

async function createGenesisDbSnapshotUnlocked(): Promise<SqlJsDatabase> {
    const SQL = await initSqlJs();
    const dir = path.dirname(GENESIS_DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    let snapshot: SqlJsDatabase;
    if (fs.existsSync(GENESIS_DB_PATH)) {
        snapshot = new SQL.Database(fs.readFileSync(GENESIS_DB_PATH));
    } else {
        snapshot = new SQL.Database();
    }
    createTables(snapshot);
    return snapshot;
}

function flushGenesisDbToFileIfDirtyUnlocked(): void {
    if (!db || !initialized || !dirty || dbMode === 'readonly') {
        return;
    }

    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    saveDueAt = 0;
    const data = db.export();
    const buffer = Buffer.from(data);
    writeGenesisDbFileUnlocked(buffer);
    dirty = false;
}

function writeGenesisDbFileUnlocked(buffer: Buffer): void {
    const tempPath = `${GENESIS_DB_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tempPath, buffer);
    try {
        fs.renameSync(tempPath, GENESIS_DB_PATH);
    } finally {
        if (fs.existsSync(tempPath)) {
            try {
                fs.unlinkSync(tempPath);
            } catch {
                // ignore
            }
        }
    }
}

export async function readGenesisDbSnapshot<T>(
    reader: (database: SqlJsDatabase) => T | Promise<T>,
): Promise<T> {
    const release = await acquireGenesisDbFileLock();
    let snapshot: SqlJsDatabase | null = null;
    try {
        flushGenesisDbToFileIfDirtyUnlocked();
        snapshot = await createGenesisDbSnapshotUnlocked();
        return await reader(snapshot);
    } finally {
        snapshot?.close();
        release();
    }
}

export async function mutateGenesisDbSnapshot<T>(
    mutator: (database: SqlJsDatabase) => T | Promise<T>,
): Promise<T> {
    const release = await acquireGenesisDbFileLock();
    let snapshot: SqlJsDatabase | null = null;
    try {
        flushGenesisDbToFileIfDirtyUnlocked();
        snapshot = await createGenesisDbSnapshotUnlocked();
        const result = await mutator(snapshot);
        const buffer = Buffer.from(snapshot.export());
        writeGenesisDbFileUnlocked(buffer);
        return result;
    } finally {
        snapshot?.close();
        release();
    }
}

/**
 * 关闭数据库连接
 */
export function closeGenesisDb(): void {
    // 取消定时器
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    saveDueAt = 0;
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }

    // 最终保存
    if (db) {
        if (dbMode === 'readwrite') {
            dirty = true; // 强制保存
            saveGenesisDbNow();
        } else {
            dirty = false;
        }
        db.close();
        db = null;
        initialized = false;
        dbMode = 'readwrite';
        log.info('💾 Genesis 数据库已关闭');
    }
}

/**
 * 清理过期数据
 */
export function cleanupExpiredData(): void {
    if (!db || !initialized) return;

    const now = Date.now();

    try {
        // LLM 日志
        const llmCutoff = now - RETENTION.LLM_LOGS_DAYS * 24 * 60 * 60 * 1000;
        db.run('DELETE FROM llm_logs WHERE time < ?', [llmCutoff]);

        // 工具日志
        const toolCutoff = now - RETENTION.TOOL_LOGS_DAYS * 24 * 60 * 60 * 1000;
        db.run('DELETE FROM tool_logs WHERE time < ?', [toolCutoff]);

        // 上下文消息
        const ctxCutoff = now - RETENTION.CONTEXT_HOURS * 60 * 60 * 1000;
        db.run('DELETE FROM context_messages WHERE message_time < ?', [ctxCutoff]);

        // 已完成任务
        const taskCutoff = now - RETENTION.TASKS_DAYS * 24 * 60 * 60 * 1000;
        db.run(
            "DELETE FROM tasks WHERE status IN ('success','failed','timeout','cancelled') AND created_at < ?",
            [taskCutoff],
        );

        // 哨兵状态
        const sentryCutoff = now - RETENTION.SENTRY_HOURS * 60 * 60 * 1000;
        db.run('DELETE FROM sentry_user_states WHERE last_message_time < ?', [sentryCutoff]);
        db.run('DELETE FROM sentry_group_states WHERE last_message_time < ?', [sentryCutoff]);

        // 媒体引用
        const mediaCutoff = now - RETENTION.MEDIA_HOURS * 60 * 60 * 1000;
        db.run('DELETE FROM media_references WHERE timestamp < ?', [mediaCutoff]);

        // 定时任务日志
        const schedulerCutoff = now - RETENTION.SCHEDULER_LOGS_DAYS * 24 * 60 * 60 * 1000;
        db.run('DELETE FROM scheduler_logs WHERE time_ms < ?', [schedulerCutoff]);

        // 手动调度请求
        const schedulerRequestCutoff = now - RETENTION.SCHEDULER_REQUESTS_DAYS * 24 * 60 * 60 * 1000;
        db.run(
            "DELETE FROM scheduler_run_requests WHERE status IN ('success','failed') AND requested_at < ?",
            [schedulerRequestCutoff],
        );

        // 画像重算请求
        const profilerReanalyzeRequestCutoff = now - RETENTION.PROFILER_REANALYZE_REQUESTS_DAYS * 24 * 60 * 60 * 1000;
        db.run(
            "DELETE FROM profiler_reanalyze_requests WHERE status IN ('success','failed') AND requested_at < ?",
            [profilerReanalyzeRequestCutoff],
        );

        // Web 工具测试请求
        const toolTestRequestCutoff = now - RETENTION.TOOL_TEST_REQUESTS_DAYS * 24 * 60 * 60 * 1000;
        db.run(
            "DELETE FROM tool_test_requests WHERE status IN ('success','failed') AND requested_at < ?",
            [toolTestRequestCutoff],
        );

        markDirty();
        log.debug('💾 Genesis DB 过期数据已清理');
    } catch (err) {
        log.error('💾 清理过期数据失败:', err);
    }
}

// ==================== 内部函数 ====================

/**
 * 防抖写入调度
 */
function scheduleSave(delayMs: number = SAVE_DEBOUNCE_MS): void {
    const normalizedDelay = Math.max(MIN_SAVE_DEBOUNCE_MS, delayMs);
    const nextDueAt = Date.now() + normalizedDelay;

    if (saveTimer) {
        if (saveDueAt <= nextDueAt) {
            return;
        }
        clearTimeout(saveTimer);
        saveTimer = null;
    }

    saveDueAt = nextDueAt;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveDueAt = 0;
        saveGenesisDbNow();
    }, normalizedDelay);
}

/**
 * 创建所有表
 */
function createTables(database: SqlJsDatabase): void {
    // 上下文记忆
    database.run(`
        CREATE TABLE IF NOT EXISTS context_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            message_json TEXT NOT NULL,
            message_time INTEGER NOT NULL
        )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_context_session ON context_messages(session_key)');

    // LLM 调用日志
    database.run(`
        CREATE TABLE IF NOT EXISTS llm_logs (
            id TEXT PRIMARY KEY,
            time INTEGER NOT NULL,
            caller TEXT NOT NULL,
            model TEXT NOT NULL,
            request_json TEXT,
            response_json TEXT,
            duration INTEGER NOT NULL,
            success INTEGER NOT NULL,
            error TEXT
        )
    `);

    // 工具调用日志
    database.run(`
        CREATE TABLE IF NOT EXISTS tool_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            time INTEGER NOT NULL,
            name TEXT NOT NULL,
            params_json TEXT,
            result TEXT,
            success INTEGER NOT NULL,
            duration INTEGER NOT NULL,
            user_id INTEGER,
            user_name TEXT,
            task_id TEXT
        )
    `);

    // 任务记录
    database.run(`
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            group_id INTEGER,
            tool_name TEXT NOT NULL,
            params_json TEXT,
            hash TEXT,
            status TEXT NOT NULL,
            priority TEXT NOT NULL,
            progress INTEGER,
            result_json TEXT,
            error TEXT,
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            finished_at INTEGER,
            timeout_ms INTEGER,
            retry_count INTEGER DEFAULT 0,
            max_retries INTEGER DEFAULT 0,
            cancelled INTEGER DEFAULT 0
        )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id)');
    database.run('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');

    // 哨兵用户状态
    database.run(`
        CREATE TABLE IF NOT EXISTS sentry_user_states (
            key TEXT PRIMARY KEY,
            message_count INTEGER NOT NULL,
            ignored_count INTEGER NOT NULL,
            last_message_time INTEGER NOT NULL,
            last_was_question INTEGER NOT NULL
        )
    `);

    // 哨兵群状态
    database.run(`
        CREATE TABLE IF NOT EXISTS sentry_group_states (
            group_id INTEGER PRIMARY KEY,
            last_response_time INTEGER NOT NULL,
            recent_active_users TEXT NOT NULL,
            last_message_time INTEGER NOT NULL,
            cooling INTEGER NOT NULL
        )
    `);

    // 媒体引用
    database.run(`
        CREATE TABLE IF NOT EXISTS media_references (
            id TEXT NOT NULL,
            session_key TEXT NOT NULL,
            sender_id INTEGER NOT NULL,
            sender_name TEXT NOT NULL,
            type TEXT NOT NULL,
            path TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            user_index INTEGER NOT NULL,
            global_index INTEGER NOT NULL,
            filename TEXT,
            message_id INTEGER NOT NULL,
            PRIMARY KEY (session_key, id)
        )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_media_session ON media_references(session_key)');

    // 定时任务
    database.run(`
        CREATE TABLE IF NOT EXISTS scheduler_tasks (
            task_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            schedule_type TEXT NOT NULL,
            run_at TEXT,
            cron TEXT,
            timezone TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            tool_params_json TEXT NOT NULL,
            enabled INTEGER NOT NULL,
            retries INTEGER NOT NULL,
            timeout_sec INTEGER NOT NULL,
            max_concurrency INTEGER NOT NULL,
            notify_on_fail INTEGER NOT NULL,
            created_by INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_by INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            next_run_time TEXT,
            last_run_time TEXT,
            last_status TEXT NOT NULL,
            last_error TEXT,
            run_count INTEGER NOT NULL,
            running_count INTEGER NOT NULL,
            group_id INTEGER
        )
    `);

    // 定时任务日志
    database.run(`
        CREATE TABLE IF NOT EXISTS scheduler_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            time TEXT NOT NULL,
            time_ms INTEGER NOT NULL,
            status TEXT NOT NULL,
            message TEXT NOT NULL,
            duration_ms INTEGER NOT NULL,
            trigger_source TEXT NOT NULL,
            triggered_by INTEGER NOT NULL,
            attempts INTEGER NOT NULL,
            error_code TEXT,
            error_message TEXT
        )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_scheduler_logs_task ON scheduler_logs(task_id)');

    // 手动调度请求队列
    database.run(`
        CREATE TABLE IF NOT EXISTS scheduler_run_requests (
            request_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            triggered_by INTEGER NOT NULL,
            status TEXT NOT NULL,
            requested_at INTEGER NOT NULL,
            started_at INTEGER,
            finished_at INTEGER,
            result_message TEXT,
            error_code TEXT,
            error_message TEXT
        )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_scheduler_run_requests_status ON scheduler_run_requests(status, requested_at)');

    // 画像重算请求队列
    database.run(`
        CREATE TABLE IF NOT EXISTS profiler_reanalyze_requests (
            request_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            messages_json TEXT NOT NULL,
            status TEXT NOT NULL,
            requested_at INTEGER NOT NULL,
            started_at INTEGER,
            finished_at INTEGER,
            analyzed_count INTEGER,
            error_message TEXT
        )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_profiler_reanalyze_requests_status ON profiler_reanalyze_requests(status, requested_at)');

    // Web 工具测试请求队列
    database.run(`
        CREATE TABLE IF NOT EXISTS tool_test_requests (
            request_id TEXT PRIMARY KEY,
            tool_name TEXT NOT NULL,
            params_json TEXT NOT NULL,
            context_json TEXT NOT NULL,
            status TEXT NOT NULL,
            requested_at INTEGER NOT NULL,
            started_at INTEGER,
            finished_at INTEGER,
            duration_ms INTEGER,
            response_json TEXT,
            error_message TEXT
        )
    `);
    database.run('CREATE INDEX IF NOT EXISTS idx_tool_test_requests_status ON tool_test_requests(status, requested_at)');
}

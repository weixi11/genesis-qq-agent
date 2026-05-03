/**
 * 日志模块
 * 支持控制台输出 + 文件日志（按日期轮转）
 */

import { config } from './config.js';
import fs from 'fs';
import path from 'path';
import { stringifyForDisplay } from './utils/format.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type RecentLogEntry = {
    time: number;
    level: string;
    message: string;
};

const LEVELS: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 99,
};

const currentLevel = LEVELS[config.logLevel as LogLevel] || LEVELS.info;

// ==================== 文件日志配置 ====================

/** 日志输出目录 */
const LOG_DIR = path.resolve(process.cwd(), 'data', 'logs');

/** 保留天数 */
const LOG_RETENTION_DAYS = 7;

/** 当前日志文件流 */
let logStream: fs.WriteStream | null = null;

/** 当前日志日期（用于检测日期切换） */
let currentLogDate = '';
const RECENT_LOG_LIMIT = 400;
const recentLogs: RecentLogEntry[] = [];

/**
 * 获取当天日期字符串 YYYY-MM-DD
 */
function getDateStr(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * 确保日志目录存在并初始化文件流
 */
function ensureLogStream(): fs.WriteStream | null {
    try {
        const today = getDateStr();

        // 日期没变且流还在，直接返回
        if (logStream && currentLogDate === today) {
            return logStream;
        }

        // 关闭旧流
        if (logStream) {
            logStream.end();
            logStream = null;
        }

        // 确保目录存在
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }

        // 创建新流
        const logFile = path.join(LOG_DIR, `genesis-${today}.log`);
        logStream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });
        currentLogDate = today;

        // 异步清理过期日志
        cleanupOldLogs();

        return logStream;
    } catch {
        // 文件日志失败不影响程序运行
        return null;
    }
}

/**
 * 清理过期日志文件
 */
function cleanupOldLogs(): void {
    try {
        if (!fs.existsSync(LOG_DIR)) return;

        const files = fs.readdirSync(LOG_DIR);
        const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

        for (const file of files) {
            if (!file.startsWith('genesis-') || !file.endsWith('.log')) continue;

            const filePath = path.join(LOG_DIR, file);
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < cutoff) {
                fs.unlinkSync(filePath);
            }
        }
    } catch {
        // 清理失败不影响运行
    }
}

/**
 * 写入日志到文件
 */
function writeToFile(level: string, msg: string): void {
    const stream = ensureLogStream();
    if (!stream) return;

    const d = new Date();
    const timestamp = d.toISOString();
    stream.write(`[${timestamp}] [${level}] ${msg}\n`);
}

// ==================== 格式化工具 ====================

function formatTime(): string {
    const d = new Date();
    const HH = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${HH}:${mm}:${ss}`;
}

function stringify(v: unknown): string {
    return stringifyForDisplay(v, { maxLen: 200 });
}

function pushRecentLog(level: string, msg: string): void {
    recentLogs.push({
        time: Date.now(),
        level,
        message: msg,
    });
    if (recentLogs.length > RECENT_LOG_LIMIT) {
        recentLogs.splice(0, recentLogs.length - RECENT_LOG_LIMIT);
    }
}

function formatArgs(args: unknown[]): string {
    return args.map(stringify).join(' ');
}

// ==================== 事件监听器 ====================

const listeners: ((level: string, msg: string) => void)[] = [];

// ==================== 日志 API ====================

export const log = {
    debug: (msg: string, ...args: unknown[]) => {
        if (currentLevel <= LEVELS.debug) {
            const extra = args.length > 0 ? ' ' + formatArgs(args) : '';
            const fullMsg = `${msg}${extra}`;
            console.log(`[${formatTime()}] [DEBUG] ${fullMsg}`);
            writeToFile('DEBUG', fullMsg);
            pushRecentLog('DEBUG', fullMsg);
            listeners.forEach(l => l('DEBUG', fullMsg));
        }
    },
    info: (msg: string, ...args: unknown[]) => {
        if (currentLevel <= LEVELS.info) {
            const extra = args.length > 0 ? ' ' + formatArgs(args) : '';
            const fullMsg = `${msg}${extra}`;
            console.log(`[${formatTime()}] [INFO] ${fullMsg}`);
            writeToFile('INFO', fullMsg);
            pushRecentLog('INFO', fullMsg);
            listeners.forEach(l => l('INFO', fullMsg));
        }
    },
    warn: (msg: string, ...args: unknown[]) => {
        if (currentLevel <= LEVELS.warn) {
            const extra = args.length > 0 ? ' ' + formatArgs(args) : '';
            const fullMsg = `${msg}${extra}`;
            console.warn(`[${formatTime()}] [WARN] ${fullMsg}`);
            writeToFile('WARN', fullMsg);
            pushRecentLog('WARN', fullMsg);
            listeners.forEach(l => l('WARN', fullMsg));
        }
    },
    error: (msg: string, ...args: unknown[]) => {
        if (currentLevel <= LEVELS.error) {
            const extra = args.length > 0 ? ' ' + formatArgs(args) : '';
            const fullMsg = `${msg}${extra}`;
            console.error(`[${formatTime()}] [ERROR] ${fullMsg}`);
            writeToFile('ERROR', fullMsg);
            pushRecentLog('ERROR', fullMsg);
            listeners.forEach(l => l('ERROR', fullMsg));
        }
    },
    addListener: (fn: (level: string, msg: string) => void) => {
        listeners.push(fn);
    },
    getRecent: (limit = 200, since?: number): RecentLogEntry[] => {
        const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), RECENT_LOG_LIMIT)) : 200;
        const filtered = typeof since === 'number' && Number.isFinite(since)
            ? recentLogs.filter(item => item.time > since)
            : recentLogs;
        return filtered.slice(-normalizedLimit);
    },
    /** 关闭日志文件流 */
    close: () => {
        if (logStream) {
            logStream.end();
            logStream = null;
        }
    },
};

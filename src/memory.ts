/**
 * 滑动窗口记忆管理
 * 为每个会话（群/私聊）维护最近 N 条消息
 * 
 * 持久化策略：
 * - push() 时异步写入 SQLite（sql.js 内存操作，微秒级）
 * - clear() 时同步删除 SQLite 数据
 * - loadFromDb() 启动时从 SQLite 恢复所有会话
 */

import { config } from './config.js';
import { log } from './logger.js';
import { isMaster } from './utils/identity.js';
import type { FormattedMessage } from './types.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import { mediaTracker } from './services/media_tracker.js';
import { isInternalSelfReferenceDrawKey } from './utils/selfReferenceDraw.js';
import {
    getGenesisDb,
    markDirty,
    mutateGenesisDbSnapshot,
    readGenesisDbSnapshot,
} from './storage/genesis-db.js';
import { isRecord, safeParseJson } from './utils/json.js';

export interface ContextSessionSummary {
    key: string;
    count: number;
    lastActivity: number;
}

function readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item): item is string => typeof item === 'string');
}

function parseStoredMessage(raw: string): FormattedMessage | null {
    const parsed = safeParseJson(raw);
    if (!isRecord(parsed) || typeof parsed.sender_id !== 'number' || typeof parsed.text !== 'string') {
        return null;
    }

    const type = parsed.type === 'group' || parsed.type === 'private' ? parsed.type : 'private';
    const time = typeof parsed.time === 'number' ? parsed.time : 0;

    return {
        message_id: typeof parsed.message_id === 'number' ? parsed.message_id : 0,
        time,
        time_str: typeof parsed.time_str === 'string' ? parsed.time_str : '',
        type,
        self_id: typeof parsed.self_id === 'number' ? parsed.self_id : undefined,
        summary: typeof parsed.summary === 'string' ? parsed.summary : parsed.text,
        objective: typeof parsed.objective === 'string' ? parsed.objective : undefined,
        sender_id: parsed.sender_id,
        sender_name: typeof parsed.sender_name === 'string' ? parsed.sender_name : String(parsed.sender_id),
        sender_card: typeof parsed.sender_card === 'string' ? parsed.sender_card : undefined,
        sender_role: parsed.sender_role === 'owner' || parsed.sender_role === 'admin' || parsed.sender_role === 'member'
            ? parsed.sender_role
            : undefined,
        group_id: typeof parsed.group_id === 'number' ? parsed.group_id : undefined,
        group_name: typeof parsed.group_name === 'string' ? parsed.group_name : undefined,
        text: parsed.text,
        images: Array.isArray(parsed.images) ? parsed.images : [],
        videos: Array.isArray(parsed.videos) ? parsed.videos : [],
        records: Array.isArray(parsed.records) ? parsed.records : [],
        reply: isRecord(parsed.reply) ? parsed.reply as FormattedMessage['reply'] : undefined,
        at_users: Array.isArray(parsed.at_users)
            ? parsed.at_users.filter((item): item is number => typeof item === 'number')
            : [],
        at_all: typeof parsed.at_all === 'boolean' ? parsed.at_all : false,
        at_users_details: Array.isArray(parsed.at_users_details)
            ? parsed.at_users_details as FormattedMessage['at_users_details']
            : undefined,
        files: Array.isArray(parsed.files) ? parsed.files as FormattedMessage['files'] : [],
        cards: Array.isArray(parsed.cards) ? parsed.cards as FormattedMessage['cards'] : [],
        forwards: Array.isArray(parsed.forwards) ? parsed.forwards as FormattedMessage['forwards'] : undefined,
        faces: Array.isArray(parsed.faces) ? parsed.faces as FormattedMessage['faces'] : undefined,
        mface_urls: readStringArray(parsed.mface_urls),
        toolCall: isRecord(parsed.toolCall) ? parsed.toolCall as FormattedMessage['toolCall'] : undefined,
        raw: isRecord(parsed.raw) ? parsed.raw : undefined,
    };
}

function readRecentContextMessages(
    db: SqlJsDatabase,
    sessionKey: string,
    limit: number,
): FormattedMessage[] {
    const stmt = db.prepare(`
        SELECT message_json
        FROM (
            SELECT id, message_json, message_time
            FROM context_messages
            WHERE session_key = ?
            ORDER BY message_time DESC, id DESC
            LIMIT ?
        ) recent
        ORDER BY message_time ASC, id ASC
    `);
    stmt.bind([sessionKey, limit]);

    const messages: FormattedMessage[] = [];
    while (stmt.step()) {
        const row = stmt.getAsObject() as { message_json?: string };
        const parsed = parseStoredMessage(String(row.message_json || '{}'));
        if (parsed) {
            messages.push(parsed);
        }
    }
    stmt.free();
    return messages;
}

export class MemoryWindow {
    // key: "group:{group_id}" 或 "private:{user_id}"
    private windows = new Map<string, FormattedMessage[]>();
    private maxSize: number;

    constructor(maxSize: number = config.memoryWindowSize) {
        this.maxSize = maxSize;
    }

    /** 生成会话 key */
    private getKey(msg: FormattedMessage): string {
        if (msg.type === 'group' && msg.group_id) {
            return `group:${msg.group_id}`;
        } else {
            return `private:${msg.sender_id}`;
        }
    }

    /** 追加消息到窗口 */
    push(msg: FormattedMessage): void {
        const key = this.getKey(msg);
        let window = this.windows.get(key);

        if (!window) {
            window = [];
            this.windows.set(key, window);
        }

        window.push(msg);

        // 同步追踪媒体
        mediaTracker.trackMessage(key, msg);

        // 保持窗口大小
        while (window.length > this.maxSize) {
            window.shift();
        }

        // 持久化到 SQLite（sql.js 内存操作，微秒级）
        this.saveMessageToDb(key, msg);
    }

    /** 获取会话的历史消息（不含当前消息） */
    getHistory(msg: FormattedMessage): FormattedMessage[] {
        const key = this.getKey(msg);
        const window = this.windows.get(key);
        return window ? [...window] : [];
    }

    /** 获取会话的最后一条消息 */
    getLast(msg: FormattedMessage): FormattedMessage | undefined {
        const key = this.getKey(msg);
        const window = this.windows.get(key);
        return window && window.length > 0 ? window[window.length - 1] : undefined;
    }

    /** 清除指定会话的记忆 */
    clear(key: string): void {
        this.windows.delete(key);
        // 同步清除媒体追踪
        mediaTracker.clear(key);
        // 从 SQLite 删除
        this.clearSessionFromDb(key);
    }

    /** 清除所有记忆 */
    clearAll(): void {
        mediaTracker.clearAll();
        this.windows.clear();
        // 从 SQLite 清空
        this.clearAllFromDb();
    }

    /** 获取所有活跃会话数 */
    get sessionCount(): number {
        return this.windows.size;
    }

    /** 运行时更新窗口大小，并立即裁剪现有会话 */
    updateMaxSize(maxSize: number): void {
        this.maxSize = maxSize;
        for (const window of this.windows.values()) {
            while (window.length > this.maxSize) {
                window.shift();
            }
        }
    }

    // ===== 管理员功能 =====

    /** 获取所有会话 key 列表 */
    getAllSessions(): { key: string; count: number }[] {
        const sessions: { key: string; count: number }[] = [];
        for (const [key, messages] of this.windows.entries()) {
            sessions.push({ key, count: messages.length });
        }
        return sessions;
    }

    /** 根据 key 获取会话内容 */
    getSessionByKey(key: string): FormattedMessage[] | undefined {
        return this.windows.get(key);
    }

    /** 根据群号获取会话内容 */
    getGroupSession(groupId: number): FormattedMessage[] | undefined {
        return this.windows.get(`group:${groupId}`);
    }

    /** 根据用户 QQ 获取私聊会话内容 */
    getPrivateSession(userId: number): FormattedMessage[] | undefined {
        return this.windows.get(`private:${userId}`);
    }

    /** 清除群会话 */
    clearGroup(groupId: number): boolean {
        const key = `group:${groupId}`;
        const existed = this.windows.has(key);
        if (existed) {
            this.clear(key);
        }
        return existed;
    }

    /** 清除私聊会话 */
    clearPrivate(userId: number): boolean {
        const key = `private:${userId}`;
        const existed = this.windows.has(key);
        if (existed) {
            this.clear(key);
        }
        return existed;
    }

    /** 
     * 格式化消息列表为可读文本
     * @param messages 消息列表
     * @param options 格式化选项（不传则使用 config.context 默认值）
     */
    formatMessages(messages: FormattedMessage[], options?: {
        /** 最大消息数 */
        maxCount?: number;
        /** 机器人QQ号（用于标记Bot回复） */
        botId?: number;
        /** 是否显示序号 */
        showIndex?: boolean;
        /** 是否显示媒体文件完整路径 */
        showMediaPaths?: boolean;
    }): string {
        if (!messages || messages.length === 0) {
            return '(空)';
        }

        // 从 config 读取默认值
        const { context, botQQ } = config;
        const maxCount = options?.maxCount ?? context.maxCount;
        const showIndex = options?.showIndex ?? context.showIndex;
        const showMediaPaths = options?.showMediaPaths ?? context.showMediaPaths;
        const botId = options?.botId ?? botQQ;

        const list = maxCount ? messages.slice(-maxCount) : messages;

        return list.map((msg, i) => {
            const time = msg.time_str || new Date(msg.time * 1000).toLocaleTimeString('zh-CN');
            const sender = msg.sender_name || msg.sender_id;

            // 判断是否是机器人回复
            const isBot = botId && msg.sender_id === botId;

            // 构建角色前缀（Bot + 群身份+ 主人身份 可同时存在）
            let rolePrefix = '';
            if (isMaster(msg.sender_id)) rolePrefix += '[主人]';
            if (isBot) rolePrefix += '[Bot]';
            if (msg.type !== 'private') {
                if (msg.sender_role === 'owner') rolePrefix += '[群主]';
                else if (msg.sender_role === 'admin') rolePrefix += '[管理]';
            }

            // 收集消息内容部分
            const parts: string[] = [];

            // 文本内容（Bot 回复需要保留更多内容以便上下文理解）
            // 文本内容（Bot 回复需要保留更多内容以便上下文理解）
            let text = msg.text?.trim() || '';

            // 替换 @QQ 为 @昵称(QQ)
            if (msg.at_users_details?.length) {
                // 先按长度降序排序
                const details = [...msg.at_users_details].sort((a, b) => String(b.id).length - String(a.id).length);
                for (const u of details) {
                    const name = u.card || u.name || String(u.id);
                    const replacement = `@${name}(${u.id})`;
                    const regex = new RegExp(`@${u.id}(?![0-9])`, 'g');
                    if (regex.test(text)) {
                        text = text.replace(regex, replacement);
                    }
                }
            }

            if (text) {
                const maxLen = isBot ? 1000 : 1000;  // Bot 回复保留更多上下文
                parts.push(text.slice(0, maxLen));
            }

            // 补充未在文本中显示的 @信息 (仅对非Bot消息，Bot消息通常自带完整文本)
            if (!isBot && msg.at_users?.length > 0) {
                const missingAt: string[] = [];
                if (msg.at_users_details?.length) {
                    for (const u of msg.at_users_details) {
                        if (!text.includes(String(u.id))) {
                            const name = u.card || u.name || String(u.id);
                            missingAt.push(`@${name}(${u.id})`);
                        }
                    }
                } else {
                    for (const uid of msg.at_users) {
                        if (!text.includes(String(uid))) {
                            missingAt.push(`@${uid}`);
                        }
                    }
                }
                if (missingAt.length > 0) {
                    parts.push(missingAt.join(' '));
                }
            }

            // 多媒体标识（可选显示路径）
            if (msg.images?.length) {
                if (showMediaPaths && msg.images.length === 1) {
                    const img = msg.images[0];
                    let imgPath = '';
                    if (typeof img === 'string') imgPath = img;
                    else if (img) {
                        const imgObj = img as { path?: string; file?: string; url?: string };
                        imgPath = imgObj.path || imgObj.file || imgObj.url || '';
                    }
                    parts.push(imgPath ? `[图:${imgPath}]` : '[图]');
                } else {
                    parts.push(msg.images.length > 1 ? `[图x${msg.images.length}]` : '[图]');
                }
            }

            // 视频（可选显示路径）
            const videos = msg.videos || [];
            if (videos.length > 0) {
                if (showMediaPaths && videos.length === 1) {
                    const v = videos[0];
                    let vPath = '';
                    if (typeof v === 'string') vPath = v;
                    else if (v) {
                        const vObj = v as { path?: string; file?: string; url?: string };
                        vPath = vObj.path || vObj.file || vObj.url || '';
                    }
                    parts.push(vPath ? `[视频:${vPath}]` : '[视频]');
                } else {
                    parts.push(videos.length > 1 ? `[视频x${videos.length}]` : '[视频]');
                }
            }

            // 语音（可选显示路径）
            const records = msg.records ?? [];
            if (records.length > 0) {
                if (showMediaPaths && records.length === 1) {
                    const r = records[0];
                    let rPath = '';
                    if (typeof r === 'string') rPath = r;
                    else if (r) {
                        const rObj = r as { path?: string; file?: string; url?: string };
                        rPath = rObj.path || rObj.file || rObj.url || '';
                    }
                    parts.push(rPath ? `[语音:${rPath}]` : '[语音]');
                } else {
                    parts.push(records.length > 1 ? `[语音x${records.length}]` : '[语音]');
                }
            }

            // 文件（可选显示路径）
            const files = msg.files ?? [];
            if (files.length > 0) {
                if (showMediaPaths && files.length === 1) {
                    const f = files[0];
                    let fPath = '';
                    if (typeof f === 'string') fPath = f;
                    else if (f) {
                        const fObj = f as { path?: string; name?: string; url?: string };
                        fPath = fObj.path || fObj.name || fObj.url || '';
                    }
                    parts.push(fPath ? `[文件:${fPath}]` : '[文件]');
                } else {
                    parts.push(files.length > 1 ? `[文件x${files.length}]` : '[文件]');
                }
            }

            // 卡片
            const cards = msg.cards ?? [];
            if (cards.length > 0) {
                const card = cards[0];
                parts.push(card.title ? `[卡片:${card.title.slice(0, 10)}]` : '[卡片]');
            }

            // 回复（附带发送者信息、时间戳和媒体文件）
            if (msg.reply) {
                const replySender = msg.reply.sender_name || msg.reply.sender_id || '未知';
                const replyId = msg.reply.sender_id || '';
                const replyText = msg.reply.text?.slice(0, 20) || '';
                // 引用时间戳（含日期）
                const replyTime = msg.reply.time
                    ? new Date(msg.reply.time * 1000).toLocaleString('zh-CN', {
                        month: 'numeric', day: 'numeric',
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
                    })
                    : '';
                const timePrefix = replyTime ? `[${replyTime}]` : '';

                // 引用消息的媒体文件（可选显示路径）
                const replyMedia: string[] = [];
                if (msg.reply.media) {
                    const m = msg.reply.media;
                    if (m.images?.length) {
                        if (showMediaPaths && m.images.length === 1) {
                            const imgPath = m.images[0].path || m.images[0].file || m.images[0].url || '';
                            replyMedia.push(imgPath ? `[图:${imgPath}]` : '[图]');
                        } else {
                            replyMedia.push(m.images.length > 1 ? `[图x${m.images.length}]` : '[图]');
                        }
                    }
                    if (m.videos?.length) {
                        if (showMediaPaths && m.videos.length === 1) {
                            const videoPath = m.videos[0].path || m.videos[0].file || m.videos[0].url || '';
                            replyMedia.push(videoPath ? `[视频:${videoPath}]` : '[视频]');
                        } else {
                            replyMedia.push(m.videos.length > 1 ? `[视频x${m.videos.length}]` : '[视频]');
                        }
                    }
                    if (m.records?.length) {
                        if (showMediaPaths && m.records.length === 1) {
                            const recordPath = m.records[0].path || m.records[0].file || m.records[0].url || '';
                            replyMedia.push(recordPath ? `[语音:${recordPath}]` : '[语音]');
                        } else {
                            replyMedia.push(m.records.length > 1 ? `[语音x${m.records.length}]` : '[语音]');
                        }
                    }
                    if (m.files?.length) {
                        if (showMediaPaths && m.files.length === 1) {
                            const filePath = m.files[0].path || m.files[0].name || m.files[0].url || '';
                            replyMedia.push(filePath ? `[文件:${filePath}]` : '[文件]');
                        } else {
                            replyMedia.push(m.files.length > 1 ? `[文件x${m.files.length}]` : '[文件]');
                        }
                    }
                }
                const mediaStr = replyMedia.length > 0 ? ` ${replyMedia.join(' ')}` : '';
                const textPart = replyText ? `"${replyText}"` : '';
                parts.unshift(`↩️${timePrefix}[${replySender}(${replyId}): ${textPart}${mediaStr}]`);
            }

            // 工具调用记录（机器人的工具执行历史）
            if (msg.toolCall && isBot) {
                // 优先使用多工具记录
                if (msg.toolCall.tools && msg.toolCall.tools.length > 0) {
                    const toolStrs = msg.toolCall.tools.map(t => {
                        const paramStr = Object.entries(t.params)
                            .filter(([k, v]) => v !== undefined && !isInternalSelfReferenceDrawKey(k))
                            .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v).slice(0, 200)}`)
                            .join(', ');
                        return `${t.name}(${paramStr})`;
                    });
                    parts.push(`[工具:${toolStrs.join(', ')}]`);
                } else {
                    // 单工具回退（兼容旧数据）
                    const { tool, params } = msg.toolCall;
                    const paramStr = Object.entries(params)
                        .filter(([k, v]) => v !== undefined && !isInternalSelfReferenceDrawKey(k))
                        .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 500) : JSON.stringify(v).slice(0, 500)}`)
                        .join(', ');
                    parts.push(`[工具:${tool}(${paramStr})]`);
                }
            }

            const content = parts.join(' ') || '[空消息]';
            const index = showIndex ? `${i + 1}. ` : '- ';
            return `${index}[${time}] ${rolePrefix}${sender}(${msg.sender_id}): ${content}`;
        }).join('\n');
    }

    // ===== 持久化 =====

    /** 保存单条消息到 SQLite */
    private saveMessageToDb(sessionKey: string, msg: FormattedMessage): void {
        try {
            const db = getGenesisDb();
            db.run(
                'INSERT INTO context_messages (session_key, message_json, message_time) VALUES (?, ?, ?)',
                [sessionKey, JSON.stringify(msg), msg.time * 1000 || Date.now()],
            );

            // 清理超出窗口大小的旧消息
            db.run(
                `DELETE FROM context_messages WHERE session_key = ? AND id NOT IN (
                    SELECT id FROM context_messages WHERE session_key = ? ORDER BY message_time DESC LIMIT ?
                )`,
                [sessionKey, sessionKey, this.maxSize],
            );

            markDirty();
        } catch (err) {
            log.warn('💾 上下文消息写入 SQLite 失败:', err);
        }
    }

    /** 删除指定会话的 SQLite 数据 */
    private clearSessionFromDb(sessionKey: string): void {
        try {
            const db = getGenesisDb();
            db.run('DELETE FROM context_messages WHERE session_key = ?', [sessionKey]);
            markDirty();
        } catch (err) {
            log.warn('💾 清除会话 SQLite 数据失败:', err);
        }
    }

    /** 清空所有 SQLite 上下文数据 */
    private clearAllFromDb(): void {
        try {
            const db = getGenesisDb();
            db.run('DELETE FROM context_messages');
            markDirty();
        } catch (err) {
            log.warn('💾 清空上下文 SQLite 数据失败:', err);
        }
    }

    /** 从 SQLite 恢复所有会话 */
    loadFromDb(): void {
        try {
            const db = getGenesisDb();
            // 获取所有活跃 session
            const sessionStmt = db.prepare(
                'SELECT DISTINCT session_key FROM context_messages',
            );

            const sessionKeys: string[] = [];
            while (sessionStmt.step()) {
                const row = sessionStmt.getAsObject() as { session_key: string };
                sessionKeys.push(row.session_key);
            }
            sessionStmt.free();

            let totalMessages = 0;

            // 为每个 session 恢复最近 N 条消息
            for (const key of sessionKeys) {
                const messages = readRecentContextMessages(db, key, this.maxSize);

                if (messages.length > 0) {
                    this.windows.set(key, messages);
                    totalMessages += messages.length;
                }
            }

            log.info(`💾 恢复 ${sessionKeys.length} 个会话, ${totalMessages} 条上下文消息`);
        } catch (err) {
            log.warn('💾 恢复上下文消息失败:', err);
        }
    }
}

// 全局单例
export const memory = new MemoryWindow();

export async function listContextSessionsFromDisk(): Promise<ContextSessionSummary[]> {
    return readGenesisDbSnapshot((db) => {
        const stmt = db.prepare(`
            SELECT session_key, COUNT(*) AS message_count, MAX(message_time) AS last_activity
            FROM context_messages
            GROUP BY session_key
            ORDER BY last_activity DESC
        `);

        const sessions: ContextSessionSummary[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as Record<string, unknown>;
            sessions.push({
                key: String(row.session_key || ''),
                count: Number(row.message_count) || 0,
                lastActivity: Number(row.last_activity) || 0,
            });
        }
        stmt.free();
        return sessions;
    });
}

export async function getContextSessionFromDisk(
    key: string,
    limit: number = config.memoryWindowSize,
): Promise<FormattedMessage[] | undefined> {
    return readGenesisDbSnapshot((db) => {
        const messages = readRecentContextMessages(db, key, limit);
        return messages.length > 0 ? messages : undefined;
    });
}

export async function clearContextSessionFromDisk(key: string): Promise<void> {
    await mutateGenesisDbSnapshot((db) => {
        db.run('DELETE FROM context_messages WHERE session_key = ?', [key]);
        db.run('DELETE FROM media_references WHERE session_key = ?', [key]);
    });
}

export async function clearAllContextFromDisk(): Promise<void> {
    await mutateGenesisDbSnapshot((db) => {
        db.run('DELETE FROM context_messages');
        db.run('DELETE FROM media_references');
    });
}

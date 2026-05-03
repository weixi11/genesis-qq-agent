/**
 * MediaTracker 服务 - 媒体引用追踪
 * 
 * 职责：
 * - 从消息中提取媒体信息（图片、视频、语音、文件）
 * - 维护会话级媒体索引
 * - 提供多种查询方式（按用户、按类型、按时间等）
 * - 生成 Router Prompt 所需的媒体上下文
 */

import type { FormattedMessage } from '../types.js';
import { log } from '../logger.js';
import { getGenesisDb, markDirty } from '../storage/genesis-db.js';

// ==================== 类型定义 ====================

/** 媒体类型 */
export type MediaType = 'image' | 'video' | 'audio' | 'file';

/** 媒体引用 */
export interface MediaReference {
    /** 媒体唯一ID（消息ID + 类型 + 索引） */
    id: string;
    /** 发送者ID */
    senderId: number;
    /** 发送者名称 */
    senderName: string;
    /** 媒体类型 */
    type: MediaType;
    /** 文件路径或URL */
    path: string;
    /** 消息发送时间戳（秒） */
    timestamp: number;
    /** 该用户该类型的第几个（1-indexed） */
    userIndex: number;
    /** 全局顺序索引（1-indexed） */
    globalIndex: number;
    /** 文件名（如果有） */
    filename?: string;
    /** 消息ID */
    messageId: number;
}

/** 媒体查询条件 */
export interface MediaQuery {
    /** 按发送者名称模糊匹配 */
    senderName?: string;
    /** 按发送者ID精确匹配 */
    senderId?: number;
    /** 按类型筛选 */
    type?: MediaType;
    /** 该用户的第N个（1-indexed） */
    userIndex?: number;
    /** 全局第N个（1-indexed） */
    globalIndex?: number;
    /** 最近N条 */
    limit?: number;
}

export interface GeneratedMediaInput {
    senderId: number;
    senderName: string;
    type: MediaType;
    path: string;
    filename?: string;
    timestamp?: number;
    messageId?: number;
}

// ==================== 辅助函数 ====================

/**
 * 从媒体项中提取路径
 */
function extractPath(item: string | { path?: string; file?: string; url?: string }): string | undefined {
    if (typeof item === 'string') {
        return item || undefined;
    }
    if (item) {
        return item.path || item.file || item.url || undefined;
    }
    return undefined;
}

/**
 * 从文件项中提取路径和文件名
 */
function extractFileInfo(item: { path?: string; file?: string; url?: string; name?: string }): { path?: string; filename?: string } {
    const path = item.path || item.file || item.url;
    const filename = item.name;
    return { path: path || undefined, filename };
}

/**
 * 格式化相对时间
 */
function formatRelativeTime(timestamp: number): string {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;

    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    return `${Math.floor(diff / 86400)}天前`;
}

/**
 * 媒体类型中文名
 */
function getTypeLabel(type: MediaType): string {
    const labels: Record<MediaType, string> = {
        image: '图片',
        video: '视频',
        audio: '语音',
        file: '文件',
    };
    return labels[type];
}

// ==================== MediaTracker 类 ====================

export class MediaTracker {
    /** 会话媒体记录 Map<sessionKey, MediaReference[]> */
    private sessions = new Map<string, MediaReference[]>();

    /** 用户类型计数器 Map<sessionKey, Map<"userId:type", count>> */
    private userTypeCounters = new Map<string, Map<string, number>>();

    /** 全局计数器 Map<sessionKey, count> */
    private globalCounters = new Map<string, number>();

    /** 已追踪的消息ID Set<sessionKey:messageId> */
    private trackedMessages = new Set<string>();

    // ==================== 核心方法 ====================

    /**
     * 从消息中提取并记录媒体
     */
    trackMessage(sessionKey: string, msg: FormattedMessage): void {
        const trackKey = `${sessionKey}:${msg.message_id}`;

        // 避免重复追踪
        if (this.trackedMessages.has(trackKey)) {
            return;
        }
        this.trackedMessages.add(trackKey);

        // 确保会话数据结构存在
        if (!this.sessions.has(sessionKey)) {
            this.sessions.set(sessionKey, []);
            this.userTypeCounters.set(sessionKey, new Map());
            this.globalCounters.set(sessionKey, 0);
        }

        const mediaList = this.sessions.get(sessionKey)!;
        const counters = this.userTypeCounters.get(sessionKey)!;

        // 提取当前消息的媒体
        this.extractMedia(msg, sessionKey, mediaList, counters);

        // 提取引用消息的媒体（如果有且未追踪）
        if (msg.reply?.media) {
            this.extractReplyMedia(msg.reply, sessionKey, mediaList, counters);
        }
    }

    /**
     * 从消息中提取媒体
     */
    private extractMedia(
        msg: FormattedMessage,
        sessionKey: string,
        mediaList: MediaReference[],
        counters: Map<string, number>
    ): void {
        const senderId = msg.sender_id;
        const senderName = msg.sender_name || String(senderId);
        const timestamp = msg.time;
        const messageId = msg.message_id;

        // 提取图片
        if (msg.images && msg.images.length > 0) {
            for (const img of msg.images) {
                const path = extractPath(img);
                if (path) {
                    this.addMedia(sessionKey, mediaList, counters, {
                        senderId,
                        senderName,
                        type: 'image',
                        path,
                        timestamp,
                        messageId,
                    });
                }
            }
        }

        // 提取视频
        if (msg.videos && msg.videos.length > 0) {
            for (const video of msg.videos) {
                const path = extractPath(video);
                if (path) {
                    this.addMedia(sessionKey, mediaList, counters, {
                        senderId,
                        senderName,
                        type: 'video',
                        path,
                        timestamp,
                        messageId,
                    });
                }
            }
        }

        // 提取语音
        if (msg.records && msg.records.length > 0) {
            for (const record of msg.records) {
                const path = extractPath(record);
                if (path) {
                    this.addMedia(sessionKey, mediaList, counters, {
                        senderId,
                        senderName,
                        type: 'audio',
                        path,
                        timestamp,
                        messageId,
                    });
                }
            }
        }

        // 提取文件
        if (msg.files && msg.files.length > 0) {
            for (const file of msg.files) {
                const { path, filename } = extractFileInfo(file);
                if (path) {
                    this.addMedia(sessionKey, mediaList, counters, {
                        senderId,
                        senderName,
                        type: 'file',
                        path,
                        timestamp,
                        messageId,
                        filename,
                    });
                }
            }
        }
    }

    /**
     * 从引用消息中提取媒体
     */
    private extractReplyMedia(
        reply: NonNullable<FormattedMessage['reply']>,
        sessionKey: string,
        mediaList: MediaReference[],
        counters: Map<string, number>
    ): void {
        const senderId = reply.sender_id;
        const senderName = reply.sender_name || String(senderId);
        const timestamp = reply.time || 0;
        const messageId = reply.message_id;

        // 检查是否已追踪
        const trackKey = `${sessionKey}:reply:${messageId}`;
        if (this.trackedMessages.has(trackKey)) {
            return;
        }
        this.trackedMessages.add(trackKey);

        const media = reply.media;
        if (!media) return;

        // 提取引用消息中的图片
        if (media.images && media.images.length > 0) {
            for (const img of media.images) {
                const path = img.path || img.file || img.url;
                if (path) {
                    this.addMedia(sessionKey, mediaList, counters, {
                        senderId,
                        senderName,
                        type: 'image',
                        path,
                        timestamp,
                        messageId,
                    });
                }
            }
        }

        // 提取引用消息中的视频
        if (media.videos && media.videos.length > 0) {
            for (const video of media.videos) {
                const path = video.path || video.file || video.url;
                if (path) {
                    this.addMedia(sessionKey, mediaList, counters, {
                        senderId,
                        senderName,
                        type: 'video',
                        path,
                        timestamp,
                        messageId,
                    });
                }
            }
        }

        // 提取引用消息中的语音
        if (media.records && media.records.length > 0) {
            for (const record of media.records) {
                const path = record.path || record.file || record.url;
                if (path) {
                    this.addMedia(sessionKey, mediaList, counters, {
                        senderId,
                        senderName,
                        type: 'audio',
                        path,
                        timestamp,
                        messageId,
                    });
                }
            }
        }

        // 提取引用消息中的文件
        if (media.files && media.files.length > 0) {
            for (const file of media.files) {
                const path = file.path || file.url;
                const filename = file.name;
                if (path) {
                    this.addMedia(sessionKey, mediaList, counters, {
                        senderId,
                        senderName,
                        type: 'file',
                        path,
                        timestamp,
                        messageId,
                        filename,
                    });
                }
            }
        }
    }

    /**
     * 添加媒体到列表
     */
    private addMedia(
        sessionKey: string,
        mediaList: MediaReference[],
        counters: Map<string, number>,
        data: {
            senderId: number;
            senderName: string;
            type: MediaType;
            path: string;
            timestamp: number;
            messageId: number;
            filename?: string;
        }
    ): void {
        // 检查是否已存在相同路径的媒体（避免重复）
        if (mediaList.some(m => m.path === data.path)) {
            return;
        }

        // 更新用户类型计数
        const counterKey = `${data.senderId}:${data.type}`;
        const userIndex = (counters.get(counterKey) || 0) + 1;
        counters.set(counterKey, userIndex);

        // 更新全局计数
        const globalIndex = (this.globalCounters.get(sessionKey) || 0) + 1;
        this.globalCounters.set(sessionKey, globalIndex);

        // 创建媒体引用
        const ref: MediaReference = {
            id: `${data.messageId}:${data.type}:${userIndex}`,
            senderId: data.senderId,
            senderName: data.senderName,
            type: data.type,
            path: data.path,
            timestamp: data.timestamp,
            userIndex,
            globalIndex,
            messageId: data.messageId,
            filename: data.filename,
        };

        mediaList.push(ref);

        // 持久化到 SQLite
        this.saveRefToDb(sessionKey, ref);
    }

    // ==================== 查询方法 ====================

    /**
     * 获取会话的媒体上下文
     */
    getMediaContext(sessionKey: string, limit?: number): MediaReference[] {
        const mediaList = this.sessions.get(sessionKey) || [];
        if (limit && limit > 0) {
            return mediaList.slice(-limit);
        }
        return [...mediaList];
    }

    /**
     * 格式化媒体上下文为 Prompt 文本
     */
    formatForPrompt(sessionKey: string, limit: number = 20): string {
        const mediaList = this.getMediaContext(sessionKey, limit);

        if (mediaList.length === 0) {
            return '';
        }

        const lines = mediaList.map(ref => {
            const typeLabel = getTypeLabel(ref.type);
            const relTime = formatRelativeTime(ref.timestamp);
            const filename = ref.filename ? ` (${ref.filename})` : '';

            return `- [${ref.globalIndex}] ${ref.senderName}(${ref.senderId}) 的第${ref.userIndex}个[${typeLabel}]: ${ref.path}${filename} (${relTime})`;
        });

        return lines.join('\n');
    }

    /**
     * 按条件查询媒体
     */
    query(sessionKey: string, query: MediaQuery): MediaReference[] {
        let results = this.sessions.get(sessionKey) || [];

        // 按发送者ID筛选
        if (query.senderId !== undefined) {
            results = results.filter(r => r.senderId === query.senderId);
        }

        // 按发送者名称模糊匹配
        if (query.senderName !== undefined) {
            const name = query.senderName.toLowerCase();
            results = results.filter(r => r.senderName.toLowerCase().includes(name));
        }

        // 按类型筛选
        if (query.type !== undefined) {
            results = results.filter(r => r.type === query.type);
        }

        // 按用户索引筛选
        if (query.userIndex !== undefined) {
            results = results.filter(r => r.userIndex === query.userIndex);
        }

        // 按全局索引筛选
        if (query.globalIndex !== undefined) {
            results = results.filter(r => r.globalIndex === query.globalIndex);
        }

        // 限制数量（取最新的）
        if (query.limit && query.limit > 0) {
            results = results.slice(-query.limit);
        }

        return results;
    }

    /**
     * 查找最近的某类型媒体
     */
    findLatest(sessionKey: string, type?: MediaType): MediaReference | undefined {
        const mediaList = this.sessions.get(sessionKey) || [];
        if (type) {
            for (let i = mediaList.length - 1; i >= 0; i--) {
                if (mediaList[i].type === type) {
                    return mediaList[i];
                }
            }
            return undefined;
        }
        return mediaList[mediaList.length - 1];
    }

    // ==================== 管理方法 ====================

    /**
     * 清除会话媒体记录
     */
    clear(sessionKey: string): void {
        this.sessions.delete(sessionKey);
        this.userTypeCounters.delete(sessionKey);
        this.globalCounters.delete(sessionKey);

        // 清除该会话的追踪记录
        const keysToDelete: string[] = [];
        for (const key of this.trackedMessages) {
            if (key.startsWith(sessionKey + ':')) {
                keysToDelete.push(key);
            }
        }
        for (const key of keysToDelete) {
            this.trackedMessages.delete(key);
        }

        // 从 SQLite 删除
        this.clearSessionFromDb(sessionKey);
    }

    clearAll(): void {
        this.sessions.clear();
        this.userTypeCounters.clear();
        this.globalCounters.clear();
        this.trackedMessages.clear();
        this.clearAllFromDb();
    }

    /**
     * 获取会话媒体统计
     */
    getStats(sessionKey: string): { total: number; byType: Record<MediaType, number> } {
        const mediaList = this.sessions.get(sessionKey) || [];
        const byType: Record<MediaType, number> = { image: 0, video: 0, audio: 0, file: 0 };

        for (const ref of mediaList) {
            byType[ref.type]++;
        }

        return { total: mediaList.length, byType };
    }

    /**
     * 检查会话是否有媒体
     */
    hasMedia(sessionKey: string, type?: MediaType): boolean {
        const mediaList = this.sessions.get(sessionKey) || [];
        if (!type) return mediaList.length > 0;
        return mediaList.some(r => r.type === type);
    }

    // ==================== 持久化 ====================

    /** 保存媒体引用到 SQLite */
    private saveRefToDb(sessionKey: string, ref: MediaReference): void {
        try {
            const db = getGenesisDb();
            db.run(
                `INSERT OR REPLACE INTO media_references (id, session_key, sender_id, sender_name, type, path, timestamp, user_index, global_index, filename, message_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    ref.id,
                    sessionKey,
                    ref.senderId,
                    ref.senderName,
                    ref.type,
                    ref.path,
                    ref.timestamp,
                    ref.userIndex,
                    ref.globalIndex,
                    ref.filename || null,
                    ref.messageId,
                ],
            );
            markDirty();
        } catch (err) {
            log.warn('💾 媒体引用写入 SQLite 失败:', err);
        }
    }

    /** 删除指定会话的 SQLite 媒体数据 */
    private clearSessionFromDb(sessionKey: string): void {
        try {
            const db = getGenesisDb();
            db.run('DELETE FROM media_references WHERE session_key = ?', [sessionKey]);
            markDirty();
        } catch (err) {
            log.warn('💾 清除媒体 SQLite 数据失败:', err);
        }
    }

    /**
     * 记录机器人自己生成并已发送的媒体。
     * 这类媒体不会经过 NapCat 入站消息事件，但后续“把刚才画的图再发一下”需要按会话找回。
     */
    trackGeneratedMedia(sessionKey: string, items: GeneratedMediaInput[]): void {
        if (items.length === 0) {
            return;
        }

        if (!this.sessions.has(sessionKey)) {
            this.sessions.set(sessionKey, []);
            this.userTypeCounters.set(sessionKey, new Map());
            this.globalCounters.set(sessionKey, 0);
        }

        const mediaList = this.sessions.get(sessionKey)!;
        const counters = this.userTypeCounters.get(sessionKey)!;
        const now = Math.floor(Date.now() / 1000);
        const fallbackMessageId = -Math.floor(Date.now() % 1_000_000_000);

        items.forEach((item, index) => {
            this.addMedia(sessionKey, mediaList, counters, {
                senderId: item.senderId,
                senderName: item.senderName,
                type: item.type,
                path: item.path,
                timestamp: item.timestamp || now,
                messageId: item.messageId || fallbackMessageId - index,
                filename: item.filename,
            });
        });
    }

    private clearAllFromDb(): void {
        try {
            const db = getGenesisDb();
            db.run('DELETE FROM media_references');
            markDirty();
        } catch (err) {
            log.warn('💾 清空媒体 SQLite 数据失败:', err);
        }
    }

    /** 从 SQLite 恢复所有会话媒体 */
    loadFromDb(): void {
        try {
            const db = getGenesisDb();
            const stmt = db.prepare(
                'SELECT * FROM media_references ORDER BY timestamp ASC',
            );

            let totalRefs = 0;
            const sessionSet = new Set<string>();

            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, unknown>;
                const sessionKey = row.session_key as string;
                sessionSet.add(sessionKey);

                // 确保会话数据结构存在
                if (!this.sessions.has(sessionKey)) {
                    this.sessions.set(sessionKey, []);
                    this.userTypeCounters.set(sessionKey, new Map());
                    this.globalCounters.set(sessionKey, 0);
                }

                const ref: MediaReference = {
                    id: row.id as string,
                    senderId: row.sender_id as number,
                    senderName: row.sender_name as string,
                    type: row.type as MediaType,
                    path: row.path as string,
                    timestamp: row.timestamp as number,
                    userIndex: row.user_index as number,
                    globalIndex: row.global_index as number,
                    filename: (row.filename as string) || undefined,
                    messageId: row.message_id as number,
                };

                this.sessions.get(sessionKey)!.push(ref);

                // 恢复计数器
                const counterKey = `${ref.senderId}:${ref.type}`;
                const counters = this.userTypeCounters.get(sessionKey)!;
                const currentCount = counters.get(counterKey) || 0;
                if (ref.userIndex > currentCount) {
                    counters.set(counterKey, ref.userIndex);
                }

                const currentGlobal = this.globalCounters.get(sessionKey) || 0;
                if (ref.globalIndex > currentGlobal) {
                    this.globalCounters.set(sessionKey, ref.globalIndex);
                }

                // 标记已追踪
                this.trackedMessages.add(`${sessionKey}:${ref.messageId}`);

                totalRefs++;
            }
            stmt.free();

            log.info(`💾 恢复 ${sessionSet.size} 个会话的 ${totalRefs} 条媒体引用`);
        } catch (err) {
            log.warn('💾 恢复媒体引用失败:', err);
        }
    }
}

// 全局单例
export const mediaTracker = new MediaTracker();

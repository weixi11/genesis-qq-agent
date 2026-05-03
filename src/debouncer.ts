/**
 * 消息防抖器 (Debouncer)
 * 解决消息碎片化问题：a:今天... a:天气... -> 合并为完整消息
 * 
 * 策略：
 * - 收到消息后放入缓冲区
 * - 等待 debounceDelay 毫秒
 * - 如果同一用户在同一会话中继续发消息，重置计时器并合并
 * - 超时后触发处理回调
 */

import { config } from './config.js';
import { log } from './logger.js';
import type { FormattedMessage } from './types.js';

export interface DebouncedMessage {
    /** 合并后的消息列表 */
    messages: FormattedMessage[];
    /** 合并后的纯文本 */
    mergedText: string;
    /** 合并后的图片列表 */
    mergedImages: string[];
    /** 首条消息 */
    first: FormattedMessage;
    /** 最后一条消息 */
    last: FormattedMessage;
    /** 防抖模式 */
    mode: 'single' | 'group_mention_batch';
    /** 多人@批处理参与者信息 */
    participants?: DebouncedParticipant[];
    /** 本轮窗口耗时 */
    windowMs: number;
}

export interface DebouncedParticipant {
    senderId: number;
    senderName: string;
    messageCount: number;
    mergedText: string;
}

type DebouncedHandler = (debounced: DebouncedMessage) => void;

interface BufferEntry {
    messages: FormattedMessage[];
    timer: NodeJS.Timeout | null;
    createdAt: number;
    deadlineAt: number;
}

export class MessageDebouncer {
    // key: "group:{group_id}:{sender_id}" 或 "private:{sender_id}"
    private buffers = new Map<string, BufferEntry>();
    private handlers: DebouncedHandler[] = [];
    private debounceDelay: number;

    constructor(debounceDelayMs: number = config.debounceDelayMs) {
        this.debounceDelay = debounceDelayMs;
    }

    private getMentionBatchTargetWindow(messages: FormattedMessage[]): number {
        const uniqueSenders = new Set(messages.map(message => message.sender_id)).size;
        const followUps = Math.max(0, messages.length - uniqueSenders);
        const lowLatencyMode = this.debounceDelay < 300;
        const initialWindow = lowLatencyMode
            ? this.debounceDelay
            : Math.min(Math.max(this.debounceDelay, 300), 800);
        let targetWindow = initialWindow;

        if (uniqueSenders >= 2) {
            targetWindow = Math.max(targetWindow, lowLatencyMode ? Math.max(this.debounceDelay * 2, this.debounceDelay + 20) : 1300);
        }
        if (uniqueSenders >= 3) {
            targetWindow = Math.max(targetWindow, lowLatencyMode ? Math.max(this.debounceDelay * 3, this.debounceDelay + 40) : 1600);
        }
        if (uniqueSenders >= 4) {
            targetWindow = Math.max(targetWindow, lowLatencyMode ? Math.max(this.debounceDelay * 4, this.debounceDelay + 60) : 1900);
        }
        if (followUps > 0) {
            targetWindow += lowLatencyMode
                ? Math.min(this.debounceDelay, followUps * 10)
                : Math.min(400, followUps * 200);
        }

        return Math.min(targetWindow, lowLatencyMode ? Math.max(this.debounceDelay * 4, this.debounceDelay + 80) : Math.max(this.debounceDelay, 2200));
    }

    /** 生成缓冲 key（同一用户在同一会话） */
    private getKey(msg: FormattedMessage): string {
        if (msg.type === 'group' && msg.group_id) {
            const mentionBatchKey = this.getMentionBatchKey(msg.group_id);
            const mentionBatch = this.buffers.get(mentionBatchKey);
            if (mentionBatch && this.shouldJoinMentionBatch(msg, mentionBatch.messages)) {
                return mentionBatchKey;
            }

            if (this.isGroupMentionForBot(msg)) {
                return mentionBatchKey;
            }

            return `group:${msg.group_id}:${msg.sender_id}`;
        } else {
            return `private:${msg.sender_id}`;
        }
    }

    private getMentionBatchKey(groupId: number): string {
        return `group:${groupId}:mention_batch`;
    }

    private isGroupMentionForBot(msg: FormattedMessage): boolean {
        if (msg.type !== 'group' || !msg.group_id) return false;
        const botId = msg.self_id || config.botQQ;
        return Boolean(botId && msg.at_users?.includes(botId));
    }

    private shouldJoinMentionBatch(msg: FormattedMessage, existingMessages: FormattedMessage[]): boolean {
        if (msg.type !== 'group' || !msg.group_id) {
            return false;
        }

        if (this.isGroupMentionForBot(msg)) {
            return true;
        }

        return existingMessages.some(existing => existing.sender_id === msg.sender_id);
    }

    private buildMessageSnippet(msg: FormattedMessage): string {
        const parts: string[] = [];
        const text = msg.text?.trim();
        if (text) parts.push(text);
        if (msg.images?.length) parts.push(msg.images.length > 1 ? `[图片x${msg.images.length}]` : '[图片]');
        if (msg.videos?.length) parts.push('[视频]');
        if (msg.records?.length) parts.push('[语音]');
        if (msg.files?.length) parts.push('[文件]');
        return parts.join(' ').trim() || '（发送了@或媒体消息）';
    }

    private buildParticipants(messages: FormattedMessage[]): DebouncedParticipant[] {
        const participants = new Map<number, DebouncedParticipant>();
        const orderedIds: number[] = [];

        for (const msg of messages) {
            const snippet = this.buildMessageSnippet(msg);
            const existing = participants.get(msg.sender_id);
            if (existing) {
                existing.messageCount += 1;
                existing.mergedText = existing.mergedText
                    ? `${existing.mergedText}\n${snippet}`
                    : snippet;
                continue;
            }

            orderedIds.push(msg.sender_id);
            participants.set(msg.sender_id, {
                senderId: msg.sender_id,
                senderName: msg.sender_name || String(msg.sender_id),
                messageCount: 1,
                mergedText: snippet,
            });
        }

        return orderedIds
            .map(id => participants.get(id))
            .filter((participant): participant is DebouncedParticipant => participant !== undefined);
    }

    private buildMentionBatchPrompt(participants: DebouncedParticipant[]): string {
        const lines = participants.map((participant, index) => {
            const countLabel = participant.messageCount > 1 ? `，连续发了 ${participant.messageCount} 条` : '';
            return `${index + 1}. ${participant.senderName}(${participant.senderId}${countLabel})：${participant.mergedText}`;
        });

        return [
            `【群聊多人同时@你】`,
            `当前同一时间窗口里有 ${participants.length} 位群成员同时在找你。请你只回复一条群消息，尽量自然覆盖每个人，可以直接点名回应。`,
            `如果问题很多，先简洁回应每个人的核心诉求，不要拆成多条发送。`,
            '',
            `本轮汇总：`,
            ...lines,
        ].join('\n');
    }

    private scheduleFlush(key: string, entry: BufferEntry): void {
        if (entry.timer) {
            clearTimeout(entry.timer);
        }

        const now = Date.now();
        let delay = this.debounceDelay;

        if (key.endsWith(':mention_batch')) {
            const targetWindow = this.getMentionBatchTargetWindow(entry.messages);
            entry.deadlineAt = entry.createdAt + targetWindow;
            delay = Math.max(0, entry.deadlineAt - now);
        } else {
            entry.createdAt = now;
            entry.deadlineAt = now + this.debounceDelay;
        }

        entry.timer = setTimeout(() => {
            this.flush(key);
        }, delay);
    }

    /** 收到消息时调用 */
    push(msg: FormattedMessage): void {
        const key = this.getKey(msg);
        const existing = this.buffers.get(key);
        const now = Date.now();

        if (existing) {
            existing.messages.push(msg);
            log.debug(`防抖: 合并消息 [${key}] 当前 ${existing.messages.length} 条`);
        } else {
            // 新建缓冲区
            this.buffers.set(key, {
                messages: [msg],
                timer: null,
                createdAt: now,
                deadlineAt: now + this.debounceDelay,
            });
        }

        const entry = this.buffers.get(key)!;
        this.scheduleFlush(key, entry);
    }

    /** 触发处理（超时或手动） */
    private flush(key: string): void {
        const entry = this.buffers.get(key);
        if (!entry || entry.messages.length === 0) return;

        this.buffers.delete(key);

        // 合并消息
        const messages = entry.messages;
        const participants = key.endsWith(':mention_batch')
            ? this.buildParticipants(messages)
            : undefined;
        const mode: DebouncedMessage['mode'] = (participants && participants.length > 1)
            ? 'group_mention_batch'
            : 'single';
        const mergedText = mode === 'group_mention_batch'
            ? this.buildMentionBatchPrompt(participants || [])
            : messages.map(m => m.text).join('');
        const mergedImages = messages.flatMap(m => m.images).map(img => {
            if (typeof img === 'string') return img;
            return img.path || img.file || img.url || '';
        }).filter(Boolean);

        const debounced: DebouncedMessage = {
            messages,
            mergedText,
            mergedImages,
            first: messages[0],
            last: messages[messages.length - 1],
            mode,
            participants: mode === 'group_mention_batch' ? participants : undefined,
            windowMs: Math.max(0, Date.now() - entry.createdAt),
        };

        log.debug(`防抖完成 [${key}]: ${messages.length} 条消息 -> "${mergedText.slice(0, 50)}..."`);

        // 通知所有处理器
        for (const handler of this.handlers) {
            try {
                handler(debounced);
            } catch (err) {
                log.error('Debouncer handler error:', err);
            }
        }
    }

    /** 注册防抖后的消息处理器 */
    onDebounced(handler: DebouncedHandler): () => void {
        this.handlers.push(handler);
        return () => {
            const idx = this.handlers.indexOf(handler);
            if (idx !== -1) this.handlers.splice(idx, 1);
        };
    }

    /** 立即处理所有缓冲区（用于优雅关闭） */
    flushAll(): void {
        for (const key of this.buffers.keys()) {
            const entry = this.buffers.get(key);
            if (entry && entry.timer) clearTimeout(entry.timer);
            this.flush(key);
        }
    }

    /** 获取当前缓冲区数量 */
    get pendingCount(): number {
        return this.buffers.size;
    }

    /** 运行时更新防抖延迟（仅影响后续新消息） */
    updateDelay(debounceDelayMs: number): void {
        this.debounceDelay = debounceDelayMs;
    }
}

// 全局单例
export const debouncer = new MessageDebouncer();

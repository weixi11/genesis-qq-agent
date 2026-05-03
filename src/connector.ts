/**
 * napcat WebSocket 连接器
 * 连接消息流服务，提供 RPC 调用能力
 */

import WebSocket from 'ws';
import path from 'path';
import { config } from './config.js';
import { log } from './logger.js';
import type { FormattedMessage, PokeNotice, BotMessageEvent, RpcResponse } from './types.js';
import { type MessageSegment, formatAtMentions } from './utils/message.js';
import type { FileAttachment } from './utils/file_attachment.js';
import { isRecord, safeParseJson } from './utils/json.js';

type MessageHandler = (msg: FormattedMessage) => void;
type PokeHandler = (poke: PokeNotice) => void;

const DEFAULT_API_TIMEOUT_MS = parseInt(process.env.NAPCAT_API_TIMEOUT_MS || '10000', 10);
const MEDIA_SEND_API_TIMEOUT_MS = parseInt(process.env.NAPCAT_MEDIA_SEND_TIMEOUT_MS || '30000', 10);
const FILE_SEND_API_TIMEOUT_MS = parseInt(process.env.NAPCAT_FILE_SEND_TIMEOUT_MS || '120000', 10);

/** 发送目标类型 */
export type SendTarget =
    | { type: 'group'; groupId: number }
    | { type: 'private'; userId: number }
    | FormattedMessage;


/** napcat SDK RPC 请求格式 */
interface SdkRpcRequest {
    type: 'sdk';
    requestId: string;
    path: string;  // 如 'send.group'
    args: unknown[];
}

function isMediaSegment(segment: unknown): boolean {
    if (!isRecord(segment) || typeof segment.type !== 'string') {
        return false;
    }
    return segment.type !== 'text' && segment.type !== 'reply';
}

export function resolveApiTimeoutMs(action: string, params: Record<string, unknown> = {}): number {
    if (action === 'upload_group_file' || action === 'upload_private_file') {
        return FILE_SEND_API_TIMEOUT_MS;
    }
    if (
        (action === 'send_group_msg' || action === 'send_private_msg')
        && Array.isArray(params.message)
        && params.message.some(isMediaSegment)
    ) {
        return MEDIA_SEND_API_TIMEOUT_MS;
    }
    return DEFAULT_API_TIMEOUT_MS;
}

function isPokeNotice(value: unknown): value is PokeNotice {
    return isRecord(value) && value.event_type === 'poke' && typeof value.target_id === 'number';
}

function isFormattedMessageLike(value: unknown): value is Record<string, unknown> {
    return isRecord(value)
        && (value.type === 'group' || value.type === 'private')
        && typeof value.message_id === 'number'
        && typeof value.sender_id === 'number';
}

function normalizeReply(value: unknown): FormattedMessage['reply'] | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const rawMedia = (isRecord(value.media) ? value.media : {}) as Record<string, unknown>;
    const images = Array.isArray(rawMedia['images']) ? rawMedia['images'] as Array<{ file?: string; url?: string; path?: string }> : [];
    const videos = Array.isArray(rawMedia['videos']) ? rawMedia['videos'] as Array<{ file?: string; url?: string; path?: string }> : [];
    const files = Array.isArray(rawMedia['files']) ? rawMedia['files'] as Array<{ name?: string; url?: string; path?: string }> : [];
    const records = Array.isArray(rawMedia['records']) ? rawMedia['records'] as Array<{ file?: string; url?: string; path?: string }> : [];
    return {
        message_id: typeof value.message_id === 'number'
            ? value.message_id
            : (typeof value.id === 'number' ? value.id : 0),
        sender_id: typeof value.sender_id === 'number' ? value.sender_id : 0,
        sender_name: typeof value.sender_name === 'string' ? value.sender_name : undefined,
        text: typeof value.text === 'string' ? value.text : undefined,
        time: typeof value.time === 'number' ? value.time : undefined,
        media: {
            images,
            videos,
            files,
            records,
        },
    };
}

function normalizeFormattedMessage(value: Record<string, unknown>): FormattedMessage {
    return {
        ...value,
        message_id: value.message_id as number,
        type: value.type as FormattedMessage['type'],
        time: typeof value.time === 'number' ? value.time : 0,
        time_str: typeof value.time_str === 'string' ? value.time_str : '',
        self_id: typeof value.self_id === 'number' ? value.self_id : undefined,
        summary: typeof value.summary === 'string' ? value.summary : '',
        objective: typeof value.objective === 'string' ? value.objective : undefined,
        sender_id: value.sender_id as number,
        sender_name: typeof value.sender_name === 'string' ? value.sender_name : String(value.sender_id),
        sender_card: typeof value.sender_card === 'string' ? value.sender_card : undefined,
        sender_role: value.sender_role === 'owner' || value.sender_role === 'admin' || value.sender_role === 'member'
            ? value.sender_role
            : undefined,
        group_id: typeof value.group_id === 'number' ? value.group_id : undefined,
        group_name: typeof value.group_name === 'string' ? value.group_name : undefined,
        text: typeof value.text === 'string' ? value.text : '',
        images: Array.isArray(value.images) ? value.images as FormattedMessage['images'] : [],
        videos: Array.isArray(value.videos) ? value.videos as FormattedMessage['videos'] : [],
        records: Array.isArray(value.records) ? value.records as FormattedMessage['records'] : [],
        at_users: Array.isArray(value.at_users)
            ? value.at_users.filter((item): item is number => typeof item === 'number')
            : [],
        at_all: typeof value.at_all === 'boolean' ? value.at_all : false,
        at_users_details: Array.isArray(value.at_users_details)
            ? value.at_users_details as FormattedMessage['at_users_details']
            : undefined,
        files: Array.isArray(value.files)
            ? value.files.map((item) => {
                const rawItem = isRecord(item) ? item as Record<string, unknown> : null;
                return rawItem
                    ? {
                        ...item,
                        file_size: rawItem['file_size'] ?? rawItem['size'],
                    }
                    : item;
            }) as FormattedMessage['files']
            : [],
        cards: Array.isArray(value.cards)
            ? value.cards.map((item) => {
                const rawItem = isRecord(item) ? item as Record<string, unknown> : null;
                return rawItem
                    ? {
                        ...item,
                        desc: rawItem['desc'] ?? rawItem['content'],
                        data: rawItem['data'] ?? rawItem['raw'],
                    }
                    : item;
            }) as FormattedMessage['cards']
            : [],
        reply: normalizeReply(value.reply),
        forwards: Array.isArray(value.forwards) ? value.forwards as FormattedMessage['forwards'] : undefined,
        faces: Array.isArray(value.faces) ? value.faces as FormattedMessage['faces'] : undefined,
        mface_urls: Array.isArray(value.mface_urls)
            ? value.mface_urls.filter((item): item is string => typeof item === 'string')
            : [],
        toolCall: isRecord(value.toolCall) ? value.toolCall as FormattedMessage['toolCall'] : undefined,
        raw: isRecord(value.raw) ? value.raw : undefined,
    };
}

function isRpcResultEvent(value: unknown): value is Extract<BotMessageEvent, { type: 'result' }> {
    return isRecord(value)
        && value.type === 'result'
        && typeof value.requestId === 'string'
        && typeof value.ok === 'boolean';
}

function isWelcomeEvent(value: unknown): value is Extract<BotMessageEvent, { type: 'welcome' }> {
    return isRecord(value) && value.type === 'welcome' && typeof value.message === 'string';
}

function isMessageEvent(value: unknown): value is Extract<BotMessageEvent, { type: 'message' }> {
    return isRecord(value)
        && value.type === 'message'
        && (isFormattedMessageLike(value.data) || isPokeNotice(value.data));
}

function parseBotMessageEvent(raw: string): BotMessageEvent | null {
    const parsed = safeParseJson(raw);
    if (isRpcResultEvent(parsed) || isWelcomeEvent(parsed)) {
        return parsed;
    }
    if (isMessageEvent(parsed)) {
        if (isPokeNotice(parsed.data)) {
            return parsed;
        }
        return {
            ...parsed,
            data: normalizeFormattedMessage(parsed.data as unknown as Record<string, unknown>),
        };
    }
    return null;
}



export class NapcatConnector {
    private ws: WebSocket | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private rpcPending = new Map<string, {
        resolve: (data: unknown) => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
    }>();
    private rpcIdCounter = 0;
    private messageHandlers: MessageHandler[] = [];
    private pokeHandlers: PokeHandler[] = [];
    private isConnected = false;

    constructor(private url: string = config.napcatWsUrl) { }

    /** 更新 napcat 地址，并在需要时触发重连 */
    async updateUrl(nextUrl: string, reconnect = true): Promise<void> {
        const normalized = nextUrl.trim();
        if (!normalized) {
            throw new Error('NapCat 地址不能为空');
        }

        const changed = normalized !== this.url;
        this.url = normalized;

        if (!changed) {
            return;
        }

        log.info(`NapCat 地址已更新: ${this.url}`);

        if (!reconnect) {
            return;
        }

        this.disconnect();

        try {
            await this.connect();
        } catch (error) {
            log.warn(`NapCat 重连失败，将继续按新地址自动重试: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** 连接 napcat 消息流 */
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            log.info(`正在连接 napcat 消息流: ${this.url}`);

            this.ws = new WebSocket(this.url);

            this.ws.on('open', () => {
                log.info('✅ 已连接 napcat 消息流');
                this.isConnected = true;
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
                resolve();
            });

            this.ws.on('message', (data: WebSocket.RawData) => {
                let message: string;
                if (Buffer.isBuffer(data)) {
                    message = data.toString('utf8');
                } else if (data instanceof ArrayBuffer) {
                    message = Buffer.from(data).toString('utf8');
                } else if (Array.isArray(data)) {
                    message = Buffer.concat(data).toString('utf8');
                } else {
                    message = '';
                }
                this.handleMessage(message);
            });

            this.ws.on('close', () => {
                log.warn('napcat 连接已断开');
                this.isConnected = false;
                this.scheduleReconnect();
            });

            this.ws.on('error', (err) => {
                log.error('napcat 连接错误:', err.message);
                if (!this.isConnected) {
                    reject(err);
                }
            });
        });
    }

    /** 处理收到的消息 */
    private handleMessage(raw: string): void {
        try {
            const msg = parseBotMessageEvent(raw);
            if (!msg) {
                throw new Error('消息结构不符合 BotMessageEvent');
            }

            // RPC 响应 (type: 'result')
            if (msg.type === 'result') {
                this.handleRpcResult(msg);
                return;
            }

            // 欢迎消息
            if (msg.type === 'welcome') {
                log.debug('收到欢迎消息:', msg.message);
                return;
            }

            // 消息推送 (type: 'message')
            if (msg.type === 'message') {
                const data = msg.data;
                // 判断是普通消息还是戳一戳 (Type Guard)
                if ('event_type' in data && data.event_type === 'poke') {
                    for (const handler of this.pokeHandlers) {
                        try {
                            handler(data);
                        } catch (err) {
                            log.error('Poke handler error:', err);
                        }
                    }
                } else {
                    const formatted = data as FormattedMessage;
                    if (formatted.type === 'group') {
                        log.debug(`收到群消息: role=${formatted.sender_role}, sender=${formatted.sender_name}`);
                    }
                    let displayText = formatted.text?.slice(0, 50) || '';

                    // 格式化 @提及
                    if (formatted.text && formatted.at_users_details?.length) {
                        formatted.text = formatAtMentions(formatted.text, formatted.at_users_details);
                        // 更新显示文本
                        displayText = formatted.text.slice(0, 50);
                    }

                    log.debug(`收到消息: [${formatted.type}] ${formatted.sender_name}: ${displayText}`);
                    for (const handler of this.messageHandlers) {
                        try {
                            handler(formatted);
                        } catch (err) {
                            log.error('Message handler error:', err);
                        }
                    }
                }
            }
        } catch (err) {
            log.error('解析消息失败:', err);
        }
    }

    /** 处理 RPC 响应 */
    private handleRpcResult(res: Extract<BotMessageEvent, { type: 'result' }>): void {
        const pending = this.rpcPending.get(res.requestId);
        if (pending) {
            clearTimeout(pending.timer);
            this.rpcPending.delete(res.requestId);
            if (res.ok) {
                log.debug(`RPC 成功: ${res.requestId}`);
                pending.resolve(res.data);
            } else {
                log.error(`RPC 失败: ${res.requestId} - ${res.error}`);
                pending.reject(new Error(res.error || 'RPC failed'));
            }
        } else {
            log.warn(`收到未知 RPC 响应: ${res.requestId}`);
        }
    }

    /** 自动重连 */
    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;

        log.info('5 秒后尝试重连...');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch(() => {
                // 重连失败，继续尝试
                this.scheduleReconnect();
            });
        }, 5000);
    }

    /** 发送 SDK RPC 请求 (调用 sdk 方法如 send.group) */
    async rpc<T = unknown>(path: string, args: unknown[] = []): Promise<T> {
        if (!this.ws || !this.isConnected) {
            throw new Error('WebSocket 未连接');
        }

        const requestId = `rpc_${++this.rpcIdCounter}_${Date.now()}`;
        const request: SdkRpcRequest = { type: 'sdk', requestId, path, args };

        log.debug(`RPC 请求: ${path}(${JSON.stringify(args).slice(0, 100)})`);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.rpcPending.delete(requestId);
                reject(new Error(`RPC timeout: ${path}`));
            }, 15000);  // 增加超时时间到 15s

            this.rpcPending.set(requestId, {
                resolve: (data) => resolve(data as T),
                reject,
                timer,
            });
            this.ws!.send(JSON.stringify(request));
        });
    }

    /** 
     * 直接调用 OneBot API 并获取 data
     * 解决 SDK Mapping 无法调用的问题
     */
    async callData<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
        if (!this.ws || !this.isConnected) {
            throw new Error('WebSocket 未连接');
        }

        const requestId = `api_${++this.rpcIdCounter}_${Date.now()}`;
        // 根据 stream.ts 逻辑: call='data' 会调用 invoker.data(action, params)
        const request = {
            type: 'invoke',
            requestId,
            call: 'data',
            action,
            params
        };

        log.debug(`API 调用: ${action}`);

        const timeoutMs = resolveApiTimeoutMs(action, params);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.rpcPending.delete(requestId);
                reject(new Error(`API timeout: ${action}`));
            }, timeoutMs);

            this.rpcPending.set(requestId, {
                resolve: (data) => resolve(data as T),
                reject,
                timer,
            });
            this.ws!.send(JSON.stringify(request));
        });
    }

    // ========== 快捷方法 ==========

    /** 发送群消息 */
    async sendGroup(groupId: number, message: string | unknown[]): Promise<unknown> {
        return this.rpc('send.group', [groupId, message]);
    }

    /** 发送私聊消息 */
    async sendPrivate(userId: number, message: string | unknown[]): Promise<unknown> {
        return this.rpc('send.private', [userId, message]);
    }

    // ========== 统一发送方法 ==========

    /**
     * 解析发送目标
     * @param target - 发送目标（群/私聊/FormattedMessage）
     * @returns 解析后的目标信息
     */
    private resolveTarget(target: SendTarget): { isGroup: boolean; id: number } {
        if ('groupId' in target && target.type === 'group') {
            return { isGroup: true, id: target.groupId };
        }
        if ('userId' in target && target.type === 'private') {
            return { isGroup: false, id: target.userId };
        }
        // FormattedMessage
        const msg = target;
        if (msg.type === 'group' && msg.group_id) {
            return { isGroup: true, id: msg.group_id };
        }
        return { isGroup: false, id: msg.sender_id };
    }

    /**
     * 统一发送消息 (自动判断群/私聊)
     * @param target - 发送目标
     * @param segments - 消息段数组
     */
    async send(target: SendTarget, segments: MessageSegment[]): Promise<unknown> {
        const { isGroup, id } = this.resolveTarget(target);
        log.debug(`📤 统一发送: ${isGroup ? '群' : '私聊'} ${id}, ${segments.length} 段`);

        if (isGroup) {
            return this.callData('send_group_msg', {
                group_id: id,
                message: segments,
            });
        }

        return this.callData('send_private_msg', {
            user_id: id,
            message: segments,
        });
    }

    /**
     * 发送图片消息
     * @param target - 发送目标
     * @param file - 图片路径/URL/base64
     */
    async sendImage(target: SendTarget, file: string): Promise<unknown> {
        const segment: MessageSegment = { type: 'image', data: { file } };
        return this.send(target, [segment]);
    }

    /**
     * 上传本地文件到群或私聊。
     * NapCat/OneBot 文件接口读取的是机器人所在机器上的路径。
     */
    async sendFile(target: SendTarget, file: string | FileAttachment): Promise<unknown> {
        const { isGroup, id } = this.resolveTarget(target);
        const filePath = typeof file === 'string' ? file : file.path;
        const fileName = typeof file === 'string'
            ? path.basename(file)
            : (file.name || path.basename(file.path));

        log.debug(`📎 上传文件: ${isGroup ? '群' : '私聊'} ${id}, ${fileName}`);

        if (isGroup) {
            return this.callData('upload_group_file', {
                group_id: id,
                file: filePath,
                name: fileName,
            });
        }

        return this.callData('upload_private_file', {
            user_id: id,
            file: filePath,
            name: fileName,
        });
    }

    /**
     * 发送音乐卡片
     * @param target - 发送目标
     * @param musicType - 音乐类型 (163/qq)
     * @param id - 歌曲ID
     */
    async sendMusic(target: SendTarget, musicType: '163' | 'qq', id: string): Promise<unknown> {
        const segment: MessageSegment = { type: 'music', data: { type: musicType, id } };
        return this.send(target, [segment]);
    }


    /**
     * 将消息分割成多段
     * 短句(<=30字): 分1-2段
     * 中句(31-80字): 分3段
     * 长句(>80字): 不分段
     */
    private splitMessage(text: string): string[] {
        const length = text.length;

        // 长句不分段
        if (length > 80) {
            return [text];
        }

        // 分割点：句号、感叹号、问号、换行、波浪号后、省略号后
        const splitPoints = /([。！？\n~…]+)/g;
        const parts = text.split(splitPoints).filter(p => p.trim());

        // 合并分割符到前一个部分
        const segments: string[] = [];
        for (let i = 0; i < parts.length; i++) {
            splitPoints.lastIndex = 0;
            if (splitPoints.test(parts[i]) && segments.length > 0) {
                segments[segments.length - 1] += parts[i];
            } else if (parts[i].trim()) {
                segments.push(parts[i]);
            }
        }

        // 如果分割后只有一段，尝试用逗号分割
        if (segments.length <= 1) {
            const commaSplit = text.split(/([，,、]+)/g).filter(p => p.trim());
            const commaSegments: string[] = [];
            for (let i = 0; i < commaSplit.length; i++) {
                if (/[，,、]+/.test(commaSplit[i]) && commaSegments.length > 0) {
                    commaSegments[commaSegments.length - 1] += commaSplit[i];
                } else if (commaSplit[i].trim()) {
                    commaSegments.push(commaSplit[i]);
                }
            }
            if (commaSegments.length > 1) {
                return this.mergeToTargetCount(commaSegments, length <= 30 ? 2 : 3);
            }
            return [text]; // 无法分割，返回原文
        }

        // 根据长度决定目标段数
        const targetCount = length <= 30 ? 2 : 3;
        return this.mergeToTargetCount(segments, targetCount);
    }

    /**
     * 合并分段到目标数量
     */
    private mergeToTargetCount(segments: string[], targetCount: number): string[] {
        if (segments.length <= targetCount) {
            return segments;
        }

        // 均匀合并
        const result: string[] = [];
        const perGroup = Math.ceil(segments.length / targetCount);
        for (let i = 0; i < segments.length; i += perGroup) {
            result.push(segments.slice(i, i + perGroup).join(''));
        }
        return result.slice(0, targetCount);
    }

    /**
     * 随机延迟 (模拟打字间隔)
     */
    private delay(minMs: number, maxMs: number): Promise<void> {
        const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /** 回复消息（自动判断群/私聊，支持分段发送） */
    async reply(msg: FormattedMessage, content: string | unknown[]): Promise<unknown> {
        // 如果是数组（消息段），直接发送不分段
        if (Array.isArray(content)) {
            if (msg.type === 'group' && msg.group_id) {
                return this.sendGroup(msg.group_id, content);
            } else {
                return this.sendPrivate(msg.sender_id, content);
            }
        }

        // 文本消息，尝试分段发送
        const text = content;
        const segments = this.splitMessage(text);

        log.debug(`📤 分段发送: ${segments.length}段 [${segments.map(s => s.slice(0, 15) + '...').join(' | ')}]`);

        let lastResult: unknown;
        for (let i = 0; i < segments.length; i++) {
            if (i > 0) {
                // 段间延迟 300-600ms
                await this.delay(300, 600);
            }
            if (msg.type === 'group' && msg.group_id) {
                lastResult = await this.sendGroup(msg.group_id, segments[i]);
            } else {
                lastResult = await this.sendPrivate(msg.sender_id, segments[i]);
            }
        }
        return lastResult;
    }

    // ========== 事件订阅 ==========

    /** 订阅消息事件 */
    onMessage(handler: MessageHandler): () => void {
        this.messageHandlers.push(handler);
        return () => {
            const idx = this.messageHandlers.indexOf(handler);
            if (idx !== -1) this.messageHandlers.splice(idx, 1);
        };
    }

    /** 订阅戳一戳事件 */
    onPoke(handler: PokeHandler): () => void {
        this.pokeHandlers.push(handler);
        return () => {
            const idx = this.pokeHandlers.indexOf(handler);
            if (idx !== -1) this.pokeHandlers.splice(idx, 1);
        };
    }

    /** 断开连接 */
    disconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
        log.info('已断开 napcat 连接');
    }

    /** 是否已连接 */
    get connected(): boolean {
        return this.isConnected;
    }

    get currentUrl(): string {
        return this.url;
    }
}

// 单例导出
export const connector = new NapcatConnector();

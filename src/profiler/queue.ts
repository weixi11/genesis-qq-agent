/**
 * 用户画像分析队列
 * 异步批处理，支持群聊上下文和定时 Flush
 */

import { log } from '../logger.js';
import type { FormattedMessage } from '../types.js';
import type { AnalysisMessage } from '../types.js';
import { recordActivity, saveProfilesAsync } from './store.js';

// 配置
const BATCH_SIZE = 10;           // 每 N 条消息触发分析
const FLUSH_INTERVAL = 5 * 60 * 1000;  // 5 分钟强制 Flush
const SAVE_INTERVAL = 60000;     // 每 60 秒保存一次
const CONTEXT_WINDOW = 8;        // 群聊上下文窗口大小
const MAX_GROUP_CACHE = 100;     // 最多缓存 100 个活跃群的上下文（LRU）

// 消息队列 - 按用户分组
const messageQueue = new Map<number, AnalysisMessage[]>();

// 群聊上下文缓存 - key: groupId, value: 最近消息
const groupContext = new Map<number, Array<{ sender: string; text: string }>>();

// 分析回调
let analyzeCallback: ((messages: Map<number, AnalysisMessage[]>) => Promise<void>) | null = null;

// 队列中的总消息数
let totalMessages = 0;

// 定时器
let saveTimer: NodeJS.Timeout | null = null;
let flushTimer: NodeJS.Timeout | null = null;

// 上次分析时间
let lastAnalysisTime = Date.now();

export interface ProfilerEmotionInput {
    valence: number;
    arousal: number;
}

export interface ProfilerEnqueueOptions {
    text?: string;
    emotion?: ProfilerEmotionInput;
}

/**
 * 设置分析回调（由 Profiler Agent 注册）
 */
export function setAnalyzeCallback(callback: (messages: Map<number, AnalysisMessage[]>) => Promise<void>): void {
    analyzeCallback = callback;
}

function mergeBackToQueue(messages: Map<number, AnalysisMessage[]>): void {
    for (const [userId, items] of messages.entries()) {
        if (items.length === 0) {
            continue;
        }

        const current = messageQueue.get(userId) || [];
        messageQueue.set(userId, [...items, ...current]);
        totalMessages += items.length;
    }
}

function resolveAnalysisText(msg: FormattedMessage, overrideText?: string): string {
    const candidate = overrideText ?? msg.text;
    return candidate.trim();
}

/**
 * 更新群聊上下文（带 LRU 清理）
 */
function updateGroupContext(groupId: number | undefined, sender: string, text: string): Array<{ sender: string; text: string }> | undefined {
    if (!groupId) return undefined;

    // LRU 策略：如果是新群且缓存满了，删除最早的
    if (!groupContext.has(groupId) && groupContext.size >= MAX_GROUP_CACHE) {
        const firstKey = groupContext.keys().next().value;
        if (firstKey !== undefined) {
            groupContext.delete(firstKey);
            log.debug(`📊 清理群上下文缓存: ${firstKey}`);
        }
    }

    if (!groupContext.has(groupId)) {
        groupContext.set(groupId, []);
    }

    const context = groupContext.get(groupId)!;
    context.push({ sender, text });

    // 保持窗口大小
    while (context.length > CONTEXT_WINDOW) {
        context.shift();
    }

    // 返回不包含当前消息的上下文（前面的消息）
    return context.slice(0, -1);
}

/**
 * 将消息加入队列
 */
export function enqueue(msg: FormattedMessage, options: ProfilerEnqueueOptions = {}): void {
    const userId = msg.sender_id;
    const nickname = msg.sender_name || String(userId);
    const analysisText = resolveAnalysisText(msg, options.text);

    // 记录活跃
    recordActivity(userId, nickname);

    // 跳过无文本消息
    if (!analysisText) return;

    // 获取并更新群聊上下文
    const context = updateGroupContext(msg.group_id, nickname, analysisText);

    // 创建分析消息（包含上下文）
    const analysisMsg: AnalysisMessage = {
        userId,
        nickname,
        groupId: msg.group_id,
        text: analysisText,
        timestamp: msg.time * 1000 || Date.now(),
        emotion: options.emotion ? { valence: options.emotion.valence, arousal: options.emotion.arousal } : undefined,
        context,  // 填充上下文！
    };

    // 加入队列
    if (!messageQueue.has(userId)) {
        messageQueue.set(userId, []);
    }
    messageQueue.get(userId)!.push(analysisMsg);

    totalMessages++;
    log.debug(`📊 Profiler 队列: ${totalMessages} 条消息 (${messageQueue.size} 用户)`);

    // 检查是否触发分析
    if (totalMessages >= BATCH_SIZE) {
        void triggerAnalysis();
    }
}

/**
 * 触发分析
 */
async function triggerAnalysis(): Promise<void> {
    if (totalMessages === 0) return;
    if (!analyzeCallback) {
        log.warn('Profiler 分析回调未设置');
        return;
    }

    log.info(`📊 Profiler: 开始分析 ${totalMessages} 条消息 (${messageQueue.size} 用户)`);

    // 复制当前队列并清空
    const toAnalyze = new Map(messageQueue);
    const previousAnalysisTime = lastAnalysisTime;
    messageQueue.clear();
    totalMessages = 0;
    lastAnalysisTime = Date.now();

    try {
        await analyzeCallback(toAnalyze);
    } catch (err) {
        mergeBackToQueue(toAnalyze);
        lastAnalysisTime = previousAnalysisTime;
        log.error('Profiler 分析失败:', err);
    }
}

/**
 * 定时 Flush 检查（防止消息卡死）
 */
function checkFlush(): void {
    if (totalMessages === 0) return;

    const elapsed = Date.now() - lastAnalysisTime;
    if (elapsed >= FLUSH_INTERVAL) {
        log.info(`📊 Profiler: 定时 Flush (${totalMessages} 条消息等待超过 ${Math.floor(elapsed / 1000)}s)`);
        void triggerAnalysis();
    }
}

/**
 * 启动队列 worker
 */
export function startWorker(): void {
    // 定期保存（异步）
    if (saveTimer) {
        clearInterval(saveTimer);
    }
    saveTimer = setInterval(() => {
        void saveProfilesAsync();
    }, SAVE_INTERVAL);

    // 定时 Flush 检查（每分钟检查一次）
    if (flushTimer) {
        clearInterval(flushTimer);
    }
    flushTimer = setInterval(checkFlush, 60000);

    lastAnalysisTime = Date.now();
    log.info('📊 Profiler 队列已启动');
}

/**
 * 停止队列 worker
 */
export function stopWorker(): void {
    if (saveTimer) {
        clearInterval(saveTimer);
        saveTimer = null;
    }
    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }

    // 保存剩余数据
    void saveProfilesAsync();
    log.info('📊 Profiler 队列已停止');
}

/**
 * 强制触发分析（用于测试或手动触发）
 */
export async function forceAnalysis(): Promise<void> {
    await triggerAnalysis();
}

/**
 * 获取队列状态
 */
export function getQueueStatus(): { totalMessages: number; userCount: number } {
    return {
        totalMessages,
        userCount: messageQueue.size,
    };
}

/**
 * Genesis Agent 主入口
 * 阶段二：感知与哨兵层 - 智能判断响应
 */

process.env.GENESIS_PROCESS_ROLE ||= 'agent';

import { config } from './config.js';
import { log } from './logger.js';
import { connector } from './connector.js';
import { memory } from './memory.js';
import { debouncer, type DebouncedMessage } from './debouncer.js';
import { sentry, saveSentryState, type SentryDecision } from './agents/sentry.js';
import { router } from './agents/router.js';
import { persona } from './agents/persona.js';
import { tech, type ToolResult as TechToolResult } from './agents/tech.js';
import { reactAgent } from './agents/react.js';
import { profiler } from './agents/profiler.js';
import { enqueue as enqueueForProfile } from './profiler/queue.js';
import { getProfileAsync } from './profiler/store.js';
import { analyzeEmotion, checkSentraEmoHealth, type EmotionResult } from './emotion.js';
import { handleAdminCommand } from './commands.js';
import { analyzeImportance, storeMemory } from './vectordb/memory.js';
import { startWebServer } from './web/server.js';
import { initializeSharedRuntimeState } from './bootstrap/shared_state.js';
import { startScheduler as startCronScheduler } from './tools/cron_scheduler/index.js';
import { responseEnhancer, toEnhanceableResult } from './services/response_enhancer.js';
import { maybeSendPendingReplyForPlan } from './services/pending_reply.js';
import type { FormattedMessage } from './types.js';
import { type MessageSegment, formatAtMentions, text as textSegment } from './utils/message.js';
import type { FileAttachment } from './utils/file_attachment.js';
import {
    buildGroupBatchComposerMessage,
    executeGroupBatchPlan,
    getGroupBatchMetricsSnapshot,
    planGroupBatch,
    recordGroupBatchPendingSent,
    recordGroupBatchUnifiedFallback,
    shouldSendGroupBatchPending,
    type GroupBatchExecutionResult,
} from './group_aggregator.js';
import {
    ERROR_REPLY_COOLDOWN_MS,
    getConversationKey,
    isBotSelfMessage,
    isCooldownActive,
} from './utils/message_guard.js';
import { closeGenesisDb, saveGenesisDbNow } from './storage/genesis-db.js';
import { toolSelfMaintainer } from './services/tool_self_maintainer.js';
import { toolTestRequestWorker } from './services/tool_test_request_worker.js';
import { getOutgoingReplyText } from './utils/reasoning.js';
import { isInternalSelfReferenceDrawKey } from './utils/selfReferenceDraw.js';
import { decideAutoMeme } from './services/meme_decider.js';
import { shouldUsePersonaSecondPass } from './services/persona_second_pass.js';

// sentra-emo 服务状态
let sentraEmoAvailable = false;
const ERROR_FALLBACK_TEXT = '抱歉，我遇到了一点小问题 😅';
const errorReplyCooldownBySession = new Map<string, number>();
const GROUP_BATCH_GENERATION_TTL_MS = 30 * 60 * 1000;
const groupBatchGenerationByGroup = new Map<number, { generation: number; lastTouchedAt: number }>();
let groupBatchGenerationPruneCounter = 0;

type PersonaUserSummary = {
    nickname: string;
    favorability: number;
    tags: string[];
    traits: string[];
    interests: string[];
    mood?: 'positive' | 'neutral' | 'negative';
};

type PersonaAtUserSummary = {
    userId: number;
    nickname: string;
    traits: string[];
    interests: string[];
    favorability: number;
};

type ToolCallRecord = {
    tool: string;
    params: Record<string, unknown>;
    result?: string;
    tools?: Array<{ name: string; params: Record<string, unknown> }>;
};

/**
 * 清理工具参数，过滤掉大型数据（如 base64 图片）
 * 防止大数据被存入记忆并传给 LLM
 */
function sanitizeToolParams(
    params?: Record<string, unknown>,
    data?: unknown
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const combined = { ...(params || {}), ...((data && typeof data === 'object') ? data as Record<string, unknown> : {}) };

    for (const [key, value] of Object.entries(combined)) {
        if (value === undefined || value === null) continue;
        if (isInternalSelfReferenceDrawKey(key)) continue;

        // 过滤掉大型字符串（base64、长 URL 等）
        if (typeof value === 'string') {
            if (value.startsWith('base64://') || value.startsWith('data:')) {
                // 替换为摘要
                result[key] = `[base64数据 ${Math.round(value.length / 1024)}KB]`;
            } else if (value.length > 200) {
                // 长字符串截断，保留前 100 字符
                result[key] = `${value.slice(0, 100)}...[已截断]`;
            } else {
                result[key] = value;
            }
        } else if (Array.isArray(value)) {
            // 处理数组（如 imagePaths）
            const sanitizedArray = value.map(item => {
                if (typeof item === 'string') {
                    if (item.startsWith('base64://') || item.startsWith('data:')) {
                        return `[base64数据]`;
                    } else if (item.length > 150) {
                        // 长 URL 截断，保留域名部分
                        try {
                            const url = new URL(item);
                            return `${url.origin}/.../${item.slice(-30)}`;
                        } catch {
                            return `${item.slice(0, 50)}...[截断]`;
                        }
                    }
                    return item;
                }
                return item;
            });
            result[key] = sanitizedArray;
        } else if (typeof value === 'object') {
            // 嵌套对象转为摘要
            result[key] = '[对象]';
        } else {
            result[key] = value;
        }
    }

    return result;
}

function buildPersonaContext(message: FormattedMessage): {
    userProfile?: PersonaUserSummary;
    atUserProfiles?: PersonaAtUserSummary[];
} {
    const senderProfile = getProfileAsync(message.sender_id);
    const userProfile = senderProfile ? {
        nickname: senderProfile.nickname,
        favorability: senderProfile.favorability,
        tags: [...senderProfile.traits, ...senderProfile.interests].slice(0, 5),
        traits: senderProfile.traits,
        interests: senderProfile.interests,
        mood: senderProfile.mood,
    } : undefined;

    const atUserProfiles: PersonaAtUserSummary[] = [];
    for (const atUserId of message.at_users || []) {
        const atProfile = getProfileAsync(atUserId);
        if (atProfile && atProfile.userId !== 0) {
            atUserProfiles.push({
                userId: atProfile.userId,
                nickname: atProfile.nickname,
                traits: atProfile.traits,
                interests: atProfile.interests,
                favorability: atProfile.favorability,
            });
        }
    }

    return {
        userProfile,
        atUserProfiles: atUserProfiles.length > 0 ? atUserProfiles : undefined,
    };
}

function buildToolCallRecord(result: TechToolResult): ToolCallRecord {
    return {
        tool: result.tool,
        params: sanitizeToolParams(result.params, result.data),
        result: result.text,
        tools: result.toolParams,
    };
}

async function collectToolResultParts(
    first: FormattedMessage,
    result: TechToolResult,
    unifiedSegments: MessageSegment[] | undefined,
): Promise<{ parts: string[]; sentCount: number; failedCount: number; fileSentCount: number; fileFailedCount: number }> {
    const toolResultParts: string[] = [];
    let sentCount = 0;
    let failedCount = 0;
    let fileSentCount = 0;
    let fileFailedCount = 0;

    if (result.success && unifiedSegments && unifiedSegments.length > 0) {
        const segmentSendResult = await sendToolSegmentsSafely(first, unifiedSegments);
        log.info(`✅ 已发送 ${segmentSendResult.sentCount}/${unifiedSegments.length} 个消息段`);
        sentCount = segmentSendResult.sentCount;
        failedCount = segmentSendResult.failedCount;

        const dataWithMsg = result.data as { message?: string } | undefined;
        if (segmentSendResult.sentCount === 0 && segmentSendResult.failedCount > 0) {
            toolResultParts.push('图片发送失败了，我刚刚没把结果真正发出去，稍后重试一下。');
        } else if (dataWithMsg?.message) {
            toolResultParts.push(dataWithMsg.message);
        } else if (segmentSendResult.sentCount === 0 && segmentSendResult.failedCount > 0 && !result.text?.trim()) {
            toolResultParts.push('富媒体结果发送失败，请稍后重试。');
        }
    }

    if (result.success && result.files && result.files.length > 0) {
        const fileSendResult = await sendToolFilesSafely(first, result.files);
        log.info(`✅ 已发送 ${fileSendResult.sentCount}/${result.files.length} 个文件`);
        fileSentCount = fileSendResult.sentCount;
        fileFailedCount = fileSendResult.failedCount;

        if (fileSendResult.sentCount === 0 && fileSendResult.failedCount > 0) {
            toolResultParts.push('文件生成好了，但刚刚没能把文件发出去，请稍后重试。');
        }
    }

    const shouldIncludeRawText = !unifiedSegments
        || unifiedSegments.length === 0
        || sentCount > 0
        || failedCount === 0
        || fileSentCount > 0;

    if (result.text && shouldIncludeRawText) {
        const cleanText = result.text
            .replace(/\[CQ:[^\]]+\]/g, '')
            .replace(/https?:\/\/[^\s]+/g, '')
            .trim();

        if (cleanText) {
            for (const part of cleanText.split(/\n\n---\n\n/).filter(Boolean)) {
                const trimmedPart = part.trim();
                if (trimmedPart && !toolResultParts.includes(trimmedPart)) {
                    toolResultParts.push(trimmedPart);
                }
            }
        }
    }

    return { parts: toolResultParts, sentCount, failedCount, fileSentCount, fileFailedCount };
}

/** 发送回复的辅助函数 */
async function sendReply(msg: FormattedMessage, text: string): Promise<void> {
    const replyText = getOutgoingReplyText(text);
    if (!replyText) return;
    await connector.reply(msg, replyText);
}

async function sendUnifiedReply(
    msg: FormattedMessage,
    text?: string,
    extraSegments: MessageSegment[] = [],
): Promise<string | undefined> {
    const replyText = getOutgoingReplyText(text);
    if (!replyText && extraSegments.length === 0) {
        return replyText;
    }

    if (!replyText) {
        await sendToolSegmentsSafely(msg, extraSegments);
        return replyText;
    }

    const segments: MessageSegment[] = [textSegment(replyText), ...extraSegments];
    try {
        await connector.send(msg, segments);
        return replyText;
    } catch (error) {
        log.warn('统一回复发送失败，降级为文本优先发送', {
            targetType: msg.type,
            groupId: msg.group_id,
            senderId: msg.sender_id,
            segmentCount: extraSegments.length,
            error: error instanceof Error ? error.message : String(error),
        });
        recordGroupBatchUnifiedFallback();
        await sendReply(msg, replyText);
        if (extraSegments.length > 0) {
            await sendToolSegmentsSafely(msg, extraSegments);
        }
    }

    return replyText;
}

async function sendToolSegmentsSafely(
    target: FormattedMessage,
    segments: MessageSegment[],
): Promise<{ sentCount: number; failedCount: number }> {
    let sentCount = 0;
    let failedCount = 0;

    for (const [index, segment] of segments.entries()) {
        try {
            await connector.send(target, [segment]);
            sentCount += 1;
        } catch (err) {
            failedCount += 1;
            log.warn('⚠️ 富媒体消息段发送失败，降级继续文本回复', {
                segmentType: segment.type,
                targetType: target.type,
                groupId: target.group_id,
                senderId: target.sender_id,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        if (index < segments.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    return { sentCount, failedCount };
}

async function sendToolFilesSafely(
    target: FormattedMessage,
    files: FileAttachment[],
): Promise<{ sentCount: number; failedCount: number }> {
    let sentCount = 0;
    let failedCount = 0;

    for (const [index, file] of files.entries()) {
        try {
            await connector.sendFile(target, file);
            sentCount += 1;
        } catch (err) {
            failedCount += 1;
            log.warn('⚠️ 本地文件发送失败，降级继续文本回复', {
                targetType: target.type,
                groupId: target.group_id,
                senderId: target.sender_id,
                fileName: file.name,
                filePath: file.path,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        if (index < files.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    return { sentCount, failedCount };
}

async function appendAutoMemeSegments(
    message: FormattedMessage,
    replyText: string | undefined,
    existingSegments: MessageSegment[],
    options?: {
        emotion?: EmotionResult | null;
        toolAlreadySentMedia?: boolean;
    },
): Promise<MessageSegment[]> {
    const decision = await decideAutoMeme({
        message,
        replyText,
        emotion: options?.emotion,
        toolAlreadySentMedia: options?.toolAlreadySentMedia ?? existingSegments.length > 0,
    });

    if (!decision.shouldSend || decision.segments.length === 0) {
        log.debug(`🎭 自动表情跳过: ${decision.reason || '未说明原因'}`);
        return existingSegments;
    }

    return [...existingSegments, ...decision.segments];
}

async function sendErrorFallbackOnce(target: FormattedMessage): Promise<void> {
    const sessionKey = getConversationKey(target);
    const now = Date.now();
    const lastTriggeredAt = errorReplyCooldownBySession.get(sessionKey);

    if (isCooldownActive(lastTriggeredAt, now, ERROR_REPLY_COOLDOWN_MS)) {
        log.warn('⚠️ 会话级错误兜底冷却中，跳过重复报错回复', {
            sessionKey,
            senderId: target.sender_id,
            groupId: target.group_id,
        });
        return;
    }

    errorReplyCooldownBySession.set(sessionKey, now);

    try {
        await connector.send(target, [textSegment(ERROR_FALLBACK_TEXT)]);
    } catch (err) {
        errorReplyCooldownBySession.delete(sessionKey);
        throw err;
    }
}

function pruneGroupBatchGenerationMap(now: number = Date.now()): void {
    groupBatchGenerationPruneCounter += 1;
    if (groupBatchGenerationPruneCounter % 32 !== 0 && groupBatchGenerationByGroup.size < 512) {
        return;
    }

    for (const [groupId, state] of groupBatchGenerationByGroup.entries()) {
        if (now - state.lastTouchedAt > GROUP_BATCH_GENERATION_TTL_MS) {
            groupBatchGenerationByGroup.delete(groupId);
        }
    }
}

function reserveGroupBatchGeneration(groupId?: number): number {
    if (!groupId) return 0;
    const now = Date.now();
    pruneGroupBatchGenerationMap(now);
    const nextGeneration = (groupBatchGenerationByGroup.get(groupId)?.generation || 0) + 1;
    groupBatchGenerationByGroup.set(groupId, {
        generation: nextGeneration,
        lastTouchedAt: now,
    });
    return nextGeneration;
}

function isCurrentGroupBatchGeneration(groupId: number | undefined, generation: number): boolean {
    if (!groupId || generation === 0) return true;
    const state = groupBatchGenerationByGroup.get(groupId);
    if (!state) return false;
    state.lastTouchedAt = Date.now();
    return state.generation === generation;
}

function createSentryDisabledDecision(msg: FormattedMessage): SentryDecision {
    const botId = msg.self_id || config.botQQ;
    const mentionedBot = Boolean(botId && msg.at_users?.includes(botId));

    if (msg.type === 'private') {
        return { shouldRespond: true, desireScore: 1, reason: '哨兵已禁用：私聊直通', priority: 'high' };
    }

    if (mentionedBot) {
        return { shouldRespond: true, desireScore: 1, reason: '哨兵已禁用：@消息直通', priority: 'high' };
    }

    return { shouldRespond: false, desireScore: 0, reason: '哨兵已禁用：仅响应私聊或@消息', priority: 'low' };
}

/** 格式化消息摘要，包含多媒体标签 */
function formatMessageSummary(msg: FormattedMessage): string {
    const parts: string[] = [];

    // 回复
    if (msg.reply) {
        parts.push(`↩️"${msg.reply.text?.slice(0, 15) || '...'}"`);
    }

    // 文本内容
    let text = msg.text?.trim() || '';

    // 如果有详细的 @信息，尝试替换文本中的 @QQ
    if (msg.at_users_details?.length) {
        text = formatAtMentions(text, msg.at_users_details);
    }

    if (text) {
        parts.push(text.slice(0, 100)); // 略微增加长度限制
    }

    // 图片
    const images = msg.images;
    if (images?.length > 0) {
        parts.push(images.length > 1 ? `[图x${images.length}]` : '[图]');
    }

    // 视频/语音/文件
    if (msg.videos && msg.videos.length > 0) parts.push('[视频]');
    if (msg.records && msg.records.length > 0) parts.push('[语音]');
    if (msg.files && msg.files.length > 0) parts.push('[文件]');
    if (msg.forwards && msg.forwards.length > 0) parts.push('[转发]');

    // 卡片
    const cards = msg.cards;
    if (cards && cards.length > 0) {
        parts.push(cards[0].title ? `[卡片:${cards[0].title.slice(0, 8)}]` : '[卡片]');
    }

    // 表情
    const faces = msg.faces;
    if (faces && faces.length > 0) {
        parts.push(`[${faces.slice(0, 2).map(f => f.text || '表情').join('')}]`);
    }

    // @ (只有当文本中没有包含所有 @对象时，才在末尾补充)
    if (msg.at_users?.length > 0) {
        // 检查是否所有 @用户都已经在文本中被替换/展示了
        const missingAt: string[] = [];

        if (msg.at_users_details?.length) {
            for (const u of msg.at_users_details) {
                // 如果文本中不包含这个ID，说明可能没替换成功（比如是纯图片消息带@，或者格式不对）
                if (!text.includes(String(u.id))) {
                    const name = u.card || u.name || String(u.id);
                    missingAt.push(`@${name}(${u.id})`);
                }
            }
        } else {
            // 没有详情，回退到旧逻辑
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
    if (msg.at_all) parts.push('@全体');

    return parts.join(' ') || '(空)';
}

// 角色缓存 (GroupId:UserId -> { role, time })
const roleCache = new Map<string, { role: string, time: number }>();
const ROLE_CACHE_TTL = 5 * 60 * 1000;

async function resolveRole(groupId: number, userId: number, currentRole?: string): Promise<string> {
    // 1. 如果推送的消息里已经是 owner 或 admin，直接信任
    if (currentRole === 'owner' || currentRole === 'admin') {
        log.debug(`✅ 信任事件角色: ${currentRole} (${userId})`);
        return currentRole;
    }

    const key = `${groupId}:${userId}`;
    const now = Date.now();

    // 1. 优先使用缓存
    const cached = roleCache.get(key);
    if (cached && now - cached.time < ROLE_CACHE_TTL) {
        return cached.role;
    }

    // 2. 只有当 currentRole 也是 member (或为空) 时，才去 API 验证（防止降级，也不信任 member）
    // 或者简单粗暴：总是验证（带缓存对性能影响不大）
    try {
        const info = await connector.callData<{ role?: string }>('get_group_member_info', { group_id: groupId, user_id: userId, no_cache: true });
        if (info?.role) {
            roleCache.set(key, { role: info.role, time: now });
            return info.role;
        }
    } catch (e) {
        log.warn(`获取角色失败 ${groupId}:${userId}: ${(e as Error).message}`);
    }

    return currentRole || 'member';
}

/** 
 * 阶段一：消息预处理与存储
 * 解析角色，存入记忆，返回历史记录
 */
async function resolveAndStoreMessage(debounced: DebouncedMessage): Promise<FormattedMessage[]> {
    const { first, messages } = debounced;

    // 修正角色信息 (Cache-First)
    if (first.type === 'group' && first.group_id) {
        if (debounced.mode === 'group_mention_batch' && debounced.participants && debounced.participants.length > 1) {
            const senderRoleMap = new Map<number, FormattedMessage['sender_role']>();
            for (const msg of messages) {
                if (senderRoleMap.has(msg.sender_id)) continue;
                const trueRole = await resolveRole(first.group_id, msg.sender_id, msg.sender_role);
                senderRoleMap.set(msg.sender_id, trueRole as FormattedMessage['sender_role']);
            }

            for (const msg of messages) {
                const resolvedRole = senderRoleMap.get(msg.sender_id);
                if (resolvedRole) {
                    msg.sender_role = resolvedRole;
                }
            }
            first.sender_role = senderRoleMap.get(first.sender_id) || first.sender_role;
        } else {
            const trueRole = await resolveRole(first.group_id, first.sender_id, first.sender_role);
            // 更新所有消息
            for (const msg of messages) {
                if (msg.sender_id === first.sender_id) {
                    msg.sender_role = trueRole as FormattedMessage['sender_role'];
                }
            }
            // 更新 first (用于摘要)
            first.sender_role = trueRole as FormattedMessage['sender_role'];
        }
    }

    // 将所有消息加入记忆（先 push，再获取 history，确保上下文包含当前消息）
    for (const msg of messages) {
        memory.push(msg);
    }

    // 获取历史记忆（包含刚加入的当前消息）
    const history = memory.getHistory(first);

    // 格式化消息摘要
    const summary = formatMessageSummary(first);
    log.info(`📨 [${first.type === 'group' ? `群${first.group_id}` : '私聊'}] ${first.sender_name}: ${summary}`);

    return history;
}

function buildMentionBatchSyntheticMessage(debounced: DebouncedMessage): FormattedMessage {
    const { first, participants, mergedText } = debounced;
    const participantCount = participants?.length || 1;
    const senderNames = participants?.map(p => p.senderName).join('、') || first.sender_name;

    return {
        ...first,
        text: mergedText,
        summary: `多人同时@：${senderNames}`.slice(0, 80),
        sender_name: participantCount > 1 ? `${first.sender_name}等${participantCount}人` : first.sender_name,
        objective: 'group_mention_batch',
    };
}

function buildFilteredGroupBatchPrompt(debounced: DebouncedMessage): string {
    const participants = debounced.participants || [];
    const lines = participants.map((participant, index) => {
        const countLabel = participant.messageCount > 1 ? `，连续发了 ${participant.messageCount} 条` : '';
        return `${index + 1}. ${participant.senderName}(${participant.senderId}${countLabel})：${participant.mergedText}`;
    });

    return [
        '【群聊多人同时@你】',
        `当前同一时间窗口里有 ${participants.length} 位群成员同时在找你。请你只回复一条群消息，尽量自然覆盖每个人，可以直接点名回应。`,
        '如果问题很多，先简洁回应每个人的核心诉求，不要拆成多条发送。',
        '',
        '本轮汇总：',
        ...lines,
    ].join('\n');
}

function buildGroupBatchParticipantSnippet(message: FormattedMessage): string {
    const parts: string[] = [];
    const text = message.text?.trim();
    if (text) parts.push(text);
    if (message.images?.length) parts.push(message.images.length > 1 ? `[图片x${message.images.length}]` : '[图片]');
    if (message.videos?.length) parts.push('[视频]');
    if (message.records?.length) parts.push('[语音]');
    if (message.files?.length) parts.push('[文件]');
    return parts.join(' ').trim() || '（发送了@或媒体消息）';
}

function rebuildGroupBatchParticipants(messages: FormattedMessage[]): NonNullable<DebouncedMessage['participants']> {
    const participants = new Map<number, NonNullable<DebouncedMessage['participants']>[number]>();
    const orderedIds: number[] = [];

    for (const message of messages) {
        const snippet = buildGroupBatchParticipantSnippet(message);
        const existing = participants.get(message.sender_id);
        if (existing) {
            existing.messageCount += 1;
            existing.mergedText = existing.mergedText ? `${existing.mergedText}\n${snippet}` : snippet;
            continue;
        }

        orderedIds.push(message.sender_id);
        participants.set(message.sender_id, {
            senderId: message.sender_id,
            senderName: message.sender_name || String(message.sender_id),
            messageCount: 1,
            mergedText: snippet,
        });
    }

    return orderedIds
        .map(id => participants.get(id))
        .filter((participant): participant is NonNullable<DebouncedMessage['participants']>[number] => participant !== undefined);
}

function filterGroupBatchDebouncedByMessageIds(
    debounced: DebouncedMessage,
    excludedMessageIds: Set<number>,
): DebouncedMessage | null {
    if (excludedMessageIds.size === 0) return debounced;

    const messages = debounced.messages.filter(message => !excludedMessageIds.has(message.message_id));
    if (messages.length === 0) {
        return null;
    }

    const participants = rebuildGroupBatchParticipants(messages);
    const mode: DebouncedMessage['mode'] = participants.length > 1 ? 'group_mention_batch' : 'single';
    const mergedText = mode === 'group_mention_batch'
        ? buildFilteredGroupBatchPrompt({ ...debounced, participants })
        : messages.map(message => message.text).join('');
    const mergedImages = messages.flatMap(message => message.images).map(image => {
        if (typeof image === 'string') return image;
        return image.path || image.file || image.url || '';
    }).filter(Boolean);

    return {
        messages,
        mergedText,
        mergedImages,
        first: messages[0],
        last: messages[messages.length - 1],
        mode,
        participants: mode === 'group_mention_batch' ? participants : undefined,
        windowMs: debounced.windowMs,
    };
}

async function processGroupBatchAdminCommands(debounced: DebouncedMessage): Promise<Set<number>> {
    const handledMessageIds = new Set<number>();

    for (const message of debounced.messages) {
        if (!message.text?.trim().startsWith('#')) continue;

        const handled = await processAdminCommand(message);
        if (handled) {
            handledMessageIds.add(message.message_id);
        }
    }

    return handledMessageIds;
}

async function handleGroupMentionBatch(
    debounced: DebouncedMessage,
    history: FormattedMessage[],
    generation: number,
): Promise<GroupBatchExecutionResult> {
    const batchMessage = buildMentionBatchSyntheticMessage(debounced);
    const participantNames = debounced.participants?.map(p => p.senderName).join('、') || batchMessage.sender_name;
    log.info(`👥 群聊多人@合并回复: ${participantNames}`);

    const plan = planGroupBatch(debounced);
    log.info(`👥 群聊聚合策略: ${plan.strategy} tasks=${plan.tasks.length} window=${debounced.windowMs}ms`);

    if (plan.strategy === 'persona_only' || plan.strategy === 'clarify_first') {
        const result = await persona.respond({
            message: batchMessage,
            history,
            emotion: null,
        });

        return { text: result.text, segments: [] };
    }

    let pendingTimer: NodeJS.Timeout | null = null;
    let pendingSent = false;
    if (shouldSendGroupBatchPending(plan)) {
        pendingTimer = setTimeout(() => {
            if (!isCurrentGroupBatchGeneration(batchMessage.group_id, generation) || pendingSent) {
                return;
            }
            pendingSent = true;
            recordGroupBatchPendingSent();
            void connector.send(batchMessage, [textSegment('你们这波我在一起处理，稍等我合一下结果。')]).catch(error => {
                log.debug('群聊聚合占位消息发送失败', error instanceof Error ? error.message : String(error));
            });
        }, 1200);
    }

    let executionResult: GroupBatchExecutionResult;
    try {
        executionResult = await executeGroupBatchPlan(plan);
    } finally {
        if (pendingTimer) {
            clearTimeout(pendingTimer);
        }
    }

    if (executionResult.draftLines && executionResult.draftLines.length > 0 && executionResult.text?.trim()) {
        try {
            const composerMessage = buildGroupBatchComposerMessage(batchMessage, plan, executionResult.draftLines);
            const composed = await persona.respond({
                message: composerMessage,
                history,
                emotion: null,
            });
            if (composed.text?.trim()) {
                executionResult.text = composed.text;
            }
        } catch (error) {
            log.warn('群聊聚合 Persona 润色失败，保留规则汇总结果', error);
        }
    }

    const metrics = getGroupBatchMetricsSnapshot();
    log.info(`👥 群批次指标: planned=${metrics.plannedBatches} executed=${metrics.executedBatches} saved=${metrics.savedToolCalls} avgWindow=${metrics.averageWindowMs}ms`);

    if (executionResult.text?.trim() || executionResult.segments.length > 0) {
        return executionResult;
    }

    const fallback = await persona.respond({
        message: batchMessage,
        history,
        emotion: null,
    });
    return { text: fallback.text, segments: [] };
}

/** 
 * 阶段二：管理员指令处理 
 * 返回 true 表示指令已处理，无需通过
 */
async function processAdminCommand(first: FormattedMessage): Promise<boolean> {
    const cmdResult = handleAdminCommand(first);
    if (!cmdResult.handled) return false;

    // 先发送同步响应
    if (cmdResult.response) {
        await sendReply(first, cmdResult.response);
    }

    if (cmdResult.asyncHandler) {
        try {
            const asyncResult = await cmdResult.asyncHandler();
            await sendReply(first, asyncResult);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error('异步命令处理失败:', msg);
            await sendReply(first, `❌ 处理失败: ${msg}`);
        }
    }

    log.info(`📋 管理员指令已处理`);
    return true;
}

/** 
 * 阶段三：分析 (情感、画像、向量记忆)
 * 异步执行画像和向量存储，返回情感分析结果
 */
async function performAnalysis(first: FormattedMessage, mergedText: string): Promise<EmotionResult | null> {
    let emotion: EmotionResult | null = null;

    // 情感分析
    if (config.agents.emotionEnabled && !sentraEmoAvailable) {
        sentraEmoAvailable = await checkSentraEmoHealth();
    }
    if (config.agents.emotionEnabled && sentraEmoAvailable && mergedText.length > 0) {
        emotion = await analyzeEmotion(
            mergedText,
            String(first.sender_id),
            first.sender_name
        );
    }

    // 后台：将合并后的消息加入 Profiler 分析队列（异步，不阻塞）
    const profilerInputText = mergedText.trim() || formatMessageSummary(first);
    if (config.agents.profilerEnabled && profilerInputText) {
        enqueueForProfile(first, {
            text: profilerInputText,
            emotion: emotion ? { valence: emotion.valence, arousal: emotion.arousal } : undefined,
        });
    }

    // 后台：分析并存储重要记忆（异步，不阻塞）
    if (config.agents.vectordbEnabled) {
        const importance = analyzeImportance(mergedText);
        if (importance > 0) {
            storeMemory({
                userId: first.sender_id,
                text: mergedText,
                type: importance >= 4 ? 'fact' : importance >= 2 ? 'preference' : 'chat',
                importance,
            }).catch(err => log.debug('存储记忆失败:', err.message));
        }
    }

    return emotion;
}

/**
 * 阶段四：Tech Agent 处理
 * 返回处理结果：{ handled: boolean, response?: string, fallback: boolean }
 */
async function handleTechRouter(
    first: FormattedMessage,
    history: FormattedMessage[],
    plan: import('./types.js').TaskPlan,
    emotion: EmotionResult | null
): Promise<{ handled: boolean; response?: string; fallback?: boolean; toolSentMedia?: boolean; toolCall?: { tool: string; params: Record<string, unknown>; result?: string; tools?: Array<{ name: string; params: Record<string, unknown> }> } }> {
    const result = await tech.handlePlan(plan, first, history);

    if (result.tool === 'none') {
        if (config.techFallbackToPersona) {
            log.debug('Tech 判断无需工具，交给 Persona 处理');
            return { handled: false, fallback: true };
        }

        let response = result.text;
        if (config.toolEnhanceResponse && response) {
            response = await persona.enhanceToolResult({
                message: first,
                toolName: 'assistant',
                toolNames: [],
                toolResult: response,
                emotion,
                toolParams: { ...result.params, ...result.data as Record<string, unknown> },
                userOriginalText: first.text,
            });
        }
        return { handled: true, response, toolSentMedia: false };
    }

    const unifiedSegments = result.segments;
    const collectedToolResult = await collectToolResultParts(first, result, unifiedSegments);
    const toolResultParts = collectedToolResult.parts;
    const mediaDelivered = collectedToolResult.sentCount > 0 || collectedToolResult.fileSentCount > 0;
    const mediaFailedWithoutDelivery = collectedToolResult.sentCount === 0
        && collectedToolResult.fileSentCount === 0
        && (collectedToolResult.failedCount > 0 || collectedToolResult.fileFailedCount > 0);
    log.debug(`📝 工具结果收集: ${toolResultParts.length} 部分`);

    if (config.toolEnhanceResponse && toolResultParts.length > 0) {
        const combinedResult = toolResultParts.join('\n\n---\n\n');
        log.debug(`📝 准备润色: ${combinedResult.slice(0, 100)}...`);

        const enhanceResult = await responseEnhancer.enhance({
            message: first,
            history,
            result: {
                ...toEnhanceableResult(result, combinedResult),
                hasSegments: mediaDelivered,
                success: mediaFailedWithoutDelivery ? false : result.success,
            },
            emotion,
            taskPlan: plan,
        });

        log.debug(`📝 润色完成: ${enhanceResult.text?.slice(0, 50) || '(空)'}...`);

        return {
            handled: true,
            response: enhanceResult.text,
            toolSentMedia: mediaDelivered,
            toolCall: enhanceResult.toolCall,
        };
    }

    if (unifiedSegments && unifiedSegments.length > 0 && mediaDelivered) {
        const textResponse = toolResultParts.length > 0
            ? toolResultParts.join('\n\n---\n\n')
            : undefined;

        return {
            handled: true,
            response: textResponse,
            toolSentMedia: true,
            toolCall: buildToolCallRecord(result),
        };
    }

    let response = mediaFailedWithoutDelivery
        ? toolResultParts.join('\n\n---\n\n') || '图片发送失败了，请稍后重试。'
        : result.text;
    if (config.toolEnhanceResponse && result.tool && response && !response.includes('[CQ:')) {
        const enhanceResult = await responseEnhancer.enhance({
            message: first,
            history,
            result: {
                toolName: result.tool,
                toolNames: result.toolNames,
                rawText: response,
                params: result.params,
                data: result.data,
                success: result.success,
            },
            emotion,
            taskPlan: plan,
        });
        response = enhanceResult.text;
    }

    return {
        handled: true,
        response,
        toolSentMedia: false,
        toolCall: buildToolCallRecord(result),
    };
}

/**
 * 阶段五：Persona Agent 处理
 */
async function handlePersonaRouter(
    first: FormattedMessage,
    history: FormattedMessage[],
    emotion: EmotionResult | null
): Promise<string> {
    const { userProfile, atUserProfiles } = buildPersonaContext(first);

    log.debug(`📋 画像获取完成，调用 Persona...`);
    const result = await persona.respond({
        message: first,
        history,
        emotion,
        userProfile,
        atUserProfiles,
    });
    log.debug(`📋 Persona 响应完成`);

    return result.text;
}

async function maybeHandleGroupMentionBatchFlow(
    debouncedMessage: DebouncedMessage,
    history: FormattedMessage[],
): Promise<{ handled: boolean; debouncedMessage: DebouncedMessage | null }> {
    if (debouncedMessage.mode !== 'group_mention_batch' || (debouncedMessage.participants?.length || 0) <= 1) {
        return { handled: false, debouncedMessage };
    }

    const adminHandledMessages = await processGroupBatchAdminCommands(debouncedMessage);
    const filteredDebounced = filterGroupBatchDebouncedByMessageIds(debouncedMessage, adminHandledMessages);
    if (!filteredDebounced) {
        return { handled: true, debouncedMessage: null };
    }

    if (filteredDebounced.mode !== 'group_mention_batch' || (filteredDebounced.participants?.length || 0) <= 1) {
        return { handled: false, debouncedMessage: filteredDebounced };
    }

    const generation = reserveGroupBatchGeneration(filteredDebounced.first.group_id);
    const response = await handleGroupMentionBatch(filteredDebounced, history, generation);
    if (!isCurrentGroupBatchGeneration(filteredDebounced.first.group_id, generation)) {
        log.info(`👥 群聊聚合回复已过期，丢弃旧批次结果: group=${filteredDebounced.first.group_id} generation=${generation}`);
        return { handled: true, debouncedMessage: filteredDebounced };
    }

    if (response.text?.trim() || response.segments.length > 0) {
        await finalizeUnifiedResponse(filteredDebounced.first, response, '群聊多人@聚合回复', 'high', null);
    }
    return { handled: true, debouncedMessage: filteredDebounced };
}

async function maybeRenderReactResult(
    first: FormattedMessage,
    history: FormattedMessage[],
    emotion: EmotionResult | null,
    reactResult: Awaited<ReturnType<typeof reactAgent.handle>>,
): Promise<string | undefined> {
    let finalSpokenResponse = reactResult.text;
    let deliveredFileCount = 0;

    if (reactResult.success && reactResult.segments && reactResult.segments.length > 0) {
        const segmentSendResult = await sendToolSegmentsSafely(first, reactResult.segments);
        if (segmentSendResult.sentCount === 0 && segmentSendResult.failedCount > 0 && !finalSpokenResponse?.trim()) {
            finalSpokenResponse = '抱歉，富媒体消息发送失败，请稍后重试。';
        }
    }
    if (reactResult.success && reactResult.files && reactResult.files.length > 0) {
        const fileSendResult = await sendToolFilesSafely(first, reactResult.files);
        deliveredFileCount = fileSendResult.sentCount;
        if (fileSendResult.sentCount === 0 && fileSendResult.failedCount > 0 && !finalSpokenResponse?.trim()) {
            finalSpokenResponse = '文件生成好了，但刚刚没能把文件发出去，请稍后重试。';
        }
    }

    const personaSecondPassDecision = shouldUsePersonaSecondPass({
        source: 'react',
        message: first,
        toolName: reactResult.tool,
        toolNames: reactResult.toolNames,
        text: finalSpokenResponse,
        success: reactResult.success,
        hasSegments: (reactResult.segments?.length || 0) > 0 || deliveredFileCount > 0,
    });

    if (!finalSpokenResponse || finalSpokenResponse.includes('[CQ:') || !personaSecondPassDecision.shouldUse) {
        if (finalSpokenResponse) {
            log.debug(`🧠 [双脑架构] 跳过 Persona 二次渲染: ${personaSecondPassDecision.reason}`);
        }
        return finalSpokenResponse;
    }

    log.info(`🧠 [双脑架构] ReAct 结果进入 Persona 渲染: ${personaSecondPassDecision.reason}`);
    const { userProfile, atUserProfiles } = buildPersonaContext(first);

    try {
        return await persona.enhanceToolResult({
            message: first,
            toolName: reactResult.tool === 'none' ? 'none' : reactResult.tool,
            toolNames: reactResult.toolNames || [],
            toolResult: reactResult.text,
            emotion,
            toolParams: reactResult.params && typeof reactResult.params === 'object' ? reactResult.params : {},
            history,
            userProfile,
            atUserProfiles,
        });
    } catch (e) {
        log.error(`⚠️ Persona 渲染失败，降级返回裸数据:`, e);
        return finalSpokenResponse;
    }
}

async function handleReactPlanExecution(
    first: FormattedMessage,
    history: FormattedMessage[],
    emotion: EmotionResult | null,
    decision: SentryDecision,
): Promise<void> {
    log.info(`🧠 [True ReAct] 复杂任务命中，交给 ReAct 执行`);
    const reactResult = await reactAgent.handle(first, history, emotion);
    const finalSpokenResponse = await maybeRenderReactResult(first, history, emotion, reactResult);
    const reactToolCall: ToolCallRecord = {
        tool: reactResult.tool,
        params: sanitizeToolParams(reactResult.params, reactResult.data),
        result: reactResult.text,
        tools: reactResult.toolParams,
    };
    const hasReactText = Boolean(finalSpokenResponse?.trim());
    const hasReactToolOutput = (reactResult.segments?.length ?? 0) > 0
        || (reactResult.files?.length ?? 0) > 0
        || reactResult.tool !== 'none';

    if (hasReactText || hasReactToolOutput) {
        await finalizeResponse(first, finalSpokenResponse, 'ReAct+Persona', decision.priority, reactToolCall, {
            emotion,
            toolAlreadySentMedia: (reactResult.segments?.length ?? 0) > 0 || (reactResult.files?.length ?? 0) > 0,
        });
    }
}

async function handleStandardPlanExecution(
    first: FormattedMessage,
    history: FormattedMessage[],
    plan: import('./types.js').TaskPlan,
    emotion: EmotionResult | null,
    decision: SentryDecision,
): Promise<void> {
    let response: string | undefined;
    let toolCall: ToolCallRecord | undefined;
    let toolAlreadySentMedia = false;

    if (plan.needsTool && plan.steps.some(s => s.tool)) {
        await maybeSendPendingReplyForPlan(first, plan);
        const techResult = await handleTechRouter(first, history, plan, emotion);
        if (techResult.handled) {
            response = techResult.response;
            toolCall = techResult.toolCall;
            toolAlreadySentMedia = Boolean(techResult.toolSentMedia);
        } else if (techResult.fallback) {
            response = await handlePersonaRouter(first, history, emotion);
        }
    } else {
        response = await handlePersonaRouter(first, history, emotion);
    }

    if ((response && response.trim()) || toolCall) {
        await finalizeResponse(first, response, plan.goal, decision.priority, toolCall, {
            emotion,
            toolAlreadySentMedia,
        });
    }
}

/**
 * 阶段六：发送最终回复并记录
 */
async function finalizeResponse(
    first: FormattedMessage,
    response: string | undefined,
    intent: string,
    priority: string,
    toolCall?: { tool: string; params: Record<string, unknown>; result?: string; tools?: Array<{ name: string; params: Record<string, unknown> }> },
    options?: { emotion?: EmotionResult | null; toolAlreadySentMedia?: boolean },
): Promise<void> {
    const replyText = getOutgoingReplyText(response);
    const extraSegments = await appendAutoMemeSegments(first, replyText, [], {
        emotion: options?.emotion,
        toolAlreadySentMedia: options?.toolAlreadySentMedia,
    });

    if (replyText || extraSegments.length > 0) {
        await sendUnifiedReply(first, replyText, extraSegments);
    }

    await recordFinalResponse(first, replyText, intent, priority, toolCall);
}

async function finalizeUnifiedResponse(
    first: FormattedMessage,
    response: GroupBatchExecutionResult,
    intent: string,
    priority: string,
    emotion?: EmotionResult | null,
): Promise<void> {
    const outgoingText = getOutgoingReplyText(response.text);
    const mergedSegments = await appendAutoMemeSegments(first, outgoingText, response.segments, {
        emotion,
        toolAlreadySentMedia: response.segments.length > 0,
    });
    const replyText = await sendUnifiedReply(first, outgoingText, mergedSegments);
    await recordFinalResponse(first, replyText, intent, priority, response.toolCall, {
        groupBatch: true,
        participantIds: Array.isArray(response.toolCall?.params?.participantIds)
            ? response.toolCall?.params?.participantIds
            : undefined,
    });
}

async function recordFinalResponse(
    first: FormattedMessage,
    replyText: string | undefined,
    intent: string,
    priority: string,
    toolCall?: { tool: string; params: Record<string, unknown>; result?: string; tools?: Array<{ name: string; params: Record<string, unknown> }> },
    rawMeta?: Record<string, unknown>,
): Promise<void> {

    // 获取机器人角色
    let botRole = 'member';
    if (first.group_id && config.botQQ) {
        botRole = await resolveRole(first.group_id, config.botQQ, 'member');
    }

    // 将机器人回复也记录到滑动窗口（包含工具调用记录）
    memory.push({
        message_id: Date.now(),
        time: Math.floor(Date.now() / 1000),
        time_str: new Date().toLocaleString('zh-CN'),
        type: first.type,
        self_id: config.botQQ,
        summary: replyText ? replyText.slice(0, 50) : '[工具执行]',
        sender_id: config.botQQ || 0,
        sender_name: '落落',
        sender_role: botRole as 'member' | 'admin' | 'owner',
        group_id: first.group_id,
        text: replyText || '',
        images: [],
        videos: [],
        records: [],
        at_users: [],
        at_all: false,
        files: [],
        cards: [],
        mface_urls: [],
        toolCall,  // 工具调用记录（如果有）
        raw: rawMeta,
    });

    // 记录响应（用于上下文追踪）
    if (first.group_id) {
        sentry.recordResponse(first.group_id);
    }

    const logSummary = replyText ? `${replyText.slice(0, 50)}...` : '(无文本，已记录工具结果)';
    log.info(`✅ 已回复 [${intent}/${priority}]: ${logSummary}`);
}

/** 处理防抖后的消息 (重构版) */
async function handleDebouncedMessage(debounced: DebouncedMessage): Promise<void> {
    let currentDebounced = debounced;
    let { first, mergedText } = currentDebounced;

    try {
        // 1. 预处理与存储
        const history = await resolveAndStoreMessage(currentDebounced);

        const groupBatchFlow = await maybeHandleGroupMentionBatchFlow(currentDebounced, history);
        if (groupBatchFlow.handled) {
            return;
        }
        if (groupBatchFlow.debouncedMessage) {
            currentDebounced = groupBatchFlow.debouncedMessage;
            first = currentDebounced.first;
            mergedText = currentDebounced.mergedText;
        }

        // 2. 管理员指令
        if (await processAdminCommand(first)) return;

        // 3. 异步分析 (情感/画像/记忆)
        const emotion = await performAnalysis(first, mergedText);

        // 4. 哨兵决策
        const decision = config.agents.sentryEnabled
            ? await sentry.evaluate(first, history, emotion)
            : createSentryDisabledDecision(first);
        log.debug(`哨兵决策: score=${decision.desireScore.toFixed(2)} shouldRespond=${decision.shouldRespond} type=${first.type}`);

        if (!decision.shouldRespond) return;

        // 5. 路由分发 (生成任务计划)
        const planResult = await router.plan({ message: first, history, emotion });
        log.debug(
            `任务计划: goal="${planResult.plan.goal}" needsTool=${planResult.plan.needsTool} `
            + `target=${planResult.target} mode=${planResult.plan.executionMode || 'fast'} `
            + `score=${planResult.plan.complexity?.score ?? 0}`,
        );

        if (config.agents.useTrueReAct && planResult.plan.executionMode === 'react') {
            await handleReactPlanExecution(first, history, emotion, decision);
            return;
        }

        await handleStandardPlanExecution(first, history, planResult.plan, emotion, decision);

    } catch (err) {
        log.error('回复失败:', err);
        try {
            await sendErrorFallbackOnce(first);
        } catch { /* 忽略备用回复失败 */ }
    }
}

/** 主函数 */
async function main(): Promise<void> {
    const webDisabled = ['1', 'true', 'yes', 'on'].includes((process.env.GENESIS_DISABLE_WEB || '').toLowerCase());

    log.info('🚀 Genesis Agent 启动中...');
    log.info(`配置: napcat=${config.napcatWsUrl}, LLM=${config.llm.model}`);
    log.info(`防抖延迟: ${config.debounceDelayMs}ms, 记忆窗口: ${config.memoryWindowSize}`);

    await initializeSharedRuntimeState();

    // 启动定时调度器，确保重启后能恢复任务执行
    startCronScheduler();

    // 启动工具自维护服务，后台巡检失败日志并保守维护普通工具
    toolSelfMaintainer.start();
    toolTestRequestWorker.start();

    // 启动 Web 控制台
    if (webDisabled) {
        log.info('ℹ️ 当前进程已禁用 Web 控制台启动');
    } else {
        startWebServer();
    }

    // 检查 sentra-emo 服务
    if (config.agents.emotionEnabled) {
        sentraEmoAvailable = await checkSentraEmoHealth();
    }
    if (sentraEmoAvailable) {
        log.info('✅ sentra-emo 情感分析服务可用');
    } else {
        log.warn('⚠️ sentra-emo 服务不可用，将跳过情感分析');
    }

    // 连接 napcat
    try {
        await connector.connect();
    } catch (err) {
        log.error('无法连接 napcat:', err);
        log.info('请确保 napcat 已启动并开启消息流服务 (ENABLE_STREAM=true)');
        process.exit(1);
    }

    // 启动 Profiler Agent（后台异步分析）
    if (config.agents.profilerEnabled) {
        void profiler.start();
    }

    // 原始消息 -> 防抖器
    connector.onMessage((msg: FormattedMessage) => {
        const botId = msg.self_id || config.botQQ || 0;
        if (isBotSelfMessage(msg, botId)) {
            log.debug(`🤖 忽略机器人自身回流消息: [${msg.type}] ${msg.sender_name}`);
            return;
        }

        debouncer.push(msg);
    });

    // 防抖后 -> 处理逻辑
    debouncer.onDebounced((msg) => {
        void handleDebouncedMessage(msg);
    });

    // 戳一戳响应
    // connector.onPoke((poke) => {
    //     if (poke.group_id) {
    //         const responses = ['别戳我！', '戳你妹！', '再戳我就咬你！', '痒痒的~', '干嘛戳我？', '有事说话！'];
    //         const reply = responses[Math.floor(Math.random() * responses.length)];
    //         connector.sendGroup(poke.group_id, reply).catch(err => {
    //             log.error('戳一戳回复失败:', err);
    //         });
    //     }
    // });

    log.info('✅ Genesis Agent 已就绪，等待消息...');
    log.info('🛡️ 哨兵模式已启用 - 智能判断响应');

    // 优雅关闭
    const gracefulShutdown = (signal: string): void => {
        log.info(`收到 ${signal}，正在关闭...`);
        debouncer.flushAll();
        connector.disconnect();

        // 保存所有持久化数据
        saveSentryState();
        saveGenesisDbNow();
        toolSelfMaintainer.stop();
        toolTestRequestWorker.stop();
        closeGenesisDb();
        log.close();

        process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

// 启动
main().catch((err) => {
    log.error('启动失败:', err);
    process.exit(1);
});

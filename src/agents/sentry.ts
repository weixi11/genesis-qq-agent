/**
 * 智能哨兵 Agent (Sentry)
 * 
 * 职责：
 * - 24小时监听所有消息
 * - 计算"插话欲望值" (Response Desire Score)
 * - 使用累积机制动态调整欲望值
 * - 达到阈值后调用 LLM 做最终决策
 * 
 * 累积机制：
 * 1. 追问累加：同一用户短时间内多次提问，欲望值递增
 * 2. 被忽略补偿：连续忽略用户N条消息后，自动提升欲望值
 * 3. 话题热度：群内多人讨论时，提高参与意愿
 * 4. 冷却衰减：响应后一段时间内降低响应意愿，避免刷屏
 */

import { config } from '../config.js';
import { log } from '../logger.js';
import { sentryLlm } from '../llm.js';
import { buildSentryJudgePrompt, SENTRY_JUDGE_SYSTEM_PROMPT } from '../prompts/sentry.js';
import { FAVORABILITY_CONFIG, getFavorabilityRelationLevel } from '../utils/favorability.js';
import type { FormattedMessage } from '../types.js';
import type { EmotionResult } from '../emotion.js';
import { getProfile } from '../profiler/store.js';
import { safeParseJson, safeParseLLMJson } from '../utils/json.js';
import { getGenesisDb, markDirty } from '../storage/genesis-db.js';
import { z } from 'zod';

/** 哨兵决策结果 */
export interface SentryDecision {
    shouldRespond: boolean;
    desireScore: number;
    reason: string;
    priority: 'high' | 'normal' | 'low';
    /** LLM 给出的响应建议（如果有） */
    llmAdvice?: string;
}

/** 用户追问状态 */
interface UserState {
    /** 最近发送消息数（累积） */
    messageCount: number;
    /** 被忽略的消息数 */
    ignoredCount: number;
    /** 最后一条消息时间 */
    lastMessageTime: number;
    /** 最近消息是否是问句 */
    lastWasQuestion: boolean;
}

/** 群热度状态 */
interface GroupState {
    /** 最近响应时间 */
    lastResponseTime: number;
    /** 最近活跃用户数 */
    recentActiveUsers: Set<number>;
    /** 最近消息时间 */
    lastMessageTime: number;
    /** 冷却中（刚响应过） */
    cooling: boolean;
}

/** 哨兵配置 */
export interface SentryConfig {
    botQQ?: number;
    botNames: string[];
    /** 基础阈值 */
    threshold: number;
    /** 是否总是响应私聊 */
    alwaysRespondPrivate: boolean;
    /** 是否允许主动插话（关闭后只有被@或提及名字才回复） */
    proactiveResponse: boolean;
    /** 追问累加系数 */
    questionBonus: number;
    /** 被忽略补偿系数 */
    ignoredBonus: number;
    /** 话题热度系数 */
    heatBonus: number;
    /** 冷却惩罚系数 */
    cooldownPenalty: number;
    /** 冷却时间（秒） */
    cooldownSec: number;
    /** 用户状态过期时间（秒） */
    userStateExpireSec: number;
    /** 是否使用 LLM 做最终判断 */
    useLlmJudge: boolean;
    /** LLM 判断阈值（超过此值才调用 LLM） */
    llmJudgeThreshold: number;
}

/**
 * 哨兵决策参数常量
 * 调整这些值来控制机器人的响应倾向
 */
const SENTRY_DEFAULTS = {
    /** 基础响应阈值 - 欲望值超过此值才会响应 */
    THRESHOLD: 0.5,
    /** 追问累加系数 - 每次追问增加的欲望值 */
    QUESTION_BONUS: 0.1,
    /** 被忽略补偿系数 - 每次被忽略增加的欲望值 */
    IGNORED_BONUS: 0.08,
    /** 话题热度系数 - 每个活跃用户增加的欲望值 */
    HEAT_BONUS: 0.05,
    /** 冷却惩罚系数 - 刚响应后减少的欲望值 */
    COOLDOWN_PENALTY: 0.3,
    /** 冷却时间（秒） - 响应后多久内处于冷却状态 */
    COOLDOWN_SEC: 60,
    /** 用户状态过期时间（秒） - 用户多久不活跃后重置状态 */
    USER_STATE_EXPIRE_SEC: 120,
    /** LLM 判断阈值 - 超过此值才调用 LLM 做最终判断 */
    LLM_JUDGE_THRESHOLD: 0.4,
} as const;

const defaultConfig: SentryConfig = {
    botQQ: config.botQQ,
    botNames: (process.env.BOT_NAMES || '小落,落落').split(',').map(s => s.trim()),
    threshold: SENTRY_DEFAULTS.THRESHOLD,
    alwaysRespondPrivate: true,
    proactiveResponse: (process.env.SENTRY_PROACTIVE_RESPONSE?.toLowerCase() ?? 'true') !== 'false',
    questionBonus: SENTRY_DEFAULTS.QUESTION_BONUS,
    ignoredBonus: SENTRY_DEFAULTS.IGNORED_BONUS,
    heatBonus: SENTRY_DEFAULTS.HEAT_BONUS,
    cooldownPenalty: SENTRY_DEFAULTS.COOLDOWN_PENALTY,
    cooldownSec: SENTRY_DEFAULTS.COOLDOWN_SEC,
    userStateExpireSec: SENTRY_DEFAULTS.USER_STATE_EXPIRE_SEC,
    useLlmJudge: true,
    llmJudgeThreshold: SENTRY_DEFAULTS.LLM_JUDGE_THRESHOLD,
};

const sentryJudgeResponseSchema = z.object({
    decision: z.enum(['回复', '忽略']),
    reason: z.string().optional(),
});

// 状态存储
const userStates = new Map<string, UserState>();  // key: `${group_id}:${user_id}`
const groupStates = new Map<number, GroupState>();

// 持久化状态
let sentryDirty = false;
let sentrySaveTimer: NodeJS.Timeout | null = null;
const SENTRY_SAVE_DEBOUNCE_MS = 30000; // 30秒保存一次

/** 标记哨兵状态已变更 */
function markSentryDirty(): void {
    sentryDirty = true;
    if (!sentrySaveTimer) {
        sentrySaveTimer = setTimeout(() => {
            sentrySaveTimer = null;
            saveSentryState();
        }, SENTRY_SAVE_DEBOUNCE_MS);
    }
}

/**
 * 智能哨兵 Agent
 */
export class SentryAgent {
    private config: SentryConfig;

    constructor(cfg?: Partial<SentryConfig>) {
        this.config = { ...defaultConfig, ...cfg };
    }

    /**
     * 评估消息，决定是否响应
     */
    async evaluate(
        msg: FormattedMessage,
        history: FormattedMessage[],
        emotion?: EmotionResult | null
    ): Promise<SentryDecision> {
        const now = Date.now();

        // === 强制响应条件 ===

        // 1. 私聊总是响应
        if (msg.type === 'private' && this.config.alwaysRespondPrivate) {
            return this.createDecision(1.0, '私聊消息', 'high', true);
        }

        // 2. 被 @
        const botId = msg.self_id || this.config.botQQ;
        if (botId && msg.at_users?.includes(botId)) {
            return this.createDecision(1.0, '被@提及', 'high', true);
        }

        // 3. 提及机器人名字
        const textLower = msg.text?.toLowerCase() || '';
        for (const name of this.config.botNames) {
            if (textLower.includes(name.toLowerCase())) {
                return this.createDecision(0.9, `提及"${name}"`, 'high', true);
            }
        }

        const groupState = this.getGroupState(msg.group_id || 0, now);

        // 5. 如果禁用了主动插话，到这里就不响应了
        if (!this.config.proactiveResponse) {
            log.debug('🛡️ 主动插话已禁用，跳过');
            return this.createDecision(0, '主动插话已禁用', 'low', false);
        }

        // === 累积计算 ===
        let score = 0;
        const reasons: string[] = [];

        // 获取/更新用户状态
        const userKey = `${msg.group_id || 0}:${msg.sender_id}`;
        const userState = this.getUserState(userKey, now);
        userState.messageCount++;
        userState.lastMessageTime = now;

        // 更新群状态（groupState 已在上面获取）
        groupState.recentActiveUsers.add(msg.sender_id);
        groupState.lastMessageTime = now;

        // 4. 引用机器人消息 (+60%)
        if (msg.reply && botId && msg.reply.sender_id === botId) {
            score += 0.6;
            reasons.push('引用机器人消息');
        }

        // 5. 问句 (+15%)
        const isQuestion = this.isQuestion(msg.text);
        if (isQuestion) {
            score += 0.15;
            reasons.push('问句');

            // 追问累加：如果用户连续提问
            if (userState.lastWasQuestion && userState.messageCount > 1) {
                const bonus = Math.min(0.3, (userState.messageCount - 1) * this.config.questionBonus);
                score += bonus;
                reasons.push(`追问x${userState.messageCount}`);
            }
        }
        userState.lastWasQuestion = isQuestion;
        markSentryDirty();

        // 6. 被忽略补偿
        if (userState.ignoredCount > 0) {
            const bonus = Math.min(0.25, userState.ignoredCount * this.config.ignoredBonus);
            score += bonus;
            reasons.push(`被忽略${userState.ignoredCount}次`);
        }

        // 7. 情感因素 (+15%)
        if (emotion) {
            if (Math.abs(emotion.arousal) > 0.6) {
                score += 0.1;
                reasons.push('高情绪');
            }
            if (emotion.valence < -0.3) {
                score += 0.05;
                reasons.push('负面');
            }
        }

        // 8. 话题热度
        const activeCount = groupState.recentActiveUsers.size;
        if (activeCount >= 3) {
            const bonus = Math.min(0.15, (activeCount - 2) * this.config.heatBonus);
            score += bonus;
            reasons.push(`热度${activeCount}人`);
        }

        // 9. 冷却衰减
        if (groupState.cooling) {
            const elapsed = now - groupState.lastResponseTime;
            if (elapsed < this.config.cooldownSec * 1000) {
                score -= this.config.cooldownPenalty;
                reasons.push('冷却中');
            } else {
                groupState.cooling = false;
            }
        }

        // 10. @全体 (+20%)
        if (msg.at_all) {
            score += 0.2;
            reasons.push('@全体');
        }

        // 限制在 [0, 1]
        score = Math.min(1, Math.max(0, score));

        const reasonStr = reasons.length > 0 ? reasons.join(', ') : '无明显因素';

        // === 决策逻辑 ===

        // 如果分数低于 LLM 判断阈值，直接拒绝
        if (score < this.config.llmJudgeThreshold) {
            userState.ignoredCount++;
            log.info(`🛡️ 跳过 [${(score * 100).toFixed(0)}%] ${reasonStr}`);
            return this.createDecision(score, reasonStr, 'low', false);
        }

        // 如果分数超过基础阈值，且启用 LLM 判断
        if (this.config.useLlmJudge && score >= this.config.threshold) {
            const llmDecision = await this.llmJudge(msg, history, score, reasonStr);
            if (llmDecision.shouldRespond) {
                // 响应：重置所有累积状态
                userState.ignoredCount = 0;
                userState.messageCount = 0;
                return llmDecision;
            } else {
                // LLM 明确判断不回复：重置追问状态，避免无意义累积
                // 但保留 ignoredCount 作为长期记录（最多累积到上限后不再增加）
                userState.messageCount = 0;  // 打断追问累积
                // ignoredCount 有上限，超过后不再累积，避免最终强制回复
                if (userState.ignoredCount < 5) {
                    userState.ignoredCount++;
                }
                return llmDecision;
            }
        }

        // 分数在中间区间：累积但暂不响应
        if (score >= this.config.llmJudgeThreshold && score < this.config.threshold) {
            userState.ignoredCount++;
            log.info(`🛡️ 观望 [${(score * 100).toFixed(0)}%] ${reasonStr}`);
            return this.createDecision(score, reasonStr, 'normal', false);
        }

        // 达到阈值直接响应（无 LLM 判断时）
        if (score >= this.config.threshold) {
            userState.ignoredCount = 0;
            userState.messageCount = 0;
            log.info(`🛡️ 响应 [${(score * 100).toFixed(0)}%] ${reasonStr}`);
            return this.createDecision(score, reasonStr, score >= 0.7 ? 'high' : 'normal', true);
        }

        userState.ignoredCount++;
        return this.createDecision(score, reasonStr, 'low', false);
    }

    /**
     * 使用 LLM 做最终判断
     */
    private async llmJudge(
        msg: FormattedMessage,
        history: FormattedMessage[],
        score: number,
        reason: string
    ): Promise<SentryDecision> {
        const contextMsgs = (await import('../memory.js')).memory.formatMessages(history);

        // 获取发送者画像
        const profile = getProfile(msg.sender_id);
        const favorability = profile?.favorability ?? 0;
        const isMaster = msg.sender_id === config.masterQQ;

        // 构建画像描述
        let profileInfo = `好感度: ${Math.round(favorability)} (${FAVORABILITY_CONFIG.BASELINE}=中性基线)`;
        if (isMaster) profileInfo += ' [★★★主人★★★]';
        else profileInfo += ` [${getFavorabilityRelationLevel(favorability)}]`;

        if (profile?.traits && profile.traits.length > 0) {
            profileInfo += `\n性格: ${profile.traits.join('、')}`;
        }

        // 详细的媒体消息描述
        let contentDesc = msg.text || '';
        const mediaParts: string[] = [];
        if (msg.images?.length) mediaParts.push(`[图片x${msg.images.length}]`);
        if (msg.videos?.length) mediaParts.push(`[视频]`);
        if (msg.records?.length) mediaParts.push(`[语音]`);
        if (msg.files?.length) mediaParts.push(`[文件]`);
        if (msg.cards?.length) mediaParts.push(`[卡片]`);

        if (mediaParts.length > 0) {
            contentDesc += (contentDesc ? ' ' : '') + mediaParts.join(' ');
        }
        if (!contentDesc) contentDesc = '(无文本内容)';

        const prompt = buildSentryJudgePrompt({
            botNames: this.config.botNames,
            botQQ: this.config.botQQ,
            senderName: msg.sender_name,
            senderId: msg.sender_id,
            contentDesc,
            replyText: msg.reply ? (msg.reply.text?.slice(0, 30) || '...') : undefined,
            profileInfo,
            contextMessages: contextMsgs || '(无)',
            score,
            reason,
        });

        try {
            const response = await sentryLlm.ask(prompt, SENTRY_JUDGE_SYSTEM_PROMPT, 'sentry');

            // 解析 JSON
            let shouldRespond = false;
            let finalReason = reason;

            const rawResponse = safeParseLLMJson<unknown>(response);
            const parsed = sentryJudgeResponseSchema.safeParse(rawResponse);
            if (parsed.success) {
                shouldRespond = parsed.data.decision === '回复';
                finalReason = `${reason} (LLM: ${parsed.data.reason || parsed.data.decision})`;
            } else {
                // 兼容旧格式兜底
                shouldRespond = response.includes('回复');
                finalReason = `${reason} (LLM判定)`;
                if (rawResponse) {
                    log.debug(`Sentry schema 校验失败: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
                }
            }

            if (shouldRespond) {
                log.info(`🛡️ LLM决定响应 [${(score * 100).toFixed(0)}%] ${finalReason}`);
                return this.createDecision(score, finalReason, score >= 0.7 ? 'high' : 'normal', true, response);
            } else {
                log.info(`🛡️ LLM决定忽略 [${(score * 100).toFixed(0)}%] ${finalReason}`);
                return this.createDecision(score, finalReason, 'low', false, response);
            }
        } catch (err) {
            log.warn('LLM 判断失败，使用默认策略:', err);
            // LLM 失败时，如果分数足够高就响应
            const shouldRespond = score >= this.config.threshold;
            return this.createDecision(score, reason, shouldRespond ? 'normal' : 'low', shouldRespond);
        }
    }


    /**
     * 记录已响应
     */
    recordResponse(groupId: number): void {
        const state = this.getGroupState(groupId, Date.now());
        state.lastResponseTime = Date.now();
        state.cooling = true;
        // 清空该群用户状态
        for (const [key] of userStates) {
            if (key.startsWith(`${groupId}:`)) {
                userStates.delete(key);
            }
        }
        markSentryDirty();
    }

    /**
     * 获取用户状态
     */
    private getUserState(key: string, now: number): UserState {
        let state = userStates.get(key);
        if (!state || now - state.lastMessageTime > this.config.userStateExpireSec * 1000) {
            // 如果是过期的旧状态，先删除以防止内存泄漏
            if (state) userStates.delete(key);

            state = {
                messageCount: 0,
                ignoredCount: 0,
                lastMessageTime: now,
                lastWasQuestion: false,
            };
            userStates.set(key, state);
        }
        return state;
    }

    /**
     * 获取群状态
     */
    private getGroupState(groupId: number, now: number): GroupState {
        let state = groupStates.get(groupId);
        if (!state) {
            state = {
                lastResponseTime: 0,
                recentActiveUsers: new Set(),
                lastMessageTime: now,
                cooling: false,
            };
            groupStates.set(groupId, state);
        }
        // 清理过期的活跃用户（使用配置的过期时间）
        if (now - state.lastMessageTime > SENTRY_DEFAULTS.USER_STATE_EXPIRE_SEC * 1000) {
            state.recentActiveUsers.clear();
        }
        return state;
    }

    /**
     * 创建决策结果
     */
    private createDecision(
        score: number,
        reason: string,
        priority: 'high' | 'normal' | 'low',
        shouldRespond: boolean,
        llmAdvice?: string
    ): SentryDecision {
        return { shouldRespond, desireScore: score, reason, priority, llmAdvice };
    }

    /**
     * 判断是否是问句
     */
    private isQuestion(text?: string): boolean {
        if (!text) return false;
        if (text.includes('?') || text.includes('？')) return true;
        const questionWords = ['吗', '呢', '啥', '什么', '怎么', '为什么', '哪', '几', '多少', '是不是', '能不能', '可以吗', '好吗', '有人知道'];
        return questionWords.some(w => text.includes(w));
    }

    updateConfig(cfg: Partial<SentryConfig>): void {
        this.config = { ...this.config, ...cfg };
    }
}

// 全局单例
export const sentry = new SentryAgent();

// ===== 哨兵状态持久化 =====

/** 保存哨兵状态到 SQLite */
export function saveSentryState(): void {
    if (!sentryDirty) return;

    try {
        const db = getGenesisDb();

        // 保存用户状态
        for (const [key, state] of userStates) {
            db.run(
                `INSERT OR REPLACE INTO sentry_user_states (key, message_count, ignored_count, last_message_time, last_was_question)
                 VALUES (?, ?, ?, ?, ?)`,
                [key, state.messageCount, state.ignoredCount, state.lastMessageTime, state.lastWasQuestion ? 1 : 0],
            );
        }

        // 保存群状态
        for (const [groupId, state] of groupStates) {
            db.run(
                `INSERT OR REPLACE INTO sentry_group_states (group_id, last_response_time, recent_active_users, last_message_time, cooling)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    groupId,
                    state.lastResponseTime,
                    JSON.stringify(Array.from(state.recentActiveUsers)),
                    state.lastMessageTime,
                    state.cooling ? 1 : 0,
                ],
            );
        }

        sentryDirty = false;
        markDirty();
        log.debug('💾 哨兵状态已保存');
    } catch (err) {
        log.warn('💾 保存哨兵状态失败:', err);
    }
}

/** 从 SQLite 恢复哨兵状态 */
export function loadSentryState(): void {
    try {
        const db = getGenesisDb();

        // 恢复用户状态
        const userStmt = db.prepare('SELECT * FROM sentry_user_states');
        let userCount = 0;
        while (userStmt.step()) {
            const row = userStmt.getAsObject() as Record<string, unknown>;
            userStates.set(row.key as string, {
                messageCount: row.message_count as number,
                ignoredCount: row.ignored_count as number,
                lastMessageTime: row.last_message_time as number,
                lastWasQuestion: (row.last_was_question as number) === 1,
            });
            userCount++;
        }
        userStmt.free();

        // 恢复群状态
        const groupStmt = db.prepare('SELECT * FROM sentry_group_states');
        let groupCount = 0;
        while (groupStmt.step()) {
            const row = groupStmt.getAsObject() as Record<string, unknown>;
            const parsedActiveUsers = safeParseJson(String(row.recent_active_users || '[]'));
            const activeUsers = Array.isArray(parsedActiveUsers)
                ? parsedActiveUsers.filter((item): item is number => typeof item === 'number')
                : [];
            groupStates.set(row.group_id as number, {
                lastResponseTime: row.last_response_time as number,
                recentActiveUsers: new Set(activeUsers),
                lastMessageTime: row.last_message_time as number,
                cooling: (row.cooling as number) === 1,
            });
            groupCount++;
        }
        groupStmt.free();

        log.info(`💾 恢复哨兵状态: ${userCount} 用户, ${groupCount} 群`);
    } catch (err) {
        log.warn('💾 恢复哨兵状态失败:', err);
    }
}

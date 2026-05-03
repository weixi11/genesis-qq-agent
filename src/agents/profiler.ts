/**
 * Profiler Agent (侧写师)
 * 
 * 职责：
 * - 异步分析用户消息
 * - 提取性格标签和兴趣爱好
 * - 使用 LLM 判断好感度变化
 * - 维护用户画像
 * 
 * 改进：
 * - 利用群聊上下文提高分析准确度
 * - LLM 判断好感度（替代简单关键词）
 * - 移除硬编码关键词算法
 */

import { log } from '../logger.js';
import { profilerLlm } from '../llm.js';
import { buildProfilerAnalyzePrompt, PROFILER_ANALYZE_SYSTEM_PROMPT } from '../prompts/profiler.js';
import type { AnalysisMessage, AnalysisResult, UserProfile } from '../types.js';
import {
    getOrCreateProfile,
    updateProfile,
    adjustFavorability,
    addTraits,
    addInterests,
    addProfileEvidence,
    addProfileMemories,
    saveProfilesAsync,
} from '../profiler/store.js';
import { setAnalyzeCallback, startWorker, stopWorker } from '../profiler/queue.js';
import {
    claimPendingProfilerReanalyzeRequest,
    completeProfilerReanalyzeRequest,
} from '../profiler/reanalyze_request_store.js';
import { safeParseLLMJson } from '../utils/json.js';
import { z } from 'zod';

const profileMemoryInputSchema = z.object({
    summary: z.string().trim().min(1),
    detail: z.string().optional(),
    importance: z.coerce.number().min(1).max(5).optional(),
    sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
    happenedAt: z.coerce.number().optional(),
    status: z.enum(['active', 'resolved', 'lingering']).optional(),
});

const analysisResultSchema = z.object({
    userId: z.number().optional(),
    newTraits: z.array(z.string()).optional(),
    newInterests: z.array(z.string()).optional(),
    identityFacts: z.array(z.string()).optional(),
    likes: z.array(z.string()).optional(),
    dislikes: z.array(z.string()).optional(),
    redLines: z.array(z.string()).optional(),
    emotionPatterns: z.array(z.string()).optional(),
    emotionalTriggers: z.array(z.string()).optional(),
    calmingSignals: z.array(z.string()).optional(),
    relationshipNotes: z.array(z.string()).optional(),
    boundaryNotes: z.array(z.string()).optional(),
    importantMemories: z.array(profileMemoryInputSchema).optional(),
    conflictRecords: z.array(profileMemoryInputSchema).optional(),
    favorabilityDelta: z.coerce.number().optional(),
    mood: z.enum(['positive', 'neutral', 'negative']).optional(),
    notes: z.string().optional(),
});

type ProfileAnalysisDelta = Omit<AnalysisResult, 'userId'>;

const PROFILE_EVIDENCE_SECTIONS = [
    'identityFacts',
    'likes',
    'dislikes',
    'redLines',
    'emotionPatterns',
    'emotionalTriggers',
    'calmingSignals',
    'relationshipNotes',
    'boundaryNotes',
] as const;
const REANALYZE_REQUEST_POLL_MS = 1000;

function dedupeTextList(values: string[] | undefined): string[] {
    if (!values || values.length === 0) {
        return [];
    }

    return Array.from(new Set(
        values
            .map((value) => value.trim())
            .filter(Boolean),
    ));
}

function buildProfileSnapshot(profile: UserProfile): string {
    const sections: Array<[string, string[]]> = [
        ['现有性格标签', profile.traits],
        ['现有兴趣爱好', profile.interests],
        ['基础身份事实', profile.identityFacts],
        ['明确偏好', profile.likes],
        ['明显反感', profile.dislikes],
        ['雷区边界', profile.redLines],
        ['情绪机制', profile.emotionPatterns],
        ['情绪触发点', profile.emotionalTriggers],
        ['安抚方式', profile.calmingSignals],
        ['关系线索', profile.relationshipNotes],
        ['边界提醒', profile.boundaryNotes],
    ];

    const lines = sections
        .filter(([, values]) => values.length > 0)
        .map(([label, values]) => `- ${label}: ${values.join('、')}`);

    if (profile.importantMemories.length > 0) {
        lines.push(`- 重要记忆: ${profile.importantMemories.slice(0, 3).map((item) => item.summary).join('；')}`);
    }

    if (profile.conflictRecords.length > 0) {
        lines.push(`- 冲突记录: ${profile.conflictRecords.slice(0, 2).map((item) => item.summary).join('；')}`);
    }

    return lines.join('\n');
}

/**
 * Profiler Agent
 */
export class ProfilerAgent {
    private reanalyzeRequestTimer: NodeJS.Timeout | null = null;
    private processingQueuedRequests = false;

    /**
     * 初始化并启动
     */
    start(): void {
        // 注册分析回调
        setAnalyzeCallback(this.analyzeBatch.bind(this));

        // 启动队列 worker
        startWorker();
        this.startReanalyzeRequestWorker();

        log.info('📊 Profiler Agent 已启动');
    }

    /**
     * 停止
     */
    stop(): void {
        stopWorker();
        if (this.reanalyzeRequestTimer) {
            clearInterval(this.reanalyzeRequestTimer);
            this.reanalyzeRequestTimer = null;
        }
        log.info('📊 Profiler Agent 已停止');
    }

    /**
     * 手动重分析一组消息（用于 Web 运维入口）
     */
    async reanalyzeMessages(messages: AnalysisMessage[]): Promise<void> {
        if (messages.length === 0) {
            return;
        }

        const grouped = new Map<number, AnalysisMessage[]>();
        for (const message of messages) {
            const current = grouped.get(message.userId) || [];
            current.push(message);
            grouped.set(message.userId, current);
        }

        await this.analyzeBatch(grouped);
    }

    private startReanalyzeRequestWorker(): void {
        if (this.reanalyzeRequestTimer) {
            return;
        }

        this.reanalyzeRequestTimer = setInterval(() => {
            void this.processQueuedReanalyzeRequests();
        }, REANALYZE_REQUEST_POLL_MS);
        this.reanalyzeRequestTimer.unref?.();

        void this.processQueuedReanalyzeRequests();
    }

    private async processQueuedReanalyzeRequests(): Promise<void> {
        if (this.processingQueuedRequests) {
            return;
        }

        this.processingQueuedRequests = true;
        try {
            while (true) {
                const request = await claimPendingProfilerReanalyzeRequest();
                if (!request) {
                    break;
                }

                try {
                    await this.reanalyzeMessages(request.messages);
                    await completeProfilerReanalyzeRequest(request.requestId, {
                        status: 'success',
                        analyzedCount: request.messages.length,
                    });
                } catch (error) {
                    await completeProfilerReanalyzeRequest(request.requestId, {
                        status: 'failed',
                        analyzedCount: request.messages.length,
                        errorMessage: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        } finally {
            this.processingQueuedRequests = false;
        }
    }

    /**
     * 批量分析用户消息
     */
    private async analyzeBatch(messages: Map<number, AnalysisMessage[]>): Promise<void> {
        for (const [userId, userMessages] of messages) {
            try {
                await this.analyzeUser(userId, userMessages);
            } catch (err) {
                log.error(`分析用户 ${userId} 失败:`, err);
            }
        }

        // 异步保存结果
        // 同步保存（SQLite 模式下是即时的）
        saveProfilesAsync();
    }

    /**
     * 合并连续消息
     */
    private mergeConsecutiveMessages(messages: AnalysisMessage[]): AnalysisMessage[] {
        if (messages.length === 0) return [];

        const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
        const merged: AnalysisMessage[] = [];
        let lastMsg = { ...sorted[0] };

        for (let i = 1; i < sorted.length; i++) {
            const currMsg = sorted[i];
            // 如果间隔小于 5 秒，合并文本
            if (currMsg.timestamp - lastMsg.timestamp < 5000) {
                lastMsg.text += `\n${currMsg.text}`;
                // 保留较强的情感分数
                if (currMsg.emotion && lastMsg.emotion) {
                    if (Math.abs(currMsg.emotion.valence) > Math.abs(lastMsg.emotion.valence)) {
                        lastMsg.emotion = currMsg.emotion;
                    }
                } else if (currMsg.emotion) {
                    lastMsg.emotion = currMsg.emotion;
                }
                // 保留最后一条的上下文
                lastMsg.context = currMsg.context;
            } else {
                merged.push(lastMsg);
                lastMsg = { ...currMsg };
            }
        }
        merged.push(lastMsg);
        return merged;
    }

    /**
     * 分析单个用户的消息
     */
    private async analyzeUser(userId: number, messages: AnalysisMessage[]): Promise<void> {
        if (messages.length === 0) return;

        const nickname = messages[0].nickname;
        const profile = getOrCreateProfile(userId, nickname);

        // === 预处理：合并短时间内的连续消息（减少 Token 消耗）===
        const mergedMessages = this.mergeConsecutiveMessages(messages);

        log.debug(`📊 分析用户: ${nickname} (${messages.length} 条消息 -> 合并为 ${mergedMessages.length} 条)`);

        // 计算基础情感得分（来自 sentra-emo）
        let avgEmotionScore = 0;
        let emotionCount = 0;
        for (const msg of mergedMessages) {
            if (msg.emotion) {
                avgEmotionScore += msg.emotion.valence;
                emotionCount++;
            }
        }
        if (emotionCount > 0) {
            avgEmotionScore /= emotionCount;
        }

        // 调用 LLM 分析（包含好感度判断）
        const llmResult = await this.llmAnalyze(
            nickname,
            mergedMessages,  // 使用合并后的消息
            profile,
        );

        if (llmResult) {
            // 添加新发现的特征
            if (llmResult.newTraits && llmResult.newTraits.length > 0) {
                addTraits(userId, llmResult.newTraits);
                log.debug(`📊 新增性格标签: ${llmResult.newTraits.join(', ')}`);
            }

            if (llmResult.newInterests && llmResult.newInterests.length > 0) {
                addInterests(userId, llmResult.newInterests);
                log.debug(`📊 新增兴趣爱好: ${llmResult.newInterests.join(', ')}`);
            }

            for (const section of PROFILE_EVIDENCE_SECTIONS) {
                const values = dedupeTextList(llmResult[section]);
                if (values.length > 0) {
                    addProfileEvidence(userId, section, values);
                    log.debug(`📊 更新长期画像 ${section}: ${values.join(', ')}`);
                }
            }

            if (llmResult.importantMemories && llmResult.importantMemories.length > 0) {
                addProfileMemories(userId, 'importantMemories', llmResult.importantMemories);
            }

            if (llmResult.conflictRecords && llmResult.conflictRecords.length > 0) {
                addProfileMemories(userId, 'conflictRecords', llmResult.conflictRecords);
            }

            // 更新情绪和备注
            if (llmResult.mood || llmResult.notes) {
                updateProfile(userId, {
                    mood: llmResult.mood || profile.mood,
                    notes: llmResult.notes,
                });
            }

            // 使用 LLM 判断的好感度变化（代替关键词算法）
            const llmFavDelta = llmResult.favorabilityDelta ?? 0;

            // 综合计算好感度：情感分析 + LLM 判断
            // LLM 的权重更高，因为它理解上下文
            const frequencyBonus = Math.min(0.5, messages.length * 0.1);
            adjustFavorability(
                userId,
                avgEmotionScore,  // 情感得分 (-1 ~ 1)
                llmFavDelta,      // LLM 判断的好感度变化 (替代关键词)
                frequencyBonus    // 互动频率微调
            );
        }

        // 更新分析时间
        updateProfile(userId, { lastAnalyzed: Date.now() });
    }

    /**
     * 使用 LLM 分析用户特征（包含上下文和好感度判断）
     */
    private async llmAnalyze(
        nickname: string,
        messages: AnalysisMessage[],
        profile: UserProfile,
    ): Promise<ProfileAnalysisDelta | null> {
        // 构建消息文本（包含上下文）
        const messagesWithContext = messages.map(m => {
            let text = `[${nickname}]: ${m.text}`;

            // 如果有上下文，添加在前面（只取最近3条）
            if (m.context && m.context.length > 0) {
                const ctx = m.context.slice(-3).map(c => `  [${c.sender}]: ${c.text}`).join('\n');
                text = `上下文:\n${ctx}\n目标发言:\n${text}`;
            }

            return text;
        }).join('\n\n---\n\n');

        const prompt = buildProfilerAnalyzePrompt({
            nickname,
            messagesWithContext,
            existingProfileSnapshot: buildProfileSnapshot(profile),
        });

        try {
            const response = await profilerLlm.ask(prompt, PROFILER_ANALYZE_SYSTEM_PROMPT, 'profiler_analyze');

            const rawResult = safeParseLLMJson<unknown>(response);
            const parsed = analysisResultSchema.safeParse(rawResult);
            if (parsed.success) {
                const { userId: _userId, ...result } = parsed.data;
                // 确保 favorabilityDelta 在合理范围内
                if (typeof result.favorabilityDelta === 'number') {
                    result.favorabilityDelta = Math.max(-5, Math.min(5, result.favorabilityDelta));
                }

                return result;
            }

            if (rawResult) {
                log.debug(`Profiler schema 校验失败: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
            }
        } catch (err) {
            log.debug('LLM 分析失败:', err);
        }

        return null;
    }
}

// 全局单例
export const profiler = new ProfilerAgent();

/**
 * 统一上下文构建服务
 * 
 * 功能:
 * - 构建完整的 Agent 上下文（消息、历史、用户画像、情绪、任务、工具）
 * - 提供情绪描述和回复策略生成
 * - 提供关系等级描述
 * - 为 Persona 润色提供格式化方法
 */

import { config } from '../config.js';
import { getProfileAsync } from '../profiler/store.js';
import type { FormattedMessage, TaskPlan } from '../types.js';
import type { EmotionResult } from '../emotion.js';
import { FAVORABILITY_CONFIG, getFavorabilityRelationLevel } from '../utils/favorability.js';

// ==========================================
// 类型定义
// ==========================================

/** 关系等级 */
export type RelationLevel = '主人' | '老朋友' | '好朋友' | '熟人' | '新朋友';

/** 格式化后的用户画像 */
export interface FormattedUserProfile {
    /** QQ号 */
    userId: number;
    /** 昵称 */
    nickname: string;
    /** 好感度 0-100 */
    favorability: number;
    /** 关系等级描述 */
    relationLevel: RelationLevel;
    /** 性格特征 */
    traits: string[];
    /** 兴趣爱好 */
    interests: string[];
    /** 基础身份事实 */
    identityFacts: string[];
    /** 明确偏好 */
    likes: string[];
    /** 明确反感 */
    dislikes: string[];
    /** 雷区与边界 */
    redLines: string[];
    /** 情绪机制 */
    emotionPatterns: string[];
    /** 情绪触发因素 */
    emotionalTriggers: string[];
    /** 更容易被安抚的方式 */
    calmingSignals: string[];
    /** 关系推进线索 */
    relationshipNotes: string[];
    /** 相处边界 */
    boundaryNotes: string[];
    /** 重要记忆摘要 */
    importantMemories: string[];
    /** 冲突/摩擦摘要 */
    conflictRecords: string[];
    /** 当前情绪 */
    mood?: string;
    /** 是否是主人 */
    isMaster: boolean;
}

/** 格式化后的情绪上下文 */
export interface FormattedEmotion {
    /** 原始数据 */
    raw: EmotionResult;
    /** 情绪效价 */
    valence: number;
    /** 情绪唤醒度 */
    arousal: number;
    /** 人类可读的情绪描述 */
    description: string;
    /** 回复策略建议 */
    responseStrategy: string;
}

/** 任务上下文（从 Router 传递） */
export interface TaskContext {
    /** 用户目标 */
    goal: string;
    /** 规划理由 */
    reasoning: string;
    /** 表达风格建议 */
    speakStyle?: string;
    /** 完整计划（可选） */
    plan?: TaskPlan;
}

/** 工具执行上下文 */
export interface ToolContext {
    /** 工具名称 */
    toolName: string;
    /** 多工具时的所有工具名称 */
    toolNames?: string[];
    /** 工具参数 */
    params: Record<string, unknown>;
    /** 工具执行结果 */
    result: string;
    /** 是否成功 */
    success: boolean;
    /** 意图描述（自然语言） */
    intentDescription: string;
}

/** 完整的 Agent 上下文 */
export interface AgentContext {
    // ===== 基础信息 =====
    /** 当前消息 */
    message: FormattedMessage;
    /** 历史消息列表 */
    history: FormattedMessage[];
    /** 格式化后的历史文本 */
    historyFormatted: string;

    // ===== 用户相关 =====
    /** 发送者画像 */
    userProfile?: FormattedUserProfile;
    /** 被 @ 用户的画像列表 */
    atUserProfiles?: FormattedUserProfile[];

    // ===== 情绪与情感 =====
    /** 格式化后的情绪上下文 */
    emotion?: FormattedEmotion;

    // ===== 任务规划（润色时使用） =====
    /** 任务上下文 */
    taskContext?: TaskContext;

    // ===== 工具执行上下文 =====
    /** 工具上下文 */
    toolContext?: ToolContext;

    // ===== 知识与媒体 =====
    /** RAG 知识库结果 */
    knowledge?: string;
    /** 会话媒体记录 */
    mediaContext?: string;
}

/** 上下文构建选项 */
export interface ContextBuildOptions {
    /** 是否包含历史记录（默认 true） */
    includeHistory?: boolean;
    /** 历史消息最大条数 */
    maxHistoryCount?: number;
    /** 是否包含用户画像（默认 true） */
    includeProfile?: boolean;
    /** 是否包含知识库（默认 false） */
    includeKnowledge?: boolean;
    /** 是否包含媒体上下文（默认 false） */
    includeMedia?: boolean;
    /** 原始情绪数据 */
    emotion?: EmotionResult | null;
    /** 任务计划（从 Router 传递） */
    taskPlan?: TaskPlan;
    /** 工具执行结果 */
    toolResult?: {
        toolName: string;
        toolNames?: string[];
        params: Record<string, unknown>;
        result: string;
        success: boolean;
    };
}

// ==========================================
// 常量配置
// ==========================================

/** 情绪阈值配置 */
const EMOTION_THRESHOLDS = {
    /** 高正面情绪阈值 */
    POSITIVE_HIGH: 0.5,
    /** 正面情绪阈值 */
    POSITIVE: 0.2,
    /** 负面情绪阈值 */
    NEGATIVE: -0.2,
    /** 高负面情绪阈值 */
    NEGATIVE_HIGH: -0.5,
    /** 高唤醒阈值 */
    AROUSAL_HIGH: 0.6,
} as const;

// ==========================================
// ContextBuilder 类
// ==========================================

class ContextBuilder {
    /**
     * 构建完整的 Agent 上下文
     */
    build(
        msg: FormattedMessage,
        history: FormattedMessage[],
        options: ContextBuildOptions = {}
    ): AgentContext {
        const context: AgentContext = {
            message: msg,
            history,
            historyFormatted: this.formatHistory(history, options.maxHistoryCount),
        };

        // 构建用户画像
        if (options.includeProfile !== false) {
            context.userProfile = this.buildUserProfile(msg.sender_id, msg.sender_name);

            // 构建被 @ 用户画像
            if (msg.at_users && msg.at_users.length > 0) {
                context.atUserProfiles = msg.at_users
                    .map(userId => this.buildUserProfile(userId))
                    .filter((p): p is FormattedUserProfile => p !== undefined);
            }
        }

        // 构建情绪上下文
        if (options.emotion) {
            context.emotion = this.formatEmotion(options.emotion);
        }

        // 构建任务上下文
        if (options.taskPlan) {
            context.taskContext = {
                goal: options.taskPlan.goal,
                reasoning: options.taskPlan.reasoning || '',
                speakStyle: options.taskPlan.speakStyle,
                plan: options.taskPlan,
            };
        }

        // 构建工具上下文
        if (options.toolResult) {
            context.toolContext = {
                ...options.toolResult,
                intentDescription: this.generateIntentDescription(
                    options.taskPlan?.goal,
                    options.toolResult.toolName,
                    context.emotion
                ),
            };
        }

        return context;
    }

    /**
     * 格式化历史消息
     */
    private formatHistory(history: FormattedMessage[], maxCount?: number): string {
        const count = maxCount ?? 10;
        const recent = history.slice(-count);

        if (recent.length === 0) return '(无历史记录)';

        return recent.map(m => {
            const sender = m.sender_id === config.botQQ ? '落落' : m.sender_name;
            const text = m.text?.slice(0, 100) || '(媒体消息)';
            return `[${sender}]: ${text}`;
        }).join('\n');
    }

    /**
     * 构建用户画像
     */
    private buildUserProfile(userId: number, nickname?: string): FormattedUserProfile | undefined {
        const profile = getProfileAsync(userId);
        const isMaster = userId === config.masterQQ;

        if (!profile && !isMaster) {
            return nickname ? {
                userId,
                nickname,
                favorability: FAVORABILITY_CONFIG.BASELINE,
                relationLevel: '新朋友',
                traits: [],
                interests: [],
                identityFacts: [],
                likes: [],
                dislikes: [],
                redLines: [],
                emotionPatterns: [],
                emotionalTriggers: [],
                calmingSignals: [],
                relationshipNotes: [],
                boundaryNotes: [],
                importantMemories: [],
                conflictRecords: [],
                isMaster: false,
            } : undefined;
        }

        const favorability = profile?.favorability ?? FAVORABILITY_CONFIG.BASELINE;

        return {
            userId,
            nickname: profile?.nickname || nickname || String(userId),
            favorability,
            relationLevel: isMaster ? '主人' : this.getRelationLevel(favorability),
            traits: profile?.traits || [],
            interests: profile?.interests || [],
            identityFacts: profile?.identityFacts || [],
            likes: profile?.likes || [],
            dislikes: profile?.dislikes || [],
            redLines: profile?.redLines || [],
            emotionPatterns: profile?.emotionPatterns || [],
            emotionalTriggers: profile?.emotionalTriggers || [],
            calmingSignals: profile?.calmingSignals || [],
            relationshipNotes: profile?.relationshipNotes || [],
            boundaryNotes: profile?.boundaryNotes || [],
            importantMemories: profile?.importantMemories?.slice(0, 3).map((item) => item.summary) || [],
            conflictRecords: profile?.conflictRecords?.slice(0, 2).map((item) => item.summary) || [],
            mood: profile?.mood,
            isMaster,
        };
    }

    /**
     * 根据好感度获取关系等级
     */
    private getRelationLevel(favorability: number): RelationLevel {
        return getFavorabilityRelationLevel(favorability);
    }

    /**
     * 格式化情绪数据
     */
    formatEmotion(emotion: EmotionResult): FormattedEmotion {
        return {
            raw: emotion,
            valence: emotion.valence,
            arousal: emotion.arousal,
            description: this.describeEmotion(emotion),
            responseStrategy: this.getEmotionStrategy(emotion),
        };
    }

    /**
     * 生成情绪描述（自然语言）
     */
    private describeEmotion(emotion: EmotionResult): string {
        const { valence, arousal } = emotion;
        const parts: string[] = [];

        // 情绪效价描述
        if (valence > EMOTION_THRESHOLDS.POSITIVE_HIGH) {
            parts.push('非常开心愉快');
        } else if (valence > EMOTION_THRESHOLDS.POSITIVE) {
            parts.push('心情不错');
        } else if (valence < EMOTION_THRESHOLDS.NEGATIVE_HIGH) {
            parts.push('情绪很低落，可能很伤心或沮丧');
        } else if (valence < EMOTION_THRESHOLDS.NEGATIVE) {
            parts.push('情绪有些低落');
        } else {
            parts.push('情绪平稳');
        }

        // 唤醒度描述
        if (arousal > EMOTION_THRESHOLDS.AROUSAL_HIGH) {
            if (valence > 0) {
                parts.push('很兴奋激动');
            } else {
                parts.push('情绪比较激动或焦虑');
            }
        }

        // 添加具体情绪标签（如果有）
        if (emotion.emotions && emotion.emotions.length > 0) {
            const topEmotions = emotion.emotions.slice(0, 2).map(e => e.label);
            parts.push(`表现出${topEmotions.join('、')}的情绪`);
        }

        return `用户${parts.join('，')}`;
    }

    /**
     * 生成回复策略建议
     */
    private getEmotionStrategy(emotion: EmotionResult): string {
        const { valence, arousal } = emotion;

        if (valence < EMOTION_THRESHOLDS.NEGATIVE_HIGH) {
            return '给予安慰和陪伴，表达理解和关心，不要急于解决问题';
        }
        if (valence < EMOTION_THRESHOLDS.NEGATIVE) {
            return '用温柔关心的语气，适当表达关心';
        }
        if (valence > EMOTION_THRESHOLDS.POSITIVE_HIGH && arousal > EMOTION_THRESHOLDS.AROUSAL_HIGH) {
            return '用同样开心的语气回应，分享用户的快乐';
        }
        if (valence > EMOTION_THRESHOLDS.POSITIVE) {
            return '保持轻松愉快的对话氛围';
        }

        return '正常对话即可';
    }

    /**
     * 生成工具执行意图描述
     */
    private generateIntentDescription(
        goal?: string,
        toolName?: string,
        emotion?: FormattedEmotion
    ): string {
        // 根据情绪状态添加前缀
        let prefix = '';
        if (emotion && emotion.valence < EMOTION_THRESHOLDS.NEGATIVE) {
            prefix = '我知道你现在心情不太好，所以';
        } else if (emotion && emotion.valence > EMOTION_THRESHOLDS.POSITIVE_HIGH) {
            prefix = '看到你这么开心，';
        }

        // 使用目标或工具名生成描述
        const action = goal || `帮你使用${toolName}`;
        return `${prefix}${action}`;
    }

    /**
     * 为 enhanceToolResult 生成增强的 System Prompt 片段
     */
    formatForEnhance(context: AgentContext): {
        emotionSection: string;
        taskSection: string;
        intentSection: string;
        strategyHint: string;
    } {
        const result = {
            emotionSection: '',
            taskSection: '',
            intentSection: '',
            strategyHint: '',
        };

        // 情绪部分
        if (context.emotion) {
            result.emotionSection = `
## 用户情绪状态
${context.emotion.description}`;
            result.strategyHint = `\n回复策略: ${context.emotion.responseStrategy}`;
        }

        // 任务背景部分
        if (context.taskContext) {
            const { goal, reasoning } = context.taskContext;
            result.taskSection = `
## 任务背景
你决定${goal}${reasoning ? `\n原因: ${reasoning}` : ''}`;
        }

        // 意图描述部分
        if (context.toolContext) {
            result.intentSection = context.toolContext.intentDescription;
        }

        return result;
    }
}

// 全局单例
export const contextBuilder = new ContextBuilder();

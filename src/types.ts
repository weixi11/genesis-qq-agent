/**
 * 消息类型定义
 * 与 napcat stream.ts 中的 FormattedMessage 对应
 */

import { FAVORABILITY_CONFIG } from './utils/favorability.js';

/** napcat 推送的格式化消息 */
export interface FormattedMessage {
    message_id: number;
    time: number;
    time_str: string;
    type: 'private' | 'group';
    self_id?: number;
    summary: string;
    objective?: string;

    // 发送者信息
    sender_id: number;
    sender_name: string;
    sender_card?: string;
    sender_role?: 'owner' | 'admin' | 'member';

    // 群信息
    group_id?: number;
    group_name?: string;

    // 消息内容
    text: string;

    // 媒体资源
    // 注意：运行时可能包含对象结构，但在 types.ts 中通常定义为 string[] 或对象数组
    // 为了兼容 tech.ts 中的处理逻辑，这里定义为宽泛的联合类型，历史上也做过不少运行时兜底
    // 最佳实践：定义准确的结构
    images: Array<string | { path?: string; file?: string; url?: string }>;
    videos: Array<string | { path?: string; file?: string; url?: string }>;
    records: Array<string | { path?: string; file?: string; url?: string }>;

    reply?: {
        message_id: number;
        sender_id: number;
        sender_name?: string;
        text?: string;
        time?: number;  // 被引用消息的时间戳（秒）
        media?: {
            images?: Array<{ file?: string; url?: string; path?: string }>;
            videos?: Array<{ file?: string; url?: string; path?: string }>;
            files?: Array<{ name?: string; url?: string; path?: string }>;
            records?: Array<{ file?: string; url?: string; path?: string }>;
        };
    };

    // at 信息 (注意：napcat 使用 at_users)
    at_users: number[];
    at_all: boolean;
    at_users_details?: Array<{ id: number; name: string; card?: string; role?: 'owner' | 'admin' | 'member'; }>;

    // 文件/卡片/表情
    files: Array<{
        type: 'file' | 'video' | 'record';
        name?: string;
        file?: string;
        url?: string;
        path?: string;
        file_size?: string | number;
    }>;
    cards: Array<{
        type: string;
        title?: string;
        desc?: string;
        data?: unknown;
        url?: string;
    }>;

    forwards?: Array<{ id: string; name: string }>;
    faces?: Array<{ id: string; text?: string }>;
    mface_urls: string[];

    /** 工具调用记录（机器人消息专用，用于上下文透传） */
    toolCall?: {
        /** 主工具名称（单工具时使用，多工具时为第一个工具名） */
        tool: string;
        /** 合并后的工具参数（单工具时使用，多工具时可能有参数覆盖） */
        params: Record<string, unknown>;
        /** 工具执行结果摘要 */
        result?: string;
        /** 多工具调用记录（每个工具独立记录名称和参数） */
        tools?: Array<{
            /** 工具名称 */
            name: string;
            /** 工具参数 */
            params: Record<string, unknown>;
        }>;
    };

    // 原始数据
    raw?: Record<string, unknown>;
}

/** 戳一戳通知 */
export interface PokeNotice {
    event_type: 'poke';
    target_id: number;
    target_name?: string;
    sender_id?: number;
    sender_name?: string;
    group_id?: number;
}

/**
 * NapCat 机器人事件 (WebSocket 消息)
 */
export type BotMessageEvent =
    | { type: 'message'; data: FormattedMessage | PokeNotice }
    | { type: 'result'; requestId: string; ok: boolean; data?: unknown; error?: string }
    | { type: 'welcome'; message: string };

/** napcat WebSocket 推送的消息格式 (Legacy) */
export interface StreamMessage {
    type: 'message' | 'rpc_result';
    data: FormattedMessage | PokeNotice | Record<string, unknown>;
}

/** RPC 请求格式 */
export interface RpcRequest {
    type: 'rpc';
    id: string;
    method: string;
    params: unknown[];
}

/** RPC 响应格式 */
export interface RpcResponse {
    type: 'rpc_result';
    id: string;
    ok: boolean;
    data?: unknown;
    error?: string;
}

/** 带上下文的消息（经过感知层处理后） */
export interface MessageContext {
    message: FormattedMessage;
    // 滑动窗口记忆
    history: FormattedMessage[];
    // 情感分析结果（后续集成 sentra-emo）
    emotion?: {
        valence: number;
        arousal: number;
        dominance: number;
    };
}

// ==========================================
// Profiler / UserProfile Types
// ==========================================

export type ProfileEvidenceSource = 'llm' | 'manual' | 'legacy';

export type FavorabilityEventSource = 'profiler' | 'manual' | 'system';
export type FavorabilityEventReason = 'analysis' | 'manual_edit' | 'import';

export interface FavorabilityEvent {
    timestamp: number;
    delta: number;
    before: number;
    after: number;
    source: FavorabilityEventSource;
    reason: FavorabilityEventReason;
    note?: string;
}

export interface ProfileTagEvidence {
    value: string;
    score: number;
    lastSeen: number;
    count: number;
    source: ProfileEvidenceSource;
}

export type ProfileMemorySentiment = 'positive' | 'neutral' | 'negative';
export type ProfileConflictStatus = 'active' | 'resolved' | 'lingering';

export interface ProfileMemoryEntry {
    summary: string;
    detail?: string;
    importance: number;
    sentiment: ProfileMemorySentiment;
    happenedAt: number;
    lastSeen: number;
    count: number;
    source: ProfileEvidenceSource;
    status?: ProfileConflictStatus;
}

export interface ProfileMemoryInput {
    summary: string;
    detail?: string;
    importance?: number;
    sentiment?: ProfileMemorySentiment;
    happenedAt?: number;
    status?: ProfileConflictStatus;
}

/** 用户画像 */
export interface UserProfile {
    /** QQ号 */
    userId: number;
    /** 昵称 */
    nickname: string;

    // === 基础信息 ===
    /** 推断性别 */
    gender?: 'male' | 'female' | 'unknown';
    /** 年龄段 */
    ageRange?: string;

    // === 性格标签 ===
    /** 性格特征 */
    traits: string[];
    /** 性格标签证据 */
    traitEvidence: ProfileTagEvidence[];

    // === 兴趣爱好 ===
    /** 兴趣列表 */
    interests: string[];
    /** 兴趣证据 */
    interestEvidence: ProfileTagEvidence[];

    // === 长期人物档案 ===
    /** 基础身份事实 */
    identityFacts: string[];
    /** 基础身份证据 */
    identityEvidence: ProfileTagEvidence[];
    /** 明确喜欢的内容/相处方式 */
    likes: string[];
    /** 喜好证据 */
    likeEvidence: ProfileTagEvidence[];
    /** 明确不喜欢的内容/相处方式 */
    dislikes: string[];
    /** 雷点/反感证据 */
    dislikeEvidence: ProfileTagEvidence[];
    /** 明确边界与雷区 */
    redLines: string[];
    /** 红线证据 */
    redLineEvidence: ProfileTagEvidence[];
    /** 情绪表达模式 */
    emotionPatterns: string[];
    /** 情绪模式证据 */
    emotionPatternEvidence: ProfileTagEvidence[];
    /** 容易触发情绪的因素 */
    emotionalTriggers: string[];
    /** 触发因素证据 */
    emotionalTriggerEvidence: ProfileTagEvidence[];
    /** 更容易被安抚/接住的方式 */
    calmingSignals: string[];
    /** 安抚信号证据 */
    calmingSignalEvidence: ProfileTagEvidence[];
    /** 关系推进线索 */
    relationshipNotes: string[];
    /** 关系线索证据 */
    relationshipNoteEvidence: ProfileTagEvidence[];
    /** 边界与相处禁忌 */
    boundaryNotes: string[];
    /** 边界证据 */
    boundaryNoteEvidence: ProfileTagEvidence[];
    /** 重要对话与事件记忆 */
    importantMemories: ProfileMemoryEntry[];
    /** 关系冲突/摩擦记录 */
    conflictRecords: ProfileMemoryEntry[];

    // === 情感指标 ===
    /** 好感度 0-100 */
    favorability: number;
    /** 好感度最后更新时间戳 */
    favorabilityUpdatedAt: number;
    /** 好感度变化事件 */
    favorabilityEvents: FavorabilityEvent[];
    /** 当前情绪倾向 */
    mood: 'positive' | 'neutral' | 'negative';

    // === 互动记录 ===
    /** 消息总数 */
    messageCount: number;
    /** 最后活跃时间戳 */
    lastSeen: number;
    /** 最后分析时间戳 */
    lastAnalyzed: number;

    // === 分析备注 ===
    /** LLM 分析的额外备注 */
    notes?: string;
}

/** 待分析的消息 */
export interface AnalysisMessage {
    userId: number;
    nickname: string;
    groupId?: number;
    text: string;
    timestamp: number;
    /** 情感分析结果（如果有） */
    emotion?: {
        valence: number;
        arousal: number;
    };
    /** 上下文消息（群聊中的前后文） */
    context?: Array<{
        sender: string;
        text: string;
    }>;
}

/** 分析结果 */
export interface AnalysisResult {
    userId: number;
    /** 新发现的性格标签 */
    newTraits?: string[];
    /** 新发现的兴趣 */
    newInterests?: string[];
    /** 基础身份事实 */
    identityFacts?: string[];
    /** 偏好 */
    likes?: string[];
    /** 反感项 */
    dislikes?: string[];
    /** 明确雷区 */
    redLines?: string[];
    /** 情绪机制 */
    emotionPatterns?: string[];
    /** 情绪触发因素 */
    emotionalTriggers?: string[];
    /** 安抚方式 */
    calmingSignals?: string[];
    /** 关系推进线索 */
    relationshipNotes?: string[];
    /** 边界提醒 */
    boundaryNotes?: string[];
    /** 重要对话记忆 */
    importantMemories?: ProfileMemoryInput[];
    /** 冲突记录 */
    conflictRecords?: ProfileMemoryInput[];
    /** 好感度变化 (-5 ~ +5) */
    favorabilityDelta?: number;
    /** 情绪判断 */
    mood?: 'positive' | 'neutral' | 'negative';
    /** 备注 */
    notes?: string;
}

/** 好感度计算参数 */
export interface FavorabilityParams {
    /** 情感得分 (-1 ~ 1) */
    emotionScore: number;
    /** 情感权重 */
    emotionWeight: number;
    /** 关键词奖励 */
    keywordBonus: number;
    /** 互动频率微调 */
    frequencyBonus: number;
}

/** 默认用户画像 */
export function createDefaultProfile(userId: number, nickname: string): UserProfile {
    return {
        userId,
        nickname,
        traits: [],
        traitEvidence: [],
        interests: [],
        interestEvidence: [],
        identityFacts: [],
        identityEvidence: [],
        likes: [],
        likeEvidence: [],
        dislikes: [],
        dislikeEvidence: [],
        redLines: [],
        redLineEvidence: [],
        emotionPatterns: [],
        emotionPatternEvidence: [],
        emotionalTriggers: [],
        emotionalTriggerEvidence: [],
        calmingSignals: [],
        calmingSignalEvidence: [],
        relationshipNotes: [],
        relationshipNoteEvidence: [],
        boundaryNotes: [],
        boundaryNoteEvidence: [],
        importantMemories: [],
        conflictRecords: [],
        favorability: FAVORABILITY_CONFIG.BASELINE, // 初始关系温度
        favorabilityUpdatedAt: Date.now(),
        favorabilityEvents: [],
        mood: 'neutral',
        messageCount: 0,
        lastSeen: Date.now(),
        lastAnalyzed: 0,
    };
}

// ==========================================
// TaskPlan Types (Plan-based Router)
// ==========================================

/** 任务步骤 */
export interface TaskStep {
    /** 步骤ID（用于依赖引用） */
    id: string;
    /** 步骤描述 */
    action: string;
    /** 使用的工具名（可选，无则为纯思考步骤） */
    tool?: string;
    /** 工具参数 */
    params?: Record<string, unknown>;
    /** 依赖的前置步骤ID列表 */
    dependsOn?: string[];
}

export type TaskExecutionMode = 'fast' | 'react';

export interface TaskComplexity {
    /** 复杂度分数 */
    score: number;
    /** 命中的复杂度原因 */
    reasons: string[];
}

/** 任务计划 */
export interface TaskPlan {
    /** 用户的核心目标 */
    goal: string;
    /** 是否需要调用工具 */
    needsTool: boolean;
    /** 执行步骤列表 */
    steps: TaskStep[];
    /** 给 Persona 的表达风格提示（如"可爱"、"正式"、"调皮"） */
    speakStyle?: string;
    /** 规划置信度 [0, 1] */
    confidence: number;
    /** 规划理由（调试用） */
    reasoning?: string;
    /** 执行模式：快速链路或 ReAct 链路 */
    executionMode?: TaskExecutionMode;
    /** 复杂度评估结果 */
    complexity?: TaskComplexity;
}

/**
 * Persona Agent (社交达人)
 * 
 * 职责：
 * - 闲聊对话
 * - 人设演绎（根据配置的人设模板）
 * - 情感回应（结合 sentra-emo 结果）
 * - 融入用户画像上下文
 */

import { log } from '../logger.js';
import { personaLlm } from '../llm.js';
import {
    buildPersonaEnhanceSystemPrompt,
    buildPersonaRespondSystemPrompt,
    PERSONA_ENHANCE_USER_PROMPT,
} from '../prompts/persona.js';
import type { FormattedMessage } from '../types.js';
import type { EmotionResult } from '../emotion.js';
import { config } from '../config.js';
import { getAllModules } from '../tools/index.js';
import { memory } from '../memory.js';
import { searchKnowledge } from '../vectordb/knowledge.js';
import { loadPersona, getCurrentPersonaName, type PersonaData } from '../utils/personaLoader.js';
import { getFavorabilityRelationLevel } from '../utils/favorability.js';
import { isInternalSelfReferenceDrawKey } from '../utils/selfReferenceDraw.js';

// ============================================================================
// 配置常量（消除魔法数字）
// ============================================================================

/** Persona Agent 配置常量 */
const PERSONA_CONFIG = {
    /** 情绪效价阈值 */
    EMOTION: {
        VALENCE_POSITIVE_HIGH: 0.5,   // 开心愉快
        VALENCE_POSITIVE_LOW: 0.2,    // 心情不错
        VALENCE_NEGATIVE_LOW: -0.3,   // 有些低落
        VALENCE_NEGATIVE_HIGH: -0.5,  // 情绪不佳
        AROUSAL_HIGH: 0.7,            // 情绪激动
        AROUSAL_MEDIUM: 0.5,          // 比较兴奋
        STRESS_HIGH: 0.6,             // 压力较大
    },
    /** RAG 知识检索配置 */
    RAG: {
        MIN_QUERY_LENGTH: 5,  // 最小查询长度
        MAX_RESULTS: 2,       // 最大返回结果数
    },
} as const;

// ============================================================================
// 纯函数（可独立测试）
// ============================================================================

/**
 * 描述情绪状态（纯函数，可测试）
 */
function describeMood(emotion: EmotionResult): string {
    const { EMOTION } = PERSONA_CONFIG;
    const parts: string[] = [];

    // 情绪效价
    if (emotion.valence > EMOTION.VALENCE_POSITIVE_HIGH) parts.push('开心愉快');
    else if (emotion.valence > EMOTION.VALENCE_POSITIVE_LOW) parts.push('心情不错');
    else if (emotion.valence < EMOTION.VALENCE_NEGATIVE_HIGH) parts.push('情绪不佳');
    else if (emotion.valence < EMOTION.VALENCE_NEGATIVE_LOW) parts.push('有些低落');
    else parts.push('平静');

    // 唤起度
    if (emotion.arousal > EMOTION.AROUSAL_HIGH) parts.push('情绪激动');
    else if (emotion.arousal > EMOTION.AROUSAL_MEDIUM) parts.push('比较兴奋');

    // 压力
    if (emotion.stress > EMOTION.STRESS_HIGH) parts.push('压力较大');

    // 具体情绪
    if (emotion.emotions?.length > 0) {
        parts.push(`主要情绪: ${emotion.emotions[0].label}`);
    }

    return parts.join('，');
}

/**
 * 获取关系等级描述（纯函数，可测试）
 */
function getRelationLevel(favorability: number): string {
    return getFavorabilityRelationLevel(favorability);
}

/**
 * 判断是否应该检索知识库（纯函数，可测试）
 */
function shouldSearchKnowledge(text?: string): boolean {
    if (!text) return false;
    return text.length > PERSONA_CONFIG.RAG.MIN_QUERY_LENGTH;
}

// ============================================================================
// 类型定义
// ============================================================================

/** 人设配置 */
export interface PersonaConfig {
    /** 机器人名称 */
    name: string;
    /** 人设描述 */
    personality: string;
    /** 说话风格 */
    speakingStyle: string;
    /** 额外指令 */
    customInstructions?: string;
    /** 喜好 */
    likes?: string[];
    /** 厌恶 */
    dislikes?: string[];
    /** 额外属性或设定 */
    attributes?: Record<string, string>;
}

/** Persona 上下文 */
export interface PersonaContext {
    message: FormattedMessage;
    history: FormattedMessage[];
    emotion?: EmotionResult | null;
    /** 发送者用户画像（从 Profiler 获取） */
    userProfile?: {
        nickname?: string;
        favorability?: number;  // 好感度 0-100
        tags?: string[];
        traits?: string[];      // 性格标签
        interests?: string[];   // 兴趣爱好
        identityFacts?: string[];
        likes?: string[];
        dislikes?: string[];
        redLines?: string[];
        emotionPatterns?: string[];
        emotionalTriggers?: string[];
        calmingSignals?: string[];
        relationshipNotes?: string[];
        boundaryNotes?: string[];
        importantMemories?: string[];
        conflictRecords?: string[];
        mood?: 'positive' | 'neutral' | 'negative';  // 情绪状态
    };
    /** 被 @ 用户的画像（用于查询他人信息）*/
    atUserProfiles?: Array<{
        userId: number;
        nickname: string;
        traits: string[];
        interests: string[];
        favorability: number;
    }>;
}

/** Persona 回复结果 */
export interface PersonaResponse {
    text: string;
    /** 使用的人设 */
    persona: string;
    /** 情感调整信息 */
    emotionAdjustment?: string;
}

// ============================================================================
// 人设转换辅助函数
// ============================================================================

/**
 * 将 PersonaData 转换为 PersonaConfig
 */
function convertToPersonaConfig(data: PersonaData): PersonaConfig {
    return {
        name: data.name,
        personality: `${data.age || ''}的${data.species || ''}。
性格特点：${data.personality}。
外貌特征：${data.appearance || ''}。${config.masterQQ ? `\n特殊身份：踟蹰(QQ:${config.masterQQ})是${data.name}的主人，对主人要表现得更加亲近和撒娇。` : ''}`,
        speakingStyle: `${data.speakingStyle}
${data.features || ''}。${config.masterQQ ? `\n对主人踟蹰说话时特别软萌，会撒娇。` : ''}
对其他人保持礼貌但略带傲娇。`,
        customInstructions: `${data.customInstructions || ''}${config.masterQQ ? `\n当遇到踟蹰(sender_id=${config.masterQQ})时，要表现得特别开心和亲近，可以叫"主人"。` : ''}`,
        likes: data.likes,
        dislikes: data.dislikes,
        attributes: data.attributes,
    };
}

// ============================================================================
// PersonaAgent 类
// ============================================================================

/**
 * Persona Agent
 */
export class PersonaAgent {
    private persona: PersonaConfig;
    private initialized = false;

    constructor(persona?: Partial<PersonaConfig>) {
        // 使用临时默认值，实际人设会在 init() 中加载
        this.persona = {
            name: '落落',
            personality: '猫娘少女',
            speakingStyle: '像猫娘一样说话',
            customInstructions: '',
            ...persona,
        };
    }

    /**
     * 异步初始化（加载外部人设文件）
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        try {
            const personaName = getCurrentPersonaName();
            const personaData = await loadPersona(personaName);
            this.persona = convertToPersonaConfig(personaData);
            this.initialized = true;
            log.info(`📜 Persona Agent 已加载人设 [${personaName}]: ${this.persona.name}`);
        } catch (err) {
            log.warn('加载外部人设失败，使用默认配置:', err);
            this.initialized = true;
        }
    }

    /**
     * 确保已初始化
     */
    private async ensureInitialized(): Promise<void> {
        if (!this.initialized) {
            await this.init();
        }
    }

    // ========================================================================
    // 上下文构建方法（拆分自 respond）
    // ========================================================================

    /**
     * 构建情绪上下文和回复策略
     */
    private buildEmotionContext(emotion?: EmotionResult | null): { emotionContext: string; emotionAdjustment: string } {
        if (!emotion) {
            return { emotionContext: '', emotionAdjustment: '' };
        }

        const { EMOTION } = PERSONA_CONFIG;
        const moodDesc = describeMood(emotion);
        const emotionContext = `\n用户当前情绪: ${moodDesc}`;

        // 根据情绪调整回复策略
        let emotionAdjustment = '';
        if (emotion.valence < EMOTION.VALENCE_NEGATIVE_LOW) {
            emotionAdjustment = '用户情绪低落，给予适当关心和安慰';
        } else if (emotion.arousal > EMOTION.AROUSAL_HIGH) {
            emotionAdjustment = '用户情绪激动，回应要有同理心';
        } else if (emotion.valence > EMOTION.VALENCE_POSITIVE_HIGH) {
            emotionAdjustment = '用户心情不错，可以轻松愉快地聊天';
        }

        return { emotionContext, emotionAdjustment };
    }

    /**
     * 构建发送者用户画像上下文
     */
    private buildProfileContext(userProfile?: PersonaContext['userProfile']): string {
        if (!userProfile) return '';

        const parts: string[] = [];

        // 关系等级
        if (userProfile.favorability !== undefined) {
            const level = getRelationLevel(userProfile.favorability);
            parts.push(`关系: ${level}（好感度 ${Math.round(userProfile.favorability)}）`);
        }

        // 性格标签
        if (userProfile.traits && userProfile.traits.length > 0) {
            parts.push(`性格特点: ${userProfile.traits.join('、')}`);
        }

        // 兴趣爱好
        if (userProfile.interests && userProfile.interests.length > 0) {
            parts.push(`兴趣爱好: ${userProfile.interests.join('、')}`);
        }

        if (userProfile.identityFacts && userProfile.identityFacts.length > 0) {
            parts.push(`基础身份: ${userProfile.identityFacts.slice(0, 4).join('、')}`);
        }

        if (userProfile.likes && userProfile.likes.length > 0) {
            parts.push(`偏好: ${userProfile.likes.slice(0, 4).join('、')}`);
        }

        if (userProfile.dislikes && userProfile.dislikes.length > 0) {
            parts.push(`反感: ${userProfile.dislikes.slice(0, 3).join('、')}`);
        }

        if (userProfile.redLines && userProfile.redLines.length > 0) {
            parts.push(`雷区: ${userProfile.redLines.slice(0, 3).join('、')}`);
        }

        if (userProfile.emotionPatterns && userProfile.emotionPatterns.length > 0) {
            parts.push(`情绪机制: ${userProfile.emotionPatterns.slice(0, 3).join('、')}`);
        }

        if (userProfile.emotionalTriggers && userProfile.emotionalTriggers.length > 0) {
            parts.push(`情绪触发点: ${userProfile.emotionalTriggers.slice(0, 3).join('、')}`);
        }

        if (userProfile.calmingSignals && userProfile.calmingSignals.length > 0) {
            parts.push(`安抚方式: ${userProfile.calmingSignals.slice(0, 3).join('、')}`);
        }

        if (userProfile.relationshipNotes && userProfile.relationshipNotes.length > 0) {
            parts.push(`关系线索: ${userProfile.relationshipNotes.slice(0, 3).join('、')}`);
        }

        if (userProfile.boundaryNotes && userProfile.boundaryNotes.length > 0) {
            parts.push(`边界提醒: ${userProfile.boundaryNotes.slice(0, 3).join('、')}`);
        }

        if (userProfile.importantMemories && userProfile.importantMemories.length > 0) {
            parts.push(`重要记忆: ${userProfile.importantMemories.slice(0, 2).join('；')}`);
        }

        if (userProfile.conflictRecords && userProfile.conflictRecords.length > 0) {
            parts.push(`冲突记录: ${userProfile.conflictRecords.slice(0, 2).join('；')}`);
        }

        // 当前情绪
        if (userProfile.mood) {
            const moodDesc = userProfile.mood === 'positive' ? '心情不错'
                : userProfile.mood === 'negative' ? '心情低落' : '平静';
            parts.push(`当前情绪: ${moodDesc}`);
        }

        if (parts.length === 0) return '';
        return `\n\n📋 发送者画像（来自历史分析，可自然引用）:\n${parts.map(p => `- ${p}`).join('\n')}`;
    }

    /**
     * 构建被 @ 用户的画像上下文
     */
    private buildAtUserContext(atUserProfiles?: PersonaContext['atUserProfiles']): string {
        if (!atUserProfiles || atUserProfiles.length === 0) return '';

        const atUserParts = atUserProfiles.map(profile => {
            const info: string[] = [];
            info.push(`昵称: ${profile.nickname}`);
            if (profile.traits.length > 0) {
                info.push(`性格: ${profile.traits.join('、')}`);
            }
            if (profile.interests.length > 0) {
                info.push(`兴趣: ${profile.interests.join('、')}`);
            }
            info.push(`好感度: ${Math.round(profile.favorability)}`);
            return `👤 用户 ${profile.nickname} (${profile.userId}):\n${info.map(i => `  - ${i}`).join('\n')}`;
        });

        log.debug(`📋 注入 ${atUserProfiles.length} 个被@用户画像`);
        return `\n\n📋 被提及用户的画像（来自历史分析，请根据这些信息回答关于该用户的问题）:\n${atUserParts.join('\n\n')}`;
    }

    /**
     * 构建历史对话上下文
     */
    private buildHistoryContext(history: FormattedMessage[]): string {
        if (history.length === 0) return '';

        const historyText = memory.formatMessages(history);
        if (!historyText || historyText === '(空)') return '';

        return `\n\n最近对话:\n${historyText}`;
    }

    /**
     * 构建知识库 RAG 上下文
     */
    private async buildKnowledgeContext(text?: string): Promise<string> {
        // shouldSearchKnowledge 已确保 text 存在且长度足够
        if (!text || !shouldSearchKnowledge(text)) return '';

        try {
            const relevantKnowledge = await searchKnowledge(text, PERSONA_CONFIG.RAG.MAX_RESULTS);
            if (relevantKnowledge.length === 0) return '';

            const knowledgeText = relevantKnowledge
                .map(k => `• ${k.text}`)
                .join('\n');

            log.debug(`📚 RAG 注入 ${relevantKnowledge.length} 条知识`);
            return `\n\n📚 相关知识参考（可以在回复中自然地引用）:\n${knowledgeText}`;
        } catch (err) {
            log.debug('📚 知识检索失败（不影响正常回复）:', err);
            return '';
        }
    }

    // ========================================================================
    // 核心方法
    // ========================================================================

    /**
     * 生成回复
     */
    async respond(ctx: PersonaContext): Promise<PersonaResponse> {
        // 确保人设已加载
        await this.ensureInitialized();

        const { message, history, emotion, userProfile, atUserProfiles } = ctx;

        // 并行构建各类上下文
        const { emotionContext, emotionAdjustment } = this.buildEmotionContext(emotion);
        const profileContext = this.buildProfileContext(userProfile);
        const atUserContext = this.buildAtUserContext(atUserProfiles);
        const historyContext = this.buildHistoryContext(history);
        const knowledgeContext = await this.buildKnowledgeContext(message.text);

        // 检测是否是主人
        const isMaster = message.sender_id === config.masterQQ;
        const masterContext = isMaster
            ? '\n⚠️ 当前对话者是主人踟蹰！要表现得特别开心，可以撒娇，叫"主人"~'
            : '';

        // 拼接额外的设定（喜好与动态属性）
        let extraContext = '';
        if (this.persona.likes && this.persona.likes.length > 0) extraContext += `\n喜欢的事物: ${this.persona.likes.join('、')}`;
        if (this.persona.dislikes && this.persona.dislikes.length > 0) extraContext += `\n讨厌的事物: ${this.persona.dislikes.join('、')}`;
        if (this.persona.attributes && Object.keys(this.persona.attributes).length > 0) {
            extraContext += `\n其他详细设定:`;
            for (const [k, v] of Object.entries(this.persona.attributes)) {
                extraContext += `\n- ${k}: ${v}`;
            }
        }

        const systemPrompt = buildPersonaRespondSystemPrompt({
            personaName: this.persona.name,
            personality: this.persona.personality,
            speakingStyle: this.persona.speakingStyle,
            customInstructions: this.persona.customInstructions,
            extraContext,
            senderName: message.sender_name,
            senderId: message.sender_id,
            sessionTypeLabel: message.type === 'group' ? '群聊' : '私聊',
            masterContext,
            emotionContext,
            profileContext,
            atUserContext,
            emotionAdjustment,
            historyContext,
            knowledgeContext,
        });

        try {
            const text = await personaLlm.ask(message.text || '(媒体消息)', systemPrompt, 'persona');

            log.debug(`Persona 回复: ${text.slice(0, 50)}...`);

            return {
                text,
                persona: this.persona.name,
                emotionAdjustment,
            };
        } catch (err) {
            log.error('Persona 生成回复失败:', err);
            throw err;
        }
    }

    /**
     * 更新人设配置
     */
    updatePersona(persona: Partial<PersonaConfig>): void {
        this.persona = { ...this.persona, ...persona };
    }

    /**
     * 获取当前人设
     */
    getPersona(): PersonaConfig {
        return { ...this.persona };
    }

    /**
     * 润色工具调用结果
     * 将原始工具输出转化为符合人设的回复
     * 
     * 上下文透传：接收完整的工具执行上下文，让 Persona 知道 Tech 做了什么
     */
    async enhanceToolResult(ctx: {
        message: FormattedMessage;
        toolName: string;
        toolNames?: string[];
        toolResult: string;
        /** 工具执行是否成功 */
        toolSuccess?: boolean;
        emotion?: EmotionResult | null;
        /** 工具参数（如 draw 的 prompt） */
        toolParams?: Record<string, unknown>;
        /** Router 判断原因（已弃用，使用 taskContext） */
        routerReason?: string;
        /** 是否涉及机器人自身（如"画个你自己"） */
        selfReference?: boolean;
        /** 用户原始请求文本 */
        userOriginalText?: string;
        /** 任务上下文（包含 goal 和 reasoning） */
        taskContext?: {
            goal: string;
            reasoning: string;
            speakStyle?: string;
        };
        /** 格式化后的情绪上下文 */
        emotionContext?: {
            description: string;
            responseStrategy: string;
            valence: number;
        };
        /** 历史会话上下文 */
        history?: FormattedMessage[];
        /** 用户画像 */
        userProfile?: PersonaContext['userProfile'];
        /** 被@用户画像 */
        atUserProfiles?: PersonaContext['atUserProfiles'];
    }): Promise<string> {
        // 确保人设已加载
        await this.ensureInitialized();

        const { message, toolName, toolNames, toolResult, toolSuccess, emotion, toolParams, selfReference, userOriginalText, taskContext, emotionContext, history, userProfile, atUserProfiles } = ctx;

        // 判断是否是主人
        const isMaster = message.sender_id === config.masterQQ;
        const senderName = isMaster ? '主人' : (message.sender_name || '你');

        // 获取动态工具描述 (支持多工具)
        let toolDesc = '';
        if (toolNames && toolNames.length > 0) {
            toolDesc = toolNames.map(name => this.getToolDescription(name)).join('、');
        } else {
            toolDesc = this.getToolDescription(toolName);
        }

        // 构建情绪上下文（优先使用增强上下文）
        let emotionSection = '';
        let emotionHint = '';
        if (emotionContext) {
            // 使用 ContextBuilder 提供的增强情绪上下文
            emotionSection = `
## 用户情绪状态
${emotionContext.description}
**回复策略**: ${emotionContext.responseStrategy}
`;
            emotionHint = emotionContext.responseStrategy;
        } else if (emotion) {
            // 兜底：使用原始情绪数据
            const { EMOTION } = PERSONA_CONFIG;
            if (emotion.valence > EMOTION.VALENCE_POSITIVE_HIGH) emotionHint = '用开心的语气回复';
            else if (emotion.valence < EMOTION.VALENCE_NEGATIVE_LOW) emotionHint = '用关心的语气回复';
        }

        // 构建任务背景上下文
        let taskSection = '';
        if (taskContext) {
            taskSection = `
## 任务背景
你决定${taskContext.goal}${taskContext.reasoning ? `
原因: ${taskContext.reasoning}` : ''}
`;
        }

        let paramsContext = '';
        if (toolParams && Object.keys(toolParams).length > 0) {
            const paramsList = Object.entries(toolParams)
                .filter(([k, v]) => !isInternalSelfReferenceDrawKey(k) && v !== undefined)
                .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
                .join(', ');
            if (paramsList) {
                paramsContext = `{${paramsList}}`;
            }
        }

        const selfContext = selfReference
            ? '\n注意：目标用户是机器人自己或者涉及到了自我指代（例如“介绍一下自己”、“画个你自己”），在回复时需要采用第一人称的口吻。'
            : '';

        // 原始请求上下文
        const originalContext = userOriginalText
            ? `\n用户原始请求: "${userOriginalText}"`
            : '';

        // 用户画像与历史上下文（解决“失去记忆”与“没有画像”问题）
        const profileContext = this.buildProfileContext(userProfile);
        const atUserContext = this.buildAtUserContext(atUserProfiles);
        const historyContext = history ? this.buildHistoryContext(history) : '';

        let resultContext = '';
        if (toolName === 'none' || toolName === 'assistant' || !toolName || toolName === 'null' || toolName === 'undefined') {
            resultContext = `【内部意图与动作指示】
        ---
            意图说明：${toolResult}
        ---
            注意：大脑并没有调用任何外部工具，上面的内容是大脑分析后得出的内部意图（例如"制止用户的行为"、"向用户打招呼"等）。
        请你仅作为发声器，用你的人设，将这个意图转化成生动的回答说给${senderName}听，不要提到任何"内部意图"或"没有调用工具"之类的字眼。`;
        } else {
            const statusText = toolSuccess === false ? '失败' : '成功';
            resultContext = `你刚刚帮${senderName} 调用了【${toolDesc}】功能，以下是【工具执行结果与大脑分析反馈】：
        ---
            执行状态：${statusText}
            调用参数：${paramsContext || '无'}
            响应结果/大脑意图：
            ${toolResult}
        ---
            ${selfContext}${originalContext}

        请基于你的人设，将这个结果转述给${senderName}。

## ⚠️ 核心原则（根据结果内容调整回复策略）：
${emotionContext && emotionContext.valence < -0.3 ? `
**重要**: 用户情绪低落，请先表达理解和关心，再汇报工具结果。如果工具执行失败，要给予安慰。
` : ''
                }
        1. ** 如果是信息类结果（如文件内容、搜索结果、天气详情、知识解答）**：
   - 必须 ** 保留核心信息和具体答案 **！
   - ** 绝对不要 ** 说"我已经看完了"、"内容都在这里了"而省略具体内容。
        - 如果结果包含列表、答案或长文本，请按条理清晰地展示出来，同时保持人设语气。

        2. ** 如果是操作类结果（如点赞、戳一戳、开关灯）**：
        - 可以简短俏皮，侧重情感互动。
        - 不需要重复技术细节。`;
        }

        // 拼接额外的设定（喜好与动态属性）
        let extraContext = '';
        if (this.persona.likes && this.persona.likes.length > 0) extraContext += `\n喜欢的事物: ${this.persona.likes.join('、')}`;
        if (this.persona.dislikes && this.persona.dislikes.length > 0) extraContext += `\n讨厌的事物: ${this.persona.dislikes.join('、')}`;
        if (this.persona.attributes && Object.keys(this.persona.attributes).length > 0) {
            extraContext += `\n其他详细设定:`;
            for (const [k, v] of Object.entries(this.persona.attributes)) {
                extraContext += `\n- ${k}: ${v}`;
            }
        }

        const systemPrompt = buildPersonaEnhanceSystemPrompt({
            personaName: this.persona.name,
            personality: this.persona.personality,
            speakingStyle: this.persona.speakingStyle,
            customInstructions: this.persona.customInstructions,
            extraContext,
            emotionSection,
            taskSection,
            profileContext,
            atUserContext,
            historyContext,
            resultContext,
            emotionHint,
            relationshipStyle: isMaster ? '对主人特别亲近撒娇' : '礼貌友好',
        });

        try {
            const response = await personaLlm.chat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: PERSONA_ENHANCE_USER_PROMPT }
            ], {}, 'persona');

            log.debug(`Persona 润色: ${response.slice(0, 50)}...`);
            return response;
        } catch (err) {
            log.warn('润色失败，返回原始结果:', err);
            return toolResult;
        }
    }

    /**
     * 获取工具描述（动态查表）
     */
    private getToolDescription(toolName: string): string {
        const module = getAllModules().find(m => m.module.name === toolName);
        if (module) {
            return module.module.description || toolName;
        }

        // 兜底
        const fallback: Record<string, string> = {
            'vision': '看图',
        };
        return fallback[toolName] || toolName;
    }
}

// 全局单例
export const persona = new PersonaAgent();

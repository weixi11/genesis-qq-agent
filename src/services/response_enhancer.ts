/**
 * 响应润色服务
 * 
 * 封装 Tech 结果到 Persona 润色的流程
 * 解耦 index.ts 对 Persona.enhanceToolResult 参数的直接依赖
 * 
 * 变更: 集成 ContextBuilder，传递任务上下文到润色流程
 */

import { log } from '../logger.js';
import { config } from '../config.js';
import { persona } from '../agents/persona.js';
import { contextBuilder } from './context_builder.js';
import type { FormattedMessage, TaskPlan } from '../types.js';
import type { EmotionResult } from '../emotion.js';
import type { ToolResult } from '../agents/tech.js';
import { isInternalSelfReferenceDrawKey } from '../utils/selfReferenceDraw.js';
import { shouldUsePersonaSecondPass } from './persona_second_pass.js';

/** 可润色的工具结果（统一接口） */
export interface EnhanceableResult {
    /** 工具名称 */
    toolName: string;
    /** 多工具时的所有工具名称 */
    toolNames?: string[];
    /** 原始文本结果 */
    rawText: string;
    /** 工具参数（单工具或合并后的参数） */
    params?: Record<string, unknown>;
    /** 多工具时每个工具的独立参数 */
    toolParams?: Array<{ name: string; params: Record<string, unknown> }>;
    /** 附加数据 */
    data?: unknown;
    /** 工具执行是否成功 */
    success?: boolean;
    /** 工具是否已经直接发送了媒体段 */
    hasSegments?: boolean;
}

/** 润色请求 */
export interface EnhanceRequest {
    /** 消息上下文 */
    message: FormattedMessage;
    /** 历史消息（用于上下文） */
    history?: FormattedMessage[];
    /** 工具结果 */
    result: EnhanceableResult;
    /** 情感分析结果 */
    emotion?: EmotionResult | null;
    /** 任务计划（包含 goal 和 reasoning） */
    taskPlan?: TaskPlan;
}

/** 润色响应 */
export interface EnhanceResponse {
    /** 是否成功 */
    success: boolean;
    /** 润色后的文本 */
    text: string;
    /** 工具调用记录（用于记忆） */
    toolCall?: {
        tool: string;
        params: Record<string, unknown>;
        result: string;
        /** 多工具时每个工具的独立参数 */
        tools?: Array<{ name: string; params: Record<string, unknown> }>;
    };
}

/**
 * 从 ToolResult 转换为 EnhanceableResult
 */
export function toEnhanceableResult(result: ToolResult, combinedText?: string): EnhanceableResult {
    return {
        toolName: result.tool,
        toolNames: result.toolNames,
        rawText: combinedText || result.text,
        params: result.params,
        toolParams: result.toolParams,
        data: result.data,
        success: result.success,
        hasSegments: Boolean(result.segments?.length),
    };
}

/**
 * 清理工具参数（移除敏感或冗余字段）
 */
function sanitizeParams(params?: Record<string, unknown>, data?: unknown): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    if (params) {
        for (const [key, value] of Object.entries(params)) {
            // 跳过太长的值和内部字段
            if (typeof value === 'string' && value.length > 200) {
                sanitized[key] = value.slice(0, 200) + '...';
            } else if (!isInternalSelfReferenceDrawKey(key)) {
                sanitized[key] = value;
            }
        }
    }

    // 从 data 中提取有用信息（如 prompt）
    if (data && typeof data === 'object') {
        const dataObj = data as Record<string, unknown>;
        if (dataObj.prompt && typeof dataObj.prompt === 'string') {
            sanitized.prompt = dataObj.prompt;
        }
    }

    return sanitized;
}

/**
 * 响应润色服务
 */
class ResponseEnhancer {
    /**
     * 清理多工具参数列表
     */
    private sanitizeToolParams(
        toolParams?: Array<{ name: string; params: Record<string, unknown> }>
    ): Array<{ name: string; params: Record<string, unknown> }> | undefined {
        if (!toolParams || toolParams.length === 0) return undefined;
        return toolParams.map(t => ({
            name: t.name,
            params: sanitizeParams(t.params),
        }));
    }

    /**
     * 润色工具结果
     */
    async enhance(request: EnhanceRequest): Promise<EnhanceResponse> {
        const { message, history, result, emotion, taskPlan } = request;

        // 清理工具参数
        const sanitizedToolParams = this.sanitizeToolParams(result.toolParams);
        const selfReference = result.params?.selfReference === true
            || result.toolParams?.some(item => item.params?.selfReference === true) === true;

        // 检查是否启用润色
        if (!config.toolEnhanceResponse) {
            return {
                success: true,
                text: result.rawText,
                toolCall: {
                    tool: result.toolName,
                    params: sanitizeParams(result.params, result.data),
                    result: result.rawText,
                    tools: sanitizedToolParams,
                },
            };
        }

        const secondPassDecision = shouldUsePersonaSecondPass({
            source: 'tool',
            message,
            toolName: result.toolName,
            toolNames: result.toolNames,
            text: result.rawText,
            success: result.success,
            hasSegments: result.hasSegments,
        });
        if (!secondPassDecision.shouldUse) {
            log.debug(`📝 跳过 Persona 润色: ${secondPassDecision.reason}`);
            return {
                success: true,
                text: result.rawText,
                toolCall: {
                    tool: result.toolName,
                    params: sanitizeParams(result.params, result.data),
                    result: result.rawText,
                    tools: sanitizedToolParams,
                },
            };
        }

        log.debug(`📝 准备润色: ${result.rawText.slice(0, 100)}...`);

        try {
            // 使用 ContextBuilder 构建完整上下文
            const agentContext = contextBuilder.build(
                message,
                history || [],
                {
                    includeProfile: true,
                    emotion: emotion,
                    taskPlan: taskPlan,
                    toolResult: {
                        toolName: result.toolName,
                        toolNames: result.toolNames,
                        params: sanitizeParams(result.params, result.data),
                        result: result.rawText,
                        success: result.success !== false,
                    },
                }
            );

            const enhancedText = await persona.enhanceToolResult({
                message,
                toolName: result.toolName,
                toolNames: result.toolNames,
                toolResult: result.rawText,
                toolSuccess: result.success !== false,
                emotion,
                toolParams: sanitizeParams(result.params, result.data),
                selfReference,
                userOriginalText: message.text,
                // 新增：传递任务上下文
                taskContext: agentContext.taskContext,
                // 新增：传递情绪上下文
                emotionContext: agentContext.emotion,
            });

            log.debug(`📝 润色完成: ${enhancedText?.slice(0, 50) || '(空)'}...`);

            return {
                success: true,
                text: enhancedText || result.rawText,
                toolCall: {
                    tool: result.toolName,
                    params: sanitizeParams(result.params, result.data),
                    result: result.rawText,
                    tools: sanitizedToolParams,
                },
            };
        } catch (err) {
            log.error('Persona 润色失败，使用原始结果:', err);
            return {
                success: false,
                text: result.rawText,
                toolCall: {
                    tool: result.toolName,
                    params: sanitizeParams(result.params, result.data),
                    result: result.rawText,
                    tools: sanitizedToolParams,
                },
            };
        }
    }
}

// 全局单例
export const responseEnhancer = new ResponseEnhancer();

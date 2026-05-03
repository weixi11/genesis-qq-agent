import { config } from '../config.js';
import type { FormattedMessage } from '../types.js';

export interface PersonaSecondPassInput {
    source: 'react' | 'tool';
    message: FormattedMessage;
    toolName?: string;
    toolNames?: string[];
    text?: string;
    success?: boolean;
    hasSegments?: boolean;
}

export interface PersonaSecondPassDecision {
    shouldUse: boolean;
    reason: string;
}

const INTERNAL_STYLE_PATTERN = /(?:^|\n)\s*(?:意图[:：]|内部意图|大脑|调用参数|执行状态|响应结果|工具执行结果|请转述|请基于你的人设|任务未创建)/u;
const STRUCTURED_OUTPUT_PATTERN = /(?:^|\n)\s*(?:[-*•]|\d+\.)\s|\n{2,}|https?:\/\/|\[CQ:/u;
const NATURAL_ENDING_PATTERN = /[。！？!?~～…]$/u;
export function shouldUsePersonaSecondPass(input: PersonaSecondPassInput): PersonaSecondPassDecision {
    const text = (input.text || '').trim();
    const primaryTool = input.toolName || input.toolNames?.[0] || '';

    if (!config.toolEnhanceResponse) {
        return { shouldUse: false, reason: '工具润色总开关已关闭' };
    }

    if (!text) {
        return { shouldUse: false, reason: '没有可润色的文本内容' };
    }

    if (input.success === false) {
        return { shouldUse: true, reason: '失败结果需要更自然地转述' };
    }

    if (input.source === 'tool') {
        if (input.hasSegments) {
            return { shouldUse: true, reason: '工具媒体已单独发送，文本仍需人格化汇报' };
        }
        return { shouldUse: true, reason: '工具结果统一走人格化转述' };
    }

    if (input.hasSegments) {
        return { shouldUse: false, reason: '本轮已有媒体输出，避免阻塞主回复' };
    }

    if (!primaryTool || primaryTool === 'none' || primaryTool === 'assistant') {
        return { shouldUse: true, reason: '当前文本更像内部意图或裸回复草稿' };
    }

    if (INTERNAL_STYLE_PATTERN.test(text)) {
        return { shouldUse: true, reason: '检测到内部摘要风格，适合转成人话' };
    }

    if (input.source === 'react' && text.length <= 60 && !STRUCTURED_OUTPUT_PATTERN.test(text) && !NATURAL_ENDING_PATTERN.test(text)) {
        return { shouldUse: true, reason: 'ReAct 输出较短且口语化不足' };
    }

    if (STRUCTURED_OUTPUT_PATTERN.test(text)) {
        return { shouldUse: false, reason: '结构化结果较多，避免二次改写打散信息' };
    }

    if (text.length > 140) {
        return { shouldUse: false, reason: '文本较长，直接发送更稳' };
    }

    if (input.message.sender_id === config.masterQQ && text.length <= 90) {
        return { shouldUse: true, reason: '主人场景保留更强的人设表达' };
    }

    return { shouldUse: false, reason: '默认走直出，减少额外 LLM 耗时' };
}

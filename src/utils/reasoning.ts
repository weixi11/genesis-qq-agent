import { config } from '../config.js';

const BLOCK_PATTERNS = [
    /<think\b[^>]*>[\s\S]*?<\/think>/giu,
    /<thinking\b[^>]*>[\s\S]*?<\/thinking>/giu,
    /<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/giu,
    /<analysis\b[^>]*>[\s\S]*?<\/analysis>/giu,
    /<cot\b[^>]*>[\s\S]*?<\/cot>/giu,
];

const SECTION_PREFIX_PATTERN = /(^|\n)\s*(?:思考链|思考过程|推理过程|分析过程|reasoning|thinking|thought process)\s*[:：]\s*[\s\S]*?(?=(?:\n\s*(?:最终(?:答复|回答)|答复|回复|结论|输出|final answer|answer)\s*[:：])|$)/giu;
const ANSWER_PREFIX_PATTERN = /^\s*(?:最终(?:答复|回答)|答复|回复|结论|输出|final answer|answer)\s*[:：]\s*/iu;
const QUOTED_REASONING_TRIGGER_PATTERNS = [
    /(^|\n)\s*>\s*(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]+\s*)?\*{0,3}(?:thinking\b|thinking about|reasoning\b|analysis\b|thought process\b|comparing\b)/iu,
    /(^|\n)\s*>\s*\*{2,3}\s*-\s*[A-Za-z0-9]/u,
];
const QUOTED_LINE_PATTERN = /^\s*>\s?.*$/u;

function normalizeWhitespace(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/(\d\.)\s*\n+\s*(\d)/g, '$1$2')
        .replace(/\n+\s*([,，。！？；：、])/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function stripQuotedReasoningArtifacts(text: string): string {
    const hasQuotedReasoning = QUOTED_REASONING_TRIGGER_PATTERNS.some((pattern) => pattern.test(text));
    if (!hasQuotedReasoning) {
        return text;
    }

    return text
        .split('\n')
        .filter((line) => !QUOTED_LINE_PATTERN.test(line))
        .join('\n');
}

export function stripReasoningChain(text: string): string {
    let cleaned = text;

    for (const pattern of BLOCK_PATTERNS) {
        cleaned = cleaned.replace(pattern, '');
    }

    cleaned = cleaned.replace(SECTION_PREFIX_PATTERN, '$1');
    cleaned = stripQuotedReasoningArtifacts(cleaned);

    const answerMatch = cleaned.match(/(?:^|\n)\s*(?:最终(?:答复|回答)|答复|回复|结论|输出|final answer|answer)\s*[:：]\s*([\s\S]+)$/iu);
    if (answerMatch?.[1]) {
        cleaned = answerMatch[1];
    }

    cleaned = cleaned.replace(ANSWER_PREFIX_PATTERN, '');
    return normalizeWhitespace(cleaned);
}

export function getOutgoingReplyText(text: string | undefined | null): string | undefined {
    if (!text) return undefined;

    const normalized = config.showReasoningChain
        ? normalizeWhitespace(text)
        : stripReasoningChain(text);

    return normalized || undefined;
}

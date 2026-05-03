import { config } from '../config.js';
import { connector } from '../connector.js';
import { log } from '../logger.js';
import { persona } from '../agents/persona.js';
import type { FormattedMessage, TaskPlan } from '../types.js';
import { getConversationKey, isCooldownActive } from '../utils/message_guard.js';
import { toolStats } from '../web/store/tool_stats.js';

interface ToolDurationEstimate {
    toolName: string;
    estimateMs: number;
    sampleCount: number;
    source: 'history' | 'fallback';
}

interface PendingReplyEstimate {
    toolNames: string[];
    estimatedMs: number;
    estimates: ToolDurationEstimate[];
    mode: 'parallel' | 'sequential';
}

const DEFAULT_TOOL_ESTIMATES_MS: Record<string, number> = {
    banana_draw: 80_000,
    draw: 45_000,
    vision: 70_000,
    read_video: 60_000,
    read_audio: 30_000,
    weather: 40_000,
    daily_blog_digest: 20_000,
    web_research: 7_000,
    search_web: 7_000,
    poke: 5_000,
    like: 4_000,
    music: 3_000,
};

const DEFAULT_UNKNOWN_TOOL_ESTIMATE_MS = 8_000;
const DEFAULT_THRESHOLD_MS = 12_000;
const DEFAULT_COOLDOWN_MS = 25_000;
const DEFAULT_PERSONA_TIMEOUT_MS = 6_000;
const ESTIMATE_BUFFER_MS = 2_000;

const sentMessageIds = new Set<number>();
const lastSentByConversation = new Map<string, number>();

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
    if (!value) return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function percentile(sortedValues: number[], percentileValue: number): number {
    if (sortedValues.length === 0) return 0;
    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1),
    );
    return sortedValues[index];
}

function getFallbackEstimate(toolName: string): number {
    if (DEFAULT_TOOL_ESTIMATES_MS[toolName]) {
        return DEFAULT_TOOL_ESTIMATES_MS[toolName];
    }

    if (toolName.includes('draw') || toolName.includes('image')) return 45_000;
    if (toolName.includes('vision') || toolName.includes('video')) return 60_000;
    if (toolName.includes('search') || toolName.includes('web')) return 7_000;
    return DEFAULT_UNKNOWN_TOOL_ESTIMATE_MS;
}

export function estimateToolDuration(toolName: string): ToolDurationEstimate {
    const durations = toolStats.getLogs()
        .filter(logItem => logItem.name === toolName && Number.isFinite(logItem.duration) && logItem.duration > 0)
        .map(logItem => logItem.duration)
        .sort((a, b) => a - b);

    if (durations.length > 0) {
        const base = durations.length >= 3
            ? percentile(durations, 0.75)
            : Math.max(...durations);
        return {
            toolName,
            estimateMs: Math.max(base + ESTIMATE_BUFFER_MS, getFallbackEstimate(toolName)),
            sampleCount: durations.length,
            source: 'history',
        };
    }

    return {
        toolName,
        estimateMs: getFallbackEstimate(toolName),
        sampleCount: 0,
        source: 'fallback',
    };
}

export function estimateToolReplyDuration(toolNames: string[], sequential = false): PendingReplyEstimate {
    const uniqueToolNames = [...new Set(toolNames.filter(Boolean))];
    const estimates = uniqueToolNames.map(estimateToolDuration);
    const estimatedMs = sequential
        ? estimates.reduce((sum, item) => sum + item.estimateMs, 0)
        : Math.max(0, ...estimates.map(item => item.estimateMs));

    return {
        toolNames: uniqueToolNames,
        estimatedMs,
        estimates,
        mode: sequential ? 'sequential' : 'parallel',
    };
}

export function estimatePlanReplyDuration(plan: TaskPlan): PendingReplyEstimate {
    const toolSteps = plan.steps.filter(step => step.tool);
    const hasSequentialDeps = toolSteps.some(step => (step.dependsOn || []).length > 0);
    return estimateToolReplyDuration(toolSteps.map(step => step.tool!), hasSequentialDeps);
}

function formatEstimateDuration(ms: number): string {
    const seconds = Math.max(1, Math.round(ms / 1000));
    if (seconds < 15) return '几秒';
    if (seconds < 60) return `大概 ${Math.ceil(seconds / 5) * 5} 秒`;
    return `大概 ${Math.ceil(seconds / 30) * 30} 秒`;
}

function pickPendingReplyText(message: FormattedMessage, estimate: PendingReplyEstimate): string {
    const tools = estimate.toolNames;
    const durationText = formatEstimateDuration(estimate.estimatedMs);
    const isMaster = message.sender_id === config.masterQQ;
    const target = isMaster ? '主人' : '你';
    const comfort = isMaster ? '主人先别急嘛' : '先别急呀';

    if (tools.some(name => name.includes('draw') || name.includes('image'))) {
        return `画笔已经动起来啦，估计还要${durationText}，画好马上给${target}看~`;
    }
    if (tools.some(name => name.includes('audio'))) {
        return `唔，我在认真听这段内容啦，估计还要${durationText}，${comfort}~`;
    }
    if (tools.some(name => name.includes('vision'))) {
        return `唔，我在认真看图啦，估计还要${durationText}，整理好马上告诉${target}~`;
    }
    if (tools.some(name => name.includes('video'))) {
        return `唔，我在看视频内容啦，估计还要${durationText}，${comfort}~`;
    }
    if (tools.some(name => name.includes('search') || name.includes('web') || name === 'weather')) {
        return `我去翻资料啦，估计还要${durationText}，查清楚就好好讲给${target}听~`;
    }
    if (tools.some(name => name.includes('cron') || name.includes('task'))) {
        return `任务我接住啦，估计还要${durationText}，${comfort}~`;
    }
    return `我在处理啦，估计还要${durationText}，马上回来~`;
}

function describeToolScene(toolNames: string[]): string {
    if (toolNames.some(name => name.includes('draw') || name.includes('image'))) return '绘图/出图';
    if (toolNames.some(name => name.includes('audio'))) return '听语音';
    if (toolNames.some(name => name.includes('vision'))) return '看图识别';
    if (toolNames.some(name => name.includes('video'))) return '看视频';
    if (toolNames.some(name => name.includes('search') || name.includes('web') || name === 'weather')) return '查询资料';
    if (toolNames.some(name => name.includes('cron') || name.includes('task'))) return '处理任务';
    return '处理请求';
}

function cleanPersonaPendingReply(text: string): string {
    return text
        .replace(/^```[\w-]*\s*/u, '')
        .replace(/```$/u, '')
        .replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`pending persona timeout after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function buildPendingReplyText(message: FormattedMessage, estimate: PendingReplyEstimate): Promise<string> {
    const fallbackText = pickPendingReplyText(message, estimate);
    const personaEnabled = parseBool(process.env.PENDING_REPLY_PERSONA_ENABLED, true);
    if (!personaEnabled) return fallbackText;

    const durationText = formatEstimateDuration(estimate.estimatedMs);
    const timeoutMs = parsePositiveInt(process.env.PENDING_REPLY_PERSONA_TIMEOUT_MS, DEFAULT_PERSONA_TIMEOUT_MS);
    const scene = describeToolScene(estimate.toolNames);
    const target = message.sender_id === config.masterQQ ? '主人' : (message.sender_name || '用户');

    try {
        const text = await withTimeout(persona.enhanceToolResult({
            message,
            toolName: 'assistant',
            toolNames: [],
            toolResult: [
                `内部意图：先发一条等待提示。`,
                `当前要做的事：${scene}。`,
                `预计还需要：${durationText}。`,
                `称呼对象：${target}。`,
                '要求：只输出一句自然中文等待提示，必须符合当前人设口吻。',
                '限制：不要说任务已经完成，不要提工具名，不要解释系统，不要超过35个汉字。',
            ].join('\n'),
            toolParams: {
                scene,
                estimatedTime: durationText,
                tools: estimate.toolNames.join(','),
            },
            userOriginalText: message.text,
        }), timeoutMs);

        const cleaned = cleanPersonaPendingReply(text);
        return cleaned || fallbackText;
    } catch (error) {
        log.warn('⏳ Persona 等待提示生成失败，使用模板回退:', error instanceof Error ? error.message : String(error));
        return fallbackText;
    }
}

export async function maybeSendPendingReply(
    message: FormattedMessage,
    estimate: PendingReplyEstimate,
): Promise<boolean> {
    const enabled = parseBool(process.env.PENDING_REPLY_ENABLED, true);
    if (!enabled || estimate.toolNames.length === 0) return false;

    const thresholdMs = parsePositiveInt(process.env.PENDING_REPLY_THRESHOLD_MS, DEFAULT_THRESHOLD_MS);
    if (estimate.estimatedMs < thresholdMs) return false;

    if (sentMessageIds.has(message.message_id)) return false;

    const now = Date.now();
    const conversationKey = getConversationKey(message);
    const cooldownMs = parsePositiveInt(process.env.PENDING_REPLY_COOLDOWN_MS, DEFAULT_COOLDOWN_MS);
    if (isCooldownActive(lastSentByConversation.get(conversationKey), now, cooldownMs)) {
        return false;
    }

    const text = await buildPendingReplyText(message, estimate);
    try {
        await connector.reply(message, text);
        sentMessageIds.add(message.message_id);
        lastSentByConversation.set(conversationKey, now);
        log.info(`⏳ 已发送等待提示: tools=${estimate.toolNames.join(',')} estimate=${estimate.estimatedMs}ms mode=${estimate.mode}`);
        return true;
    } catch (error) {
        log.warn('⏳ 等待提示发送失败:', error instanceof Error ? error.message : String(error));
        return false;
    }
}

export async function maybeSendPendingReplyForPlan(message: FormattedMessage, plan: TaskPlan): Promise<boolean> {
    if (!plan.needsTool || !plan.steps.some(step => step.tool)) return false;
    return maybeSendPendingReply(message, estimatePlanReplyDuration(plan));
}

export async function maybeSendPendingReplyForTools(
    message: FormattedMessage,
    toolNames: string[],
    sequential = false,
): Promise<boolean> {
    return maybeSendPendingReply(message, estimateToolReplyDuration(toolNames, sequential));
}

import { log } from './logger.js';
import type { DebouncedMessage } from './debouncer.js';
import type { FormattedMessage } from './types.js';
import { toolRegistry } from './services/tool_registry.js';
import { markImagePromptForResolution, resolveImagePromptParams } from './services/image_prompt_resolver.js';
import { executeModule } from './tools/executor.js';
import type { ToolContext, ToolResult } from './tools/types.js';
import type { MessageSegment } from './utils/message.js';
import { config as bananaDrawConfig } from './tools/banana_draw/config.js';
import { techLlm } from './llm.js';
import { getPersonaAppearance, getPersonaDisplayName, isSelfReferenceDrawRequest } from './utils/personaLoader.js';
import { normalizeSelfReferenceDrawParams } from './utils/selfReferenceDraw.js';

export type GroupBatchIntent =
    | 'music'
    | 'weather'
    | 'vision'
    | 'search_web'
    | 'web_research'
    | 'banana_draw'
    | 'draw'
    | 'stop'
    | 'chat'
    | 'unclear';

export type GroupBatchStrategy =
    | 'persona_only'
    | 'clarify_first'
    | 'homogeneous_tool'
    | 'multi_tool_aggregate'
    | 'cancel_only';

type CancelScope = 'music' | 'weather' | 'vision' | 'search_web' | 'web_research' | 'banana_draw' | 'draw' | 'all';

export interface GroupBatchParticipant {
    senderId: number;
    senderName: string;
    senderRole?: FormattedMessage['sender_role'];
    mergedText: string;
    normalizedText: string;
    messages: FormattedMessage[];
    images: string[];
    videos: string[];
    audios: string[];
    files: string[];
}

export interface GroupBatchParticipantIntent {
    participant: GroupBatchParticipant;
    intent: GroupBatchIntent;
    toolName?: string;
    params?: Record<string, unknown>;
    confidence: number;
    reason: string;
    priority: number;
    dedupeKey?: string;
    sharedKey?: string;
    cancelScope?: CancelScope;
}

export interface GroupBatchTask {
    id: string;
    toolName: string;
    sharedKey: string;
    dedupeKey: string;
    participants: GroupBatchParticipantIntent[];
    params: Record<string, unknown>;
    score: number;
    cost: number;
}

export interface GroupBatchPlan {
    strategy: GroupBatchStrategy;
    intents: GroupBatchParticipantIntent[];
    tasks: GroupBatchTask[];
    notes: string[];
}

interface PlanGroupBatchOptions {
    enabledTools?: string[];
}

export interface GroupBatchExecutionResult {
    text?: string;
    segments: MessageSegment[];
    draftLines?: string[];
    pendingSuggested?: boolean;
    toolCall?: {
        tool: string;
        params: Record<string, unknown>;
        result?: string;
        tools?: Array<{ name: string; params: Record<string, unknown> }>;
    };
}

type ToolExecutor = (
    toolName: string,
    params: Record<string, unknown>,
    ctx: ToolContext,
) => Promise<ToolResult>;

interface ExecuteBatchOptions {
    executeTool?: ToolExecutor;
    maxTasks?: number;
    maxSegments?: number;
    maxConcurrency?: number;
    toolTimeoutMs?: number;
    maxCost?: number;
}

interface ExecutedTaskResult {
    outcomeLine: string;
    segments: MessageSegment[];
    toolCall: { name: string; params: Record<string, unknown> };
    taskResult: string;
}

interface GroupBatchRuntimeMetrics {
    plannedBatches: number;
    executedBatches: number;
    totalParticipants: number;
    totalMessages: number;
    totalWindowMs: number;
    requestedToolIntents: number;
    plannedTasks: number;
    executedTasks: number;
    savedToolCalls: number;
    skippedByBudget: number;
    canceledTasks: number;
    placeholdersSent: number;
    unifiedFallbacks: number;
}

const MUSIC_PATTERNS = /(点歌|来首|来一首|播放|放首|放一首|听歌|分享音乐|播首|播一首)/;
const WEATHER_PATTERNS = /(天气|气温|温度|下雨|下雪|几度|热不热|冷不冷)/;
const SEARCH_PATTERNS = /(搜索|搜一下|搜个|查一下|查个|查查|最新|新闻|资料|现在|当前|目前|百度|谷歌|google)/i;
const STOP_PATTERNS = /(闭嘴|别唱|别播|别放|先别|停止|停下|停一下|停一停|取消|算了|不用了|别回了|stop|cancel)/i;
const VISION_PATTERNS = /(图|图片|照片|截图|看图|识图|分析图|这张图|这个图|啥图|什么图|pdf|PDF)/;
const BANANA_MODE_PATTERNS = /(手办化|四格漫画|自拍化|真人自拍)/iu;
const BANANA_EXPLICIT_PATTERNS = /(?:^|\s)(?:banana|banana_draw)(?:\s|$)|香蕉画图|用banana|拿banana|banana来|banana画|banana生成/iu;
const DRAW_PATTERNS = /(画|绘制|生成.*图|做个图|来张图|出一张图)/;
const SELF_DRAW_PROMPT_SYSTEM_PROMPT = `You write final image-generation prompts for the bot's self portrait.

Rules:
1. Output a single final English prompt only.
2. Use concise English tags and short English phrases that are friendly to anime image models.
3. Preserve the bot's visual identity anchors from the persona appearance reference.
4. Merge the user's requested scene, action, framing, mood, clothing, and style into the final prompt.
5. Use the persona reference as guidance; do not copy it verbatim or include non-visual lore, account IDs, ownership, or group identity.
6. Do not explain. Do not output JSON. Do not output Chinese.`;
const TOOL_COST: Record<Exclude<GroupBatchIntent, 'stop' | 'chat' | 'unclear'>, number> = {
    music: 1,
    weather: 1,
    search_web: 2,
    web_research: 2,
    vision: 3,
    banana_draw: 4,
    draw: 4,
};
const groupBatchMetrics: GroupBatchRuntimeMetrics = {
    plannedBatches: 0,
    executedBatches: 0,
    totalParticipants: 0,
    totalMessages: 0,
    totalWindowMs: 0,
    requestedToolIntents: 0,
    plannedTasks: 0,
    executedTasks: 0,
    savedToolCalls: 0,
    skippedByBudget: 0,
    canceledTasks: 0,
    placeholdersSent: 0,
    unifiedFallbacks: 0,
};

function getRolePriority(role?: FormattedMessage['sender_role']): number {
    if (role === 'owner') return 3;
    if (role === 'admin') return 2;
    return 1;
}

function normalizeText(text: string): string {
    return text
        .replace(/@\S+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[,，。.!！?？:：;；]+/, '')
        .trim();
}

function normalizeLoosePhrase(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildSemanticKey(prefix: string, rawText: string, mode: 'generic' | 'music' = 'generic'): string {
    const normalized = normalizeLoosePhrase(rawText);
    if (!normalized) {
        return `${prefix}:`;
    }

    const tokens = normalized.split(' ').filter(Boolean);
    if (tokens.length > 1) {
        return `${prefix}:${tokens.sort().join('|')}`;
    }

    if (mode === 'music' && /^[\u4e00-\u9fa5]{3,12}$/u.test(normalized)) {
        return `${prefix}:${[...normalized].sort().join('')}`;
    }

    return `${prefix}:${normalized}`;
}

function normalizeMediaPaths(items: FormattedMessage['images'] | FormattedMessage['videos'] | FormattedMessage['records']): string[] {
    return items
        .map(item => typeof item === 'string' ? item : item.path || item.file || item.url || '')
        .filter(Boolean);
}

function normalizeFiles(items: FormattedMessage['files']): string[] {
    return items
        .map(item => item.path || item.file || item.url || '')
        .filter(Boolean);
}

function extractWeatherLocation(text: string): string | undefined {
    const explicitMatch = text.match(/(?:今天|明天|后天|现在)?([A-Za-z\u4e00-\u9fa5]{2,20}?)(?:的)?天气/);
    if (explicitMatch?.[1]) {
        const location = explicitMatch[1].trim();
        if (location.length >= 2 && !['查询', '查看', '一下', '现在', '帮我', '帮忙'].includes(location)) {
            return location;
        }
    }

    const commonCities = [
        '北京', '上海', '广州', '深圳', '杭州', '成都', '重庆', '武汉', '西安', '南京',
        '天津', '苏州', '郑州', '长沙', '青岛', '沈阳', '大连', '厦门', '福州', '济南',
    ];
    return commonCities.find(city => text.includes(city));
}

function extractMusicKeyword(text: string): string | undefined {
    const cleaned = text
        .replace(MUSIC_PATTERNS, ' ')
        .replace(/给我|帮我|想听|我要|整一首|放个|来个|听一下|听首|一下/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || undefined;
}

function extractSearchQuery(text: string): string | undefined {
    const cleaned = text
        .replace(SEARCH_PATTERNS, ' ')
        .replace(/帮我|一下|给我|看看|搜搜|查查/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || undefined;
}

function summarizeText(text: string, maxLength = 72): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
}

function summarizeToolResult(toolName: string, result: ToolResult): string {
    const text = summarizeText(result.text || '', 88);
    if (toolName === 'music') {
        const musicText = (result.data?.message as string | undefined) || text;
        return summarizeText(musicText.replace(/^已为您点歌:\s*/u, ''), 48);
    }
    if (toolName === 'weather') {
        return summarizeText(text.replace(/\n+/g, ' / '), 88);
    }
    return text;
}

function detectCancelScope(text: string): CancelScope {
    if (/(歌|音乐|播放|点歌|唱)/.test(text)) return 'music';
    if (/(天气|气温|温度|下雨|下雪)/.test(text)) return 'weather';
    if (/(识图|看图|图片|照片|截图|pdf)/i.test(text)) return 'vision';
    if (/(搜|搜索|新闻|资料|百度|谷歌|google)/i.test(text)) return 'web_research';
    if (/(画|绘制|生成.*图|做个图|来张图|出一张图)/.test(text)) return 'draw';
    return 'all';
}

function getTaskCost(toolName: string): number {
    return TOOL_COST[toolName as keyof typeof TOOL_COST] || 2;
}

function buildParticipants(debounced: DebouncedMessage): GroupBatchParticipant[] {
    const participantMap = new Map<number, GroupBatchParticipant>();

    for (const message of debounced.messages) {
        const existing = participantMap.get(message.sender_id);
        if (existing) {
            existing.messages.push(message);
            existing.images.push(...normalizeMediaPaths(message.images));
            existing.videos.push(...normalizeMediaPaths(message.videos));
            existing.audios.push(...normalizeMediaPaths(message.records));
            existing.files.push(...normalizeFiles(message.files));
            continue;
        }

        participantMap.set(message.sender_id, {
            senderId: message.sender_id,
            senderName: message.sender_name || String(message.sender_id),
            senderRole: message.sender_role,
            mergedText: debounced.participants?.find(item => item.senderId === message.sender_id)?.mergedText || message.text || '',
            normalizedText: '',
            messages: [message],
            images: normalizeMediaPaths(message.images),
            videos: normalizeMediaPaths(message.videos),
            audios: normalizeMediaPaths(message.records),
            files: normalizeFiles(message.files),
        });
    }

    return Array.from(participantMap.values()).map(participant => ({
        ...participant,
        normalizedText: normalizeText(participant.mergedText),
    }));
}

function isToolEnabled(toolName: string, enabledTools?: Set<string>): boolean {
    if (enabledTools) {
        return enabledTools.has(toolName);
    }
    return toolRegistry.isToolEnabled(toolName);
}

function inferIntent(participant: GroupBatchParticipant, enabledTools?: Set<string>): GroupBatchParticipantIntent {
    const normalizedText = participant.normalizedText;
    const lowerText = normalizedText.toLowerCase();
    const hasImages = participant.images.length > 0 || participant.files.some(file => file.toLowerCase().endsWith('.pdf'));

    if (!normalizedText && !hasImages) {
        return {
            participant,
            intent: 'unclear',
            confidence: 0.2,
            reason: '空内容',
            priority: 10,
        };
    }

    if (STOP_PATTERNS.test(normalizedText)) {
        return {
            participant,
            intent: 'stop',
            confidence: 0.98,
            reason: '规则匹配: 终止/打断',
            priority: participant.senderRole === 'owner' ? 100 : participant.senderRole === 'admin' ? 95 : 90,
            cancelScope: detectCancelScope(normalizedText),
        };
    }

    if (MUSIC_PATTERNS.test(normalizedText) && isToolEnabled('music', enabledTools)) {
        const keyword = extractMusicKeyword(normalizedText);
        if (keyword) {
            return {
                participant,
                intent: 'music',
                toolName: 'music',
                params: { keyword },
                confidence: 0.9,
                reason: '规则匹配: 点歌',
                priority: 70,
                dedupeKey: buildSemanticKey('music', keyword, 'music'),
                sharedKey: 'music',
            };
        }
    }

    if (WEATHER_PATTERNS.test(normalizedText) && isToolEnabled('weather', enabledTools)) {
        const location = extractWeatherLocation(normalizedText);
        if (location) {
            return {
                participant,
                intent: 'weather',
                toolName: 'weather',
                params: { location },
                confidence: 0.85,
                reason: '规则匹配: 天气查询',
                priority: 60,
                dedupeKey: `weather:${location.toLowerCase()}`,
                sharedKey: 'weather',
            };
        }
    }

    if ((hasImages || VISION_PATTERNS.test(normalizedText)) && isToolEnabled('vision', enabledTools)) {
        const imagePath = participant.images[0] || participant.files.find(file => file.toLowerCase().endsWith('.pdf'));
        if (imagePath) {
            return {
                participant,
                intent: 'vision',
                toolName: 'vision',
                params: { imagePath, question: normalizedText || '请描述这张图片的内容' },
                confidence: 0.8,
                reason: '规则匹配: 识图',
                priority: 55,
                dedupeKey: `vision:${participant.senderId}:${imagePath}`,
                sharedKey: 'vision',
            };
        }
    }

    if (SEARCH_PATTERNS.test(normalizedText) && (isToolEnabled('web_research', enabledTools) || isToolEnabled('search_web', enabledTools))) {
        const query = extractSearchQuery(normalizedText);
        if (query) {
            const preferredTool = isToolEnabled('web_research', enabledTools) ? 'web_research' : 'search_web';
            return {
                participant,
                intent: preferredTool,
                toolName: preferredTool,
                params: preferredTool === 'web_research' ? { mode: 'research', query } : { mode: 'search', query },
                confidence: 0.78,
                reason: preferredTool === 'web_research' ? '规则匹配: 在线研究' : '规则匹配: 联网搜索',
                priority: 50,
                dedupeKey: buildSemanticKey(preferredTool, query),
                sharedKey: preferredTool,
            };
        }
    }

    const bananaModeMatched = BANANA_MODE_PATTERNS.test(normalizedText);
    const explicitBananaMatched = BANANA_EXPLICIT_PATTERNS.test(normalizedText);
    const drawMatched = DRAW_PATTERNS.test(normalizedText);
    const bananaEnabled = isToolEnabled('banana_draw', enabledTools);
    const drawEnabled = isToolEnabled('draw', enabledTools);
    const shouldUseBanana = bananaEnabled
        && (
            bananaModeMatched
            || (explicitBananaMatched && (drawMatched || participant.images.length > 0))
            || (bananaDrawConfig.preferForTextToImage && drawMatched)
            || (drawMatched && !drawEnabled)
        );

    if (shouldUseBanana) {
        let mode: 'auto' | 'figurine' | 'comic' | 'selfie' = 'auto';
        if (/手办化|手办/u.test(normalizedText)) mode = 'figurine';
        else if (/四格漫画|四格|漫画/u.test(normalizedText)) mode = 'comic';
        else if (/自拍化|自拍|真人自拍/u.test(normalizedText)) mode = 'selfie';

        const bananaPrompt = normalizedText
            .replace(/^(@\S+\s*)+/u, '')
            .replace(/^(给我|帮我|请|来个|来张|整一张)\s*/u, '')
            .trim();
        const selfReference = isSelfReferenceDrawRequest(bananaPrompt || normalizedText);
        const rawParams = {
            ...(mode === 'auto' ? { prompt: bananaPrompt || normalizedText } : { prompt: bananaPrompt || normalizedText, mode }),
            ...(selfReference ? { selfReference: true } : {}),
        };
        return {
            participant,
            intent: 'banana_draw',
            toolName: 'banana_draw',
            params: selfReference ? rawParams : markImagePromptForResolution(rawParams),
            confidence: 0.76,
            reason: mode !== 'auto'
                ? `规则匹配: Banana ${mode}`
                : explicitBananaMatched
                    ? '规则匹配: 显式指定 Banana 绘图'
                    : drawEnabled
                        ? '规则匹配: Banana 普通文生图优先'
                        : '规则匹配: draw 已关闭，使用 Banana 绘图兜底',
            priority: 49,
            dedupeKey: buildSemanticKey('banana_draw', bananaPrompt || normalizedText),
            sharedKey: 'banana_draw',
        };
    }

    if (drawMatched && drawEnabled) {
        const drawPrompt = normalizedText
            .replace(/^(@\S+\s*)+/u, '')
            .replace(/^(给我|帮我|请|来个|来张|整一张)\s*/u, '')
            .trim();
        const selfReference = isSelfReferenceDrawRequest(drawPrompt || normalizedText);
        const rawParams = {
            prompt: drawPrompt || normalizedText,
            ...(selfReference ? { selfReference: true } : {}),
        };
        return {
            participant,
            intent: 'draw',
            toolName: 'draw',
            params: selfReference ? rawParams : markImagePromptForResolution(rawParams),
            confidence: 0.72,
            reason: selfReference ? '规则匹配: 自引用绘图请求' : '规则匹配: 绘图请求',
            priority: 48,
            dedupeKey: buildSemanticKey('draw', drawPrompt || normalizedText),
            sharedKey: 'draw',
        };
    }

    if (/在吗|你好|哈喽|早上好|晚上好|收到没|看看我|理理我/u.test(lowerText)) {
        return {
            participant,
            intent: 'chat',
            confidence: 0.65,
            reason: '规则匹配: 闲聊招呼',
            priority: 20,
        };
    }

    if (normalizedText.length >= 2) {
        return {
            participant,
            intent: 'unclear',
            confidence: 0.4,
            reason: '未命中明确工具规则',
            priority: 15,
        };
    }

    return {
        participant,
        intent: 'chat',
        confidence: 0.4,
        reason: '短句闲聊',
        priority: 12,
    };
}

function buildTasks(intents: GroupBatchParticipantIntent[]): GroupBatchTask[] {
    const grouped = new Map<string, GroupBatchTask>();

    for (const intent of intents) {
        if (!intent.toolName || !intent.params || !intent.dedupeKey || !intent.sharedKey) {
            continue;
        }

        const existing = grouped.get(intent.dedupeKey);
        if (existing) {
            existing.participants.push(intent);
            continue;
        }

        grouped.set(intent.dedupeKey, {
            id: `task_${grouped.size + 1}`,
            toolName: intent.toolName,
            sharedKey: intent.sharedKey,
            dedupeKey: intent.dedupeKey,
            participants: [intent],
            params: intent.params,
            score: intent.priority,
            cost: getTaskCost(intent.toolName),
        });
    }

    for (const task of grouped.values()) {
        const participantCountWeight = task.participants.length * 100;
        const priorityWeight = Math.max(...task.participants.map(intent => intent.priority));
        const costBias = Math.max(0, 5 - task.cost) * 3;
        task.score = participantCountWeight + priorityWeight + costBias;
    }

    return Array.from(grouped.values()).sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (right.participants.length !== left.participants.length) return right.participants.length - left.participants.length;
        if (left.cost !== right.cost) return left.cost - right.cost;
        return left.id.localeCompare(right.id);
    });
}

function shouldStopTask(stopIntent: GroupBatchParticipantIntent, task: GroupBatchTask): boolean {
    const scope = stopIntent.cancelScope || 'all';
    return scope === 'all' || scope === task.toolName;
}

function recordPlanMetrics(debounced: DebouncedMessage, intents: GroupBatchParticipantIntent[], tasks: GroupBatchTask[]): void {
    groupBatchMetrics.plannedBatches += 1;
    groupBatchMetrics.totalParticipants += debounced.participants?.length || 1;
    groupBatchMetrics.totalMessages += debounced.messages.length;
    groupBatchMetrics.totalWindowMs += debounced.windowMs || 0;
    const executableIntentCount = intents.filter(intent => intent.toolName && intent.params).length;
    groupBatchMetrics.requestedToolIntents += executableIntentCount;
    groupBatchMetrics.plannedTasks += tasks.length;
    groupBatchMetrics.savedToolCalls += Math.max(0, executableIntentCount - tasks.length);
}

function describeIntentForComposer(intent: GroupBatchParticipantIntent): string {
    switch (intent.intent) {
        case 'music':
            return `点歌：${String(intent.params?.keyword || '').trim() || '未提供关键词'}`;
        case 'weather':
            return `查天气：${String(intent.params?.location || '').trim() || '未提供地点'}`;
        case 'search_web':
            return `联网搜索：${String(intent.params?.query || '').trim() || '未提供查询词'}`;
        case 'web_research':
            return `在线研究：${String(intent.params?.query || '').trim() || '未提供查询词'}`;
        case 'vision':
            return '识图/看图';
        case 'banana_draw':
            return `Banana 绘图：${summarizeText(String(intent.params?.prompt || '').trim() || '未提供提示词', 36)}`;
        case 'draw':
            return `绘图：${summarizeText(String(intent.params?.prompt || '').trim() || '未提供提示词', 36)}`;
        case 'stop':
            return '要求先停一下';
        case 'chat':
            return '打招呼/确认在不在';
        default:
            return '需求还不够明确';
    }
}

export function planGroupBatch(debounced: DebouncedMessage, options: PlanGroupBatchOptions = {}): GroupBatchPlan {
    const participants = buildParticipants(debounced);
    const enabledTools = options.enabledTools ? new Set(options.enabledTools) : undefined;
    const intents = participants.map(participant => inferIntent(participant, enabledTools));
    const stopIntents = intents.filter(intent => intent.intent === 'stop');
    const executableIntents = intents.filter(intent => intent.toolName && intent.params);
    const notes: string[] = [];

    if (stopIntents.length > 0) {
        const provisionalTasks = buildTasks(executableIntents);
        const remainingTasks: GroupBatchTask[] = [];
        const suppressedTaskNames: string[] = [];

        for (const task of provisionalTasks) {
            const conflictingStops = stopIntents.filter(intent => shouldStopTask(intent, task));
            if (conflictingStops.length === 0) {
                remainingTasks.push(task);
                continue;
            }

            const strongestStop = [...conflictingStops].sort((left, right) => right.priority - left.priority)[0];
            const strongestRequesterRole = Math.max(...task.participants.map(intent => getRolePriority(intent.participant.senderRole)));
            const stopRole = getRolePriority(strongestStop.participant.senderRole);

            if (stopRole >= strongestRequesterRole) {
                suppressedTaskNames.push(task.toolName);
                continue;
            }

            notes.push(`${strongestStop.participant.senderName} 想先停掉 ${task.toolName}，但更高权限成员的请求优先保留。`);
            remainingTasks.push(task);
        }

        groupBatchMetrics.canceledTasks += suppressedTaskNames.length;

        if (remainingTasks.length === 0) {
            const strongestStop = [...stopIntents].sort((left, right) => right.priority - left.priority)[0];
            notes.push(`${strongestStop.participant.senderName} 发了终止指令，当前批次不再执行工具。`);
            const plan = {
                strategy: 'cancel_only' as const,
                intents,
                tasks: [],
                notes,
            };
            recordPlanMetrics(debounced, intents, []);
            return plan;
        }

        if (suppressedTaskNames.length > 0) {
            const strongestStop = [...stopIntents].sort((left, right) => right.priority - left.priority)[0];
            notes.push(`${strongestStop.participant.senderName} 的终止指令已覆盖同批次冲突任务：${[...new Set(suppressedTaskNames)].join('、')}。`);
        }

        const plan = {
            strategy: remainingTasks.every(task => task.sharedKey === remainingTasks[0]?.sharedKey) ? 'homogeneous_tool' as const : 'multi_tool_aggregate' as const,
            intents,
            tasks: remainingTasks,
            notes,
        };
        recordPlanMetrics(debounced, intents, remainingTasks);
        return plan;
    }

    if (executableIntents.length === 0) {
        const hasUnclear = intents.some(intent => intent.intent === 'unclear');
        const plan = {
            strategy: hasUnclear ? 'clarify_first' as const : 'persona_only' as const,
            intents,
            tasks: [],
            notes,
        };
        recordPlanMetrics(debounced, intents, []);
        return plan;
    }

    const tasks = buildTasks(executableIntents);
    const strategy: GroupBatchStrategy = tasks.length > 0 && tasks.every(task => task.sharedKey === tasks[0].sharedKey)
        ? 'homogeneous_tool'
        : 'multi_tool_aggregate';

    const plan = {
        strategy,
        intents,
        tasks,
        notes,
    };
    recordPlanMetrics(debounced, intents, tasks);
    return plan;
}

function buildToolContext(intent: GroupBatchParticipantIntent): ToolContext {
    const participant = intent.participant;
    return {
        senderId: participant.senderId,
        groupId: participant.messages[0]?.group_id,
        imageUrls: participant.images,
        videoPaths: participant.videos,
        audioPaths: participant.audios,
        filePaths: participant.files,
        senderRole: participant.senderRole,
        atUsers: participant.messages.flatMap(message => message.at_users || []),
    };
}

function dedupeSegments(results: MessageSegment[], maxSegments: number): MessageSegment[] {
    const seen = new Set<string>();
    const deduped: MessageSegment[] = [];
    for (const segment of results) {
        const key = JSON.stringify(segment);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(segment);
        if (deduped.length >= maxSegments) break;
    }
    return deduped;
}

function buildOutcomeLine(
    task: GroupBatchTask,
    result: ToolResult,
    participants: GroupBatchParticipantIntent[],
): string {
    const names = participants.map(item => item.participant.senderName).join('、');
    const summary = summarizeToolResult(task.toolName, result);

    if (participants.length > 1) {
        return `${names}：这波一起处理了，${summary}`;
    }
    return `${names}：${summary}`;
}

function buildChatOutcomeLine(intent: GroupBatchParticipantIntent): string {
    return `${intent.participant.senderName}：我在，你这条我看到了。`;
}

function buildClarifyOutcomeLine(intent: GroupBatchParticipantIntent): string {
    return `${intent.participant.senderName}：你的需求我先记下了，再补具体一点我会更好接。`;
}

function appendCompressedFollowups(
    lines: string[],
    intents: GroupBatchParticipantIntent[],
    buildLine: (intent: GroupBatchParticipantIntent) => string,
    restBuilder: (names: string[]) => string,
): void {
    for (const intent of intents.slice(0, 2)) {
        lines.push(buildLine(intent));
    }

    const rest = intents.slice(2);
    if (rest.length > 0) {
        lines.push(restBuilder(rest.map(intent => intent.participant.senderName)));
    }
}

function buildCancelOnlyText(intents: GroupBatchParticipantIntent[], notes: string[]): string {
    const stopperNames = intents
        .filter(intent => intent.intent === 'stop')
        .map(intent => intent.participant.senderName);
    const others = intents
        .filter(intent => intent.intent !== 'stop')
        .map(intent => intent.participant.senderName);

    const lines = ['这波我先收住。'];
    if (stopperNames.length > 0) {
        lines.push(`${stopperNames.join('、')} 说先停一下，我这边不继续执行了。`);
    }
    if (others.length > 0) {
        lines.push(`${others.join('、')} 如果还要继续，重新叫我一声就行。`);
    }
    if (notes.length > 0) {
        lines.push(notes[0]);
    }
    return lines.join('\n');
}

export function buildGroupBatchComposerMessage(
    first: FormattedMessage,
    plan: GroupBatchPlan,
    draftLines: string[],
): FormattedMessage {
    const participantSummaries = plan.intents.map((intent, index) => {
        const participant = intent.participant;
        const label = describeIntentForComposer(intent);
        return `${index + 1}. ${participant.senderName}(${participant.senderId})：${label}`;
    });

    return {
        ...first,
        sender_name: `${first.sender_name}等${plan.intents.length}人`,
        summary: `群聊聚合发声：${plan.intents.map(intent => intent.participant.senderName).join('、')}`.slice(0, 80),
        objective: 'group_batch_composer',
        text: [
            '【群聊聚合回复润色】',
            '你要在群里一次性回复多人，只发一条自然的群消息。',
            '要求：尽量点名覆盖到人，不要机械复读，不要写成客服清单，不要拆成多条。',
            '如果有人发的是打断/停止，就顺着语境自然解释优先级。',
            '',
            '参与者：',
            ...participantSummaries,
            '',
            '原始执行结果：',
            ...draftLines,
        ].join('\n'),
    };
}

export function shouldSendGroupBatchPending(plan: GroupBatchPlan): boolean {
    if (plan.tasks.length === 0) {
        return false;
    }

    return plan.tasks.some(task => task.cost >= 2) || plan.tasks.length >= 3;
}

export function recordGroupBatchPendingSent(): void {
    groupBatchMetrics.placeholdersSent += 1;
}

export function recordGroupBatchUnifiedFallback(): void {
    groupBatchMetrics.unifiedFallbacks += 1;
}

export function getGroupBatchMetricsSnapshot(): GroupBatchRuntimeMetrics & {
    averageParticipantsPerBatch: number;
    averageWindowMs: number;
} {
    const plannedBatches = Math.max(groupBatchMetrics.plannedBatches, 1);
    return {
        ...groupBatchMetrics,
        averageParticipantsPerBatch: Number((groupBatchMetrics.totalParticipants / plannedBatches).toFixed(2)),
        averageWindowMs: Math.round(groupBatchMetrics.totalWindowMs / plannedBatches),
    };
}

function selectTasksWithinBudget(
    tasks: GroupBatchTask[],
    maxTasks: number,
    maxCost: number,
): { selected: GroupBatchTask[]; skippedByBudget: GroupBatchTask[] } {
    const selected: GroupBatchTask[] = [];
    const skippedByBudget: GroupBatchTask[] = [];
    let usedCost = 0;

    for (const task of tasks) {
        if (selected.length >= maxTasks) {
            break;
        }

        if (selected.length > 0 && usedCost + task.cost > maxCost) {
            skippedByBudget.push(task);
            continue;
        }

        selected.push(task);
        usedCost += task.cost;
    }

    if (selected.length === 0 && tasks.length > 0) {
        selected.push(tasks[0]);
    }

    return { selected, skippedByBudget };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`${label} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }) as Promise<T>;
}

async function runTasksWithConcurrency<T>(
    tasks: GroupBatchTask[],
    concurrency: number,
    runner: (task: GroupBatchTask) => Promise<T>,
): Promise<T[]> {
    const results = new Array<T>(tasks.length);
    let cursor = 0;

    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
        while (true) {
            const currentIndex = cursor;
            cursor += 1;
            if (currentIndex >= tasks.length) {
                break;
            }

            results[currentIndex] = await runner(tasks[currentIndex]);
        }
    });

    await Promise.all(workers);
    return results;
}

async function resolveDrawTaskParams(
    toolName: string,
    params: Record<string, unknown>,
    userText: string,
): Promise<Record<string, unknown>> {
    if (toolName !== 'draw' && toolName !== 'banana_draw') {
        return params;
    }

    const selfResolvedParams = await normalizeSelfReferenceDrawParams({
        params,
        userText,
        stage: '🎨 群聊聚合',
        appearance: typeof params.botAppearance === 'string' ? params.botAppearance : getPersonaAppearance(),
        personaName: getPersonaDisplayName(),
        composePrompt: async ({ appearance, personaName, originalPrompt, missingAnchors, retry }) => techLlm.chat([
            {
                role: 'system',
                content: SELF_DRAW_PROMPT_SYSTEM_PROMPT,
            },
            {
                role: 'user',
                content: `Bot name: ${personaName}
Persona appearance reference:
${appearance}

User request:
${userText || originalPrompt}

Current draw request:
${originalPrompt}

${retry ? `Required identity anchors that must appear explicitly: ${(missingAnchors || []).join(', ') || 'pink_hair, purple_eyes, cat_ears'}\n` : ''}Return one final English image prompt only.`,
            },
        ], {
            temperature: 0,
        }, 'group_batch_self_draw_prompt'),
    });

    return resolveImagePromptParams({
        toolName,
        params: selfResolvedParams,
        userText,
        stage: '🎨 群聊聚合',
    });
}

export async function executeGroupBatchPlan(
    plan: GroupBatchPlan,
    options: ExecuteBatchOptions = {},
): Promise<GroupBatchExecutionResult> {
    const executeTool = options.executeTool || executeModule;
    const maxTasks = options.maxTasks || 4;
    const maxSegments = options.maxSegments || 4;
    const maxConcurrency = options.maxConcurrency || 2;
    const toolTimeoutMs = options.toolTimeoutMs || 12000;
    const maxCost = options.maxCost || 6;

    if (plan.strategy === 'cancel_only') {
        return {
            text: buildCancelOnlyText(plan.intents, plan.notes),
            segments: [],
            pendingSuggested: false,
            toolCall: {
                tool: 'group_batch_cancel',
                params: { participants: plan.intents.map(intent => intent.participant.senderId) },
                result: 'cancelled',
            },
        };
    }

    const lines: string[] = [];
    const taskResults: string[] = [];

    for (const note of plan.notes) {
        lines.push(note);
    }

    const boundedTasks = plan.tasks.slice(0, maxTasks);
    if (plan.tasks.length > maxTasks) {
        lines.push(`这波需求有点多，我先处理最明确的 ${maxTasks} 个，其余的你们再补我。`);
    }

    const { selected: tasks, skippedByBudget } = selectTasksWithinBudget(boundedTasks, maxTasks, maxCost);
    if (skippedByBudget.length > 0) {
        lines.push('这波里有些比较重的请求我先缓一缓，优先把更快能回的几项处理掉。');
        groupBatchMetrics.skippedByBudget += skippedByBudget.length;
    }

    const executedResults = await runTasksWithConcurrency(tasks, maxConcurrency, async (task): Promise<ExecutedTaskResult> => {
        const representative = [...task.participants].sort((left, right) => right.priority - left.priority)[0];
        const ctx = buildToolContext(representative);
        const userText = task.participants.map(item => item.participant.mergedText).filter(Boolean).join('\n');
        const taskParams = await resolveDrawTaskParams(task.toolName, task.params, userText);

        try {
            const result = await withTimeout(
                executeTool(task.toolName, taskParams, ctx),
                toolTimeoutMs,
                `tool:${task.toolName}`,
            );
            if (result.success) {
                return {
                    outcomeLine: buildOutcomeLine(task, result, task.participants),
                    segments: result.segments || [],
                    toolCall: { name: task.toolName, params: taskParams },
                    taskResult: `${task.toolName}:${summarizeToolResult(task.toolName, result)}`,
                };
            }

            const names = task.participants.map(item => item.participant.senderName).join('、');
            return {
                outcomeLine: `${names}：这项我这次没跑通，${summarizeText(result.text || '稍后再试试。', 48)}`,
                segments: [],
                toolCall: { name: task.toolName, params: taskParams },
                taskResult: `${task.toolName}:failed`,
            };
        } catch (error) {
            const names = task.participants.map(item => item.participant.senderName).join('、');
            const message = error instanceof Error ? error.message : String(error);
            log.warn('群聊聚合工具执行失败，已降级汇总', {
                toolName: task.toolName,
                dedupeKey: task.dedupeKey,
                error: message,
            });
            return {
                outcomeLine: `${names}：这项我先没拿到结果，稍后再叫我一次。`,
                segments: [],
                toolCall: { name: task.toolName, params: taskParams },
                taskResult: `${task.toolName}:error`,
            };
        }
    });

    const collectedSegments: MessageSegment[] = [];
    const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    for (const result of executedResults) {
        lines.push(result.outcomeLine);
        collectedSegments.push(...result.segments);
        toolCalls.push(result.toolCall);
        taskResults.push(result.taskResult);
    }

    const chatIntents = plan.intents.filter(intent => intent.intent === 'chat');
    appendCompressedFollowups(
        lines,
        chatIntents,
        buildChatOutcomeLine,
        names => `${names.join('、')}：我也看到你们在叫我了。`,
    );

    const unclearIntents = plan.intents.filter(intent => intent.intent === 'unclear');
    appendCompressedFollowups(
        lines,
        unclearIntents,
        buildClarifyOutcomeLine,
        names => `${names.join('、')}：你们几个再补具体一点，我下一条就能接上。`,
    );

    groupBatchMetrics.executedBatches += 1;
    groupBatchMetrics.executedTasks += tasks.length;

    return {
        text: lines.join('\n'),
        segments: dedupeSegments(collectedSegments, maxSegments),
        draftLines: [...lines],
        pendingSuggested: shouldSendGroupBatchPending(plan),
        toolCall: {
            tool: 'group_batch_aggregate',
            params: {
                strategy: plan.strategy,
                participantIds: plan.intents.map(intent => intent.participant.senderId),
                executedTasks: tasks.length,
                skippedTasksByBudget: skippedByBudget.length,
            },
            result: taskResults.join(' | '),
            tools: toolCalls,
        },
    };
}

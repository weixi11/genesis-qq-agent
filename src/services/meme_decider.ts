import { config } from '../config.js';
import { autoMemeLlm } from '../llm.js';
import { log } from '../logger.js';
import { getProfileAsync } from '../profiler/store.js';
import type { EmotionResult } from '../emotion.js';
import type { FormattedMessage } from '../types.js';
import type { MessageSegment } from '../utils/message.js';
import { memeCatalog, type ResolvedMemePack } from './meme_catalog.js';
import { isRecord, safeParseJson } from '../utils/json.js';

interface AutoMemeDecisionInput {
    message: FormattedMessage;
    replyText?: string;
    emotion?: EmotionResult | null;
    toolAlreadySentMedia?: boolean;
}

export interface AutoMemeDecision {
    shouldSend: boolean;
    reason?: string;
    packId?: string;
    segments: MessageSegment[];
    files: string[];
}

const sessionCooldownUntil = new Map<string, number>();
const userCooldownUntil = new Map<number, number>();
const packCooldownUntil = new Map<string, number>();
const recentFilesBySession = new Map<string, string[]>();
const recentFilesByPackSession = new Map<string, string[]>();

function safeGetProfile(userId: number) {
    try {
        return getProfileAsync(userId);
    } catch {
        return undefined;
    }
}

function getSessionKey(message: FormattedMessage): string {
    if (message.type === 'group' && message.group_id) {
        return `group:${message.group_id}`;
    }
    return `private:${message.sender_id}`;
}

function includesAny(text: string, keywords: string[]): boolean {
    return keywords.some(keyword => text.includes(keyword));
}

function inferSceneByRules(input: AutoMemeDecisionInput): { scene: string; probability: number; reason: string } | null {
    const replyText = (input.replyText || '').trim();
    const messageText = input.message.text?.trim() || '';
    const combined = `${messageText}\n${replyText}`;
    const normalized = combined.toLowerCase();

    if (input.message.sender_id === config.masterQQ || replyText.includes('主人')) {
        return { scene: 'owner', probability: 0.68, reason: '主人或护主场景' };
    }

    if (
        includesAny(combined, ['不许', '别闹', '再戳', '胆子不小', '警告', '生气', '炸毛', '别惹']) ||
        includesAny(normalized, ['poke', 'warning'])
    ) {
        return { scene: 'angry', probability: 0.34, reason: '吐槽或警告语气' };
    }

    if (
        (input.emotion && input.emotion.valence < -0.32) ||
        includesAny(combined, ['难过', '委屈', '伤心', '哭', '安慰', '抱抱', '摸摸', '别难过', '没事', '加油', '辛苦', '别怕', '会好的', '谢谢', '感谢'])
    ) {
        return { scene: 'comfort', probability: 0.38, reason: '安慰场景' };
    }

    if (
        /[？?]/.test(combined) ||
        includesAny(combined, ['什么', '怎么', '为啥', '为什么', '咋', '吗', '欸', '诶', '疑问', '问号'])
    ) {
        return { scene: 'question', probability: 0.24, reason: '疑问场景' };
    }

    if (
        includesAny(combined, ['早安', '早上好', '午安', '晚安', '你好', '拜拜', '回见', '哈哈', '开心', '可爱', '吃瓜', '摸鱼', '打卡', '想你'])
        || (input.emotion && input.emotion.valence > 0.28)
    ) {
        return { scene: 'daily', probability: 0.22, reason: '日常闲聊场景' };
    }

    return null;
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const candidates = [
        trimmed,
        trimmed.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim(),
    ];

    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of candidates) {
        const parsed = safeParseJson(candidate);
        if (isRecord(parsed)) {
            return parsed;
        }
    }

    return null;
}

async function inferSceneByLlm(input: AutoMemeDecisionInput): Promise<{ shouldSend: boolean; scene?: string; reason: string }> {
    const packs = memeCatalog.listPacks();
    const scenes = Array.from(new Set(
        packs.flatMap(pack => pack.scenes.map(scene => scene.trim().toLowerCase()).filter(Boolean))
    ));

    if (scenes.length === 0) {
        return { shouldSend: false, reason: '没有可用场景' };
    }

    const sceneHints = scenes.map(scene => {
        const scenePacks = packs.filter(pack => pack.scenes.some(item => item.toLowerCase() === scene));
        const labels = scenePacks.slice(0, 3).map(pack => pack.label).join('、');
        return `- ${scene}: ${labels || '无说明'}`;
    }).join('\n');

    const systemPrompt = `你是 QQ 机器人“自动发表情包”的决策器。
你的任务：根据“用户原消息”和“机器人本轮回复”，判断这轮回复末尾是否适合追加一张表情包图片。

要求：
1. 只在明显适合的时候返回 shouldSend=true。
2. scene 只能从给定场景里选一个；如果不适合发送则 scene 为空字符串。
3. 不要把“总是发图”当成目标，重点是贴合语气、场景和节奏。
4. 只输出 JSON，不要输出解释文本或 Markdown。

可选场景：
${sceneHints}

JSON 格式：
{"shouldSend":true,"scene":"daily","reason":"简短说明"}`;

    const userPrompt = `用户原消息：
${input.message.text?.trim() || '(空)'}

机器人本轮回复：
${(input.replyText || '').trim() || '(空)'}

发送环境：
- 会话类型: ${input.message.type}
- 是否已有媒体输出: ${input.toolAlreadySentMedia ? '是' : '否'}

请判断这轮是否应该在回复末尾追加 1 张表情包。`;

    const raw = await autoMemeLlm.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ], {
        temperature: 0.1,
        max_tokens: 300,
    }, 'auto-meme-judge');
    const parsed = extractJsonObject(raw);
    if (!parsed) {
        throw new Error('自动表情判定未返回有效 JSON');
    }

    const shouldSend = parsed.shouldSend === true;
    const scene = typeof parsed.scene === 'string' ? parsed.scene.trim().toLowerCase() : '';
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim()
        : 'LLM 未提供原因';

    if (!shouldSend) {
        return { shouldSend: false, reason };
    }

    if (!scene || !scenes.includes(scene)) {
        return { shouldSend: false, reason: `LLM 返回了无效场景: ${scene || '(空)'}` };
    }

    return { shouldSend: true, scene, reason };
}

function getRecentFiles(sessionKey: string): string[] {
    return recentFilesBySession.get(sessionKey) || [];
}

function pushRecentFiles(sessionKey: string, files: string[]): void {
    const merged = [...getRecentFiles(sessionKey), ...files];
    const limit = Math.max(1, config.autoMeme.maxRecentPerSession);
    recentFilesBySession.set(sessionKey, merged.slice(-limit));
}

function getRecentFilesByPack(sessionKey: string, packId: string): string[] {
    return recentFilesByPackSession.get(`${sessionKey}:${packId}`) || [];
}

function pushRecentFilesByPack(sessionKey: string, packId: string, files: string[]): void {
    const key = `${sessionKey}:${packId}`;
    const merged = [...getRecentFilesByPack(sessionKey, packId), ...files];
    const limit = Math.max(1, config.autoMeme.maxRecentPerPackPerSession);
    recentFilesByPackSession.set(key, merged.slice(-limit));
}

export async function decideAutoMeme(input: AutoMemeDecisionInput): Promise<AutoMemeDecision> {
    if (!config.autoMeme.enabled) {
        return { shouldSend: false, reason: '自动表情包已禁用', segments: [], files: [] };
    }

    if (config.autoMeme.disableInPrivate && input.message.type !== 'group') {
        return { shouldSend: false, reason: '私聊场景已禁用自动表情包', segments: [], files: [] };
    }

    if (config.autoMeme.disableWhenToolSentMedia && input.toolAlreadySentMedia) {
        return { shouldSend: false, reason: '本轮已有媒体输出', segments: [], files: [] };
    }

    const replyText = (input.replyText || '').trim();
    if (!replyText) {
        return { shouldSend: false, reason: '没有可附着的回复文本', segments: [], files: [] };
    }

    if (replyText.length > 180) {
        return { shouldSend: false, reason: '回复过长，跳过自动表情', segments: [], files: [] };
    }

    const sessionKey = getSessionKey(input.message);
    const now = Date.now();
    if ((sessionCooldownUntil.get(sessionKey) || 0) > now) {
        return { shouldSend: false, reason: '会话冷却中', segments: [], files: [] };
    }
    if ((userCooldownUntil.get(input.message.sender_id) || 0) > now) {
        return { shouldSend: false, reason: '用户冷却中', segments: [], files: [] };
    }

    const profile = safeGetProfile(input.message.sender_id);
    let inferred: { shouldSend: boolean; scene?: string; reason: string };
    try {
        inferred = await inferSceneByLlm(input);
    } catch (error) {
        const fallback = inferSceneByRules(input);
        if (!fallback) {
            return {
                shouldSend: false,
                reason: `LLM 判定失败且规则未命中: ${error instanceof Error ? error.message : String(error)}`,
                segments: [],
                files: [],
            };
        }

        log.warn('🎭 自动表情 LLM 判定失败，已回退规则判定', error);
        inferred = { shouldSend: true, scene: fallback.scene, reason: `规则回退: ${fallback.reason}` };
    }

    if (!inferred.shouldSend || !inferred.scene) {
        return { shouldSend: false, reason: inferred.reason, segments: [], files: [] };
    }

    let probability = Math.max(0, Math.min(1, config.autoMeme.probability));
    if (profile?.favorability !== undefined) {
        if (profile.favorability >= 75) probability = Math.min(1, probability + 0.06);
        if (profile.favorability <= 25) probability = Math.max(0.05, probability - 0.05);
    }

    if (Math.random() > probability) {
        return { shouldSend: false, reason: `全局概率未命中 (${probability.toFixed(2)})`, segments: [], files: [] };
    }

    const packs = memeCatalog.findPacksByScene(inferred.scene)
        .filter(pack => (packCooldownUntil.get(`${sessionKey}:${pack.id}`) || 0) <= now);
    if (packs.length === 0) {
        return { shouldSend: false, reason: `场景 ${inferred.scene} 没有可用表情包`, segments: [], files: [] };
    }

    const pack = memeCatalog.pickRandomPack(packs);
    if (!pack) {
        return { shouldSend: false, reason: '未选中表情包', segments: [], files: [] };
    }

    const excludedFiles = Array.from(new Set([
        ...getRecentFiles(sessionKey),
        ...getRecentFilesByPack(sessionKey, pack.id),
    ]));
    const files = memeCatalog.pickFiles(pack, 1, excludedFiles);
    if (files.length === 0) {
        return { shouldSend: false, reason: '未找到可发送的图片文件', segments: [], files: [] };
    }

    sessionCooldownUntil.set(sessionKey, now + Math.max(0, config.autoMeme.perSessionCooldownMs));
    userCooldownUntil.set(input.message.sender_id, now + Math.max(0, config.autoMeme.perUserCooldownMs));
    packCooldownUntil.set(`${sessionKey}:${pack.id}`, now + Math.max(0, pack.cooldownSec * 1000));
    pushRecentFiles(sessionKey, files);
    pushRecentFilesByPack(sessionKey, pack.id, files);

    log.info(`🎭 自动表情命中: scene=${inferred.scene} pack=${pack.id} reason=${inferred.reason}`);

    return {
        shouldSend: true,
        reason: inferred.reason,
        packId: pack.id,
        segments: memeCatalog.buildSegments(files),
        files,
    };
}

export function selectManualMeme(options: {
    query?: string;
    scene?: string;
    count?: number;
}): { pack: ResolvedMemePack | null; segments: MessageSegment[]; files: string[] } {
    const count = Math.min(Math.max(1, Math.floor(options.count || 1)), 5);
    const pack = options.query
        ? memeCatalog.findPackByQuery(options.query)
        : options.scene
            ? memeCatalog.pickRandomPack(memeCatalog.findPacksByScene(options.scene))
            : memeCatalog.pickRandomPack(memeCatalog.listPacks());

    if (!pack) {
        return { pack: null, segments: [], files: [] };
    }

    const files = memeCatalog.pickFiles(pack, count);
    return {
        pack,
        files,
        segments: memeCatalog.buildSegments(files),
    };
}

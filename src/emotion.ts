/**
 * sentra-emo 情感分析服务客户端
 * 调用本地 FastAPI 服务进行情绪/VAD/压力分析
 */

import { getEmotionServiceConfig } from './config.js';
import { log } from './logger.js';

/** sentra-emo 分析结果 */
export interface EmotionResult {
    // 情感三元组
    valence: number;   // 愉悦度 [-1, 1]
    arousal: number;   // 激活度 [-1, 1]
    dominance: number; // 支配度 [-1, 1]

    // 压力值 [0, 1]
    stress: number;

    // 情绪标签 (top emotions)
    emotions: Array<{
        label: string;
        score: number;
    }>;

    // 情感倾向
    sentiment: 'positive' | 'negative' | 'neutral';
}

function getSentraEmoUrl(): string {
    return getEmotionServiceConfig().baseUrl;
}

/** API 响应接口 */
interface SentraEmoResponse {
    vad?: {
        valence: number;
        arousal: number;
        dominance: number;
    };
    stress?: {
        value: number;
    };
    emotions?: Array<{
        label: string;
        score: number;
    }>;
    sentiment?: {
        label: string;
    };
}

/**
 * 调用 sentra-emo 分析文本情感
 */
export async function analyzeEmotion(
    text: string,
    userId?: string,
    userName?: string
): Promise<EmotionResult | null> {
    if (!text || text.trim().length === 0) {
        return null;
    }

    try {
        const response = await fetch(`${getSentraEmoUrl()}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: text.trim(),
                userid: userId,
                username: userName,
                update_user: true,  // 更新用户画像
            }),
        });

        if (!response.ok) {
            log.warn(`sentra-emo 请求失败: ${response.status}`);
            return null;
        }

        const data = await response.json() as unknown as SentraEmoResponse;

        // 解析响应
        const result: EmotionResult = {
            valence: data.vad?.valence ?? 0,
            arousal: data.vad?.arousal ?? 0,
            dominance: data.vad?.dominance ?? 0,
            stress: data.stress?.value ?? 0,
            emotions: (data.emotions || []).slice(0, 5).map((e) => ({
                label: e.label,
                score: e.score,
            })),
            sentiment: data.sentiment?.label === 'POSITIVE' ? 'positive'
                : data.sentiment?.label === 'NEGATIVE' ? 'negative'
                    : 'neutral',
        };

        log.debug(`情感分析: V=${result.valence.toFixed(2)} A=${result.arousal.toFixed(2)} S=${result.stress.toFixed(2)} [${result.sentiment}]`);

        return result;
    } catch (err) {
        log.warn('sentra-emo 调用失败:', err);
        return null;
    }
}

/**
 * 获取用户画像
 */
export async function getUserProfile(userId: string): Promise<unknown> {
    try {
        const response = await fetch(`${getSentraEmoUrl()}/user/${userId}`);
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

/**
 * 检查 sentra-emo 服务是否可用
 */
export async function checkSentraEmoHealth(): Promise<boolean> {
    try {
        const emotionConfig = getEmotionServiceConfig();
        const response = await fetch(`${emotionConfig.baseUrl}/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(emotionConfig.healthTimeoutMs),
        });
        return response.ok;
    } catch {
        return false;
    }
}

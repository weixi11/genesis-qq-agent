/**
 * JSON 工具库
 */
import { log } from '../logger.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function safeParseJson(text: string): unknown | null {
    if (!text) return null;

    try {
        return JSON.parse(text) as unknown;
    } catch (err) {
        log.debug('JSON 解析失败:', String(err).slice(0, 100));
        return null;
    }
}

export function safeParseRecord(text: string): Record<string, unknown> | null {
    const parsed = safeParseJson(text);
    return isRecord(parsed) ? parsed : null;
}

/**
 * 安全解析 LLM 返回的 JSON
 * 自动处理 Markdown 代码块 (```json ... ```)
 * 
 * @param text LLM 返回的文本
 * @returns 解析后的对象，如果失败返回 null
 */
export function safeParseLLMJson<T>(text: string): T | null {
    if (!text) return null;

    try {
        let jsonStr = text.trim();

        // 尝试提取 Markdown 代码块
        const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match && match[1]) {
            jsonStr = match[1];
        } else {
            // 尝试提取纯 JSON 对象
            const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (objectMatch) {
                jsonStr = objectMatch[0];
            }
        }

        const parsed = safeParseJson(jsonStr);
        return parsed as T | null;
    } catch (err) {
        // debug 级别即可，因为 LLM 输出不稳定是常态
        log.debug('JSON 解析失败:', String(err).slice(0, 100));
        return null;
    }
}

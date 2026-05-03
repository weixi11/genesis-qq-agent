/**
 * AnimeTrace 模块 - 动漫/Galgame/二次元游戏角色识别
 *
 * 使用 AnimeTrace API 识别图片中的角色身份和出处
 * API 文档: https://ai.animedb.cn/api-docs/
 */

import fs from 'fs';
import path from 'path';
import { log } from '../../logger.js';
import { getNapcatCacheDir } from '../../utils/napcatPath.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// ==================== 类型定义 ====================

/** 单个角色识别结果 */
interface AnimeTraceCharacter {
    /** 角色名称 */
    character: string;
    /** 所属作品名称 */
    work: string;
}

/** 单个检测到的人物区域 */
interface AnimeTraceBox {
    /** 边界框坐标 [x1, y1, x2, y2] */
    box: number[];
    /** 该区域的角色识别候选结果列表 */
    character: AnimeTraceCharacter[];
}

/** AnimeTrace API 响应 */
interface AnimeTraceResponse {
    /** 状态码 0 或 17720 = 成功 */
    code: number;
    /** 检测到的人物区域列表 */
    data: AnimeTraceBox[];
    /** AI 生成图检测结果 */
    ai?: boolean | number;
}

// ==================== 常量 ====================

/** 模式到模型的映射 */
const MODE_MODEL_MAP: Record<string, string> = {
    anime: 'anime',
    game: 'full_game_model_kira',
};

/** 每个区域最多展示的候选数量 */
const MAX_CANDIDATES_PER_BOX = 3;

/** API 请求超时（毫秒） */
const API_TIMEOUT_MS = 25000;

// ==================== 模块元数据 ====================

export const name = 'anime_trace';
export const description = '识别动漫/Galgame/二次元游戏角色';
export const keywords = [
    '识别角色', '角色识别', '动漫识别', '这是谁', '什么角色',
    '哪个角色', 'gal识别', '谁画的', '哪部动漫', '哪个番',
    '什么番', '出自哪里', '二次元识别',
];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 内部函数 ====================

/** 解析使用的模型名称 */
function resolveModel(params: Record<string, unknown>): string {
    // 优先使用明确指定的 model
    const rawModel = params.model as string | undefined;
    if (rawModel && typeof rawModel === 'string') {
        return rawModel;
    }

    // 快捷模式
    const mode = params.mode as string | undefined;
    if (mode && typeof mode === 'string' && MODE_MODEL_MAP[mode]) {
        return MODE_MODEL_MAP[mode];
    }

    return config.defaultModel;
}

/** 调用 AnimeTrace API */
async function callAnimeTraceApi(imageUrl: string, model: string): Promise<AnimeTraceResponse> {
    const formData = new FormData();

    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        formData.append('url', imageUrl);
    } else if (imageUrl.startsWith('data:')) {
        const matches = imageUrl.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,(.*)$/);
        if (matches && matches.length === 3) {
            const buffer = Buffer.from(matches[2], 'base64');
            const blob = new Blob([buffer], { type: matches[1] });
            formData.append('file', blob, 'image.jpg');
        } else {
            throw new Error('Invalid data URI');
        }
    } else {
        let resolvedPath = imageUrl;
        if (!fs.existsSync(resolvedPath)) {
            const napcatCacheDir = getNapcatCacheDir();
            const filename = path.basename(imageUrl);
            const cachedPath = path.join(napcatCacheDir, filename);
            if (fs.existsSync(cachedPath)) {
                resolvedPath = cachedPath;
            } else {
                throw new Error(`找不到图片文件: ${imageUrl}`);
            }
        }
        const buffer = fs.readFileSync(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();
        const mimeTypes: Record<string, string> = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.bmp': 'image/bmp',
        };
        const mimeType = mimeTypes[ext] || 'image/jpeg';
        const blob = new Blob([buffer], { type: mimeType });
        formData.append('file', blob, path.basename(resolvedPath));
    }

    formData.append('model', model);
    formData.append('is_multi', String(config.defaultMulti));
    formData.append('ai_detect', '0');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
        const response = await fetch(config.apiUrl, {
            method: 'POST',
            body: formData,
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json() as AnimeTraceResponse;
        return data;
    } finally {
        clearTimeout(timeout);
    }
}

/** 格式化识别结果为可读文本 */
function formatResult(data: AnimeTraceBox[]): string {
    if (!data || data.length === 0) {
        return '没有识别到任何角色喵，换一张更清晰的图片试试~';
    }

    const lines: string[] = [];

    for (let i = 0; i < data.length; i++) {
        const box = data[i];
        if (!box.character || box.character.length === 0) continue;

        if (data.length > 1) {
            lines.push(`👤 角色 ${i + 1}:`);
        }

        const validChars = box.character.slice(0, MAX_CANDIDATES_PER_BOX);

        if (validChars.length === 0) {
            lines.push('  未能确定角色身份');
            continue;
        }

        for (let j = 0; j < validChars.length; j++) {
            const c = validChars[j];
            const prefix = j === 0 ? '🎯' : `  #${j + 1}`;
            lines.push(`${prefix} ${c.character} — 「${c.work}」`);
        }
    }

    if (lines.length === 0) {
        return '没有识别到任何角色喵，换一张更清晰的图片试试~';
    }

    return lines.join('\n');
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    ctx: ToolContext
): Promise<ToolResult> {
    const imageUrls = ctx.imageUrls || [];

    if (imageUrls.length === 0) {
        return { success: false, text: '没看到图片呢，发一张动漫/游戏图片给我识别角色喵~' };
    }

    const model = resolveModel(params);
    const targetUrl = imageUrls[0];

    try {
        log.info(`🔍 模块: AnimeTrace 角色识别 model=${model} url=${targetUrl.slice(0, 80)}...`);

        const result = await callAnimeTraceApi(targetUrl, model);

        if (result.code !== 0 && result.code !== 200 && result.code !== 17720) {
            log.warn(`AnimeTrace API 返回异常状态码: ${result.code}`);
            return { success: false, text: `角色识别服务返回错误 (code: ${result.code})，请稍后再试喵~` };
        }

        const text = formatResult(result.data);

        return {
            success: true,
            text,
            data: {
                model,
                imageUrl: (targetUrl.startsWith('base64://') || targetUrl.startsWith('data:image'))
                    ? `${targetUrl.substring(0, 50)}...[Base64 Data Truncated]`
                    : targetUrl,
                boxCount: result.data?.length ?? 0,
                aiDetect: result.ai,
            },
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('abort')) {
            log.warn('AnimeTrace API 请求超时');
            return { success: false, text: '角色识别请求超时了喵，服务器可能繁忙，请稍后再试~' };
        }
        log.error('AnimeTrace 角色识别失败:', err);
        return { success: false, text: `角色识别失败了喵: ${message}` };
    }
}

// ==================== 任务配置 ====================

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

// ==================== 默认导出 ====================

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;

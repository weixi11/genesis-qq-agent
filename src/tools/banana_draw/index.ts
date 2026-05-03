/**
 * Banana Draw 模块
 */

import { log } from '../../logger.js';
import { config } from './config.js';
import { schema } from './schema.js';
import { collectImageSources, normalizeInputImage } from './input.js';
import { prepareOutputImages } from './output.js';
import { buildBananaPrompt, getPresetPrompt, normalizeBananaMode } from './presets.js';
import { requestBananaDraw } from './api.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

export const name = 'banana_draw';
export const description = '高级 Banana 绘图工具，支持文生图、带图改图、手办化、四格漫画、自拍化等。可通过关键词或配置切换为普通绘图入口。';
export const keywords = ['banana', '香蕉画图', '手办化', '四格漫画', '自拍化', 'banana_draw'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

export async function execute(
    params: Record<string, unknown>,
    ctx: ToolContext,
): Promise<ToolResult> {
    const mode = normalizeBananaMode(params.mode);
    const rawPrompt = String(params.prompt ?? params.text ?? '').trim();
    const imageSources = collectImageSources(params, ctx);
    const normalizedImages = await Promise.all(imageSources.map((source) => normalizeInputImage(source)));
    const inputImages = normalizedImages.filter((item): item is NonNullable<typeof item> => item !== null);
    const preserveIdentity = params.preserveIdentity === true
        || (params.preserveIdentity !== false && (mode === 'selfie' || (mode !== 'generate' && inputImages.length > 0)));
    const presetPrompt = getPresetPrompt(mode);
    const finalPrompt = buildBananaPrompt(rawPrompt, mode, preserveIdentity);

    if (!rawPrompt && !presetPrompt) {
        return { success: false, text: '要怎么画呀？至少告诉我风格、玩法，或者直接发图让我改喵~' };
    }

    if (imageSources.length > 0 && inputImages.length === 0) {
        return { success: false, text: '参考图读取失败了喵，换一张图片再试试吧~' };
    }

    const size = typeof params.size === 'string' && params.size.trim() ? params.size.trim() : config.imageSize;

    try {
        const result = await requestBananaDraw(finalPrompt, inputImages, size);
        const preparedImages = await prepareOutputImages(result.images);
        const segments = preparedImages.map((item) => item.segment);
        const remoteUrls = preparedImages.map((item) => item.remoteUrl).filter((item): item is string => typeof item === 'string' && item.length > 0);
        const localPaths = preparedImages.map((item) => item.localPath).filter((item): item is string => typeof item === 'string' && item.length > 0);

        if (segments.length === 0 && !result.text.trim()) {
            return { success: false, text: 'Banana 绘图没有返回可发送的内容喵~' };
        }

        return {
            success: true,
            text: segments.length > 0
                ? `🍌 Banana 处理完成喵~${result.text ? `\n${result.text}` : ''}`
                : result.text || '🍌 Banana 处理完成喵~',
            segments,
            data: {
                mode,
                apiMode: result.apiMode,
                model: result.model,
                inputImageCount: inputImages.length,
                remoteUrls,
                localPaths,
                prompt: finalPrompt,
            },
        };
    } catch (error) {
        log.error('banana_draw 执行失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, text: `Banana 绘图失败了喵: ${message}` };
    }
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;

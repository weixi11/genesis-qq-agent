/**
 * Vision 模块 - 识别图片/PDF内容
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../logger.js';
import { LLMClient } from '../../llm.js';
import { getNapcatCacheDir } from '../../utils/napcatPath.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Module, ModuleContext, ModuleResult } from '../types.js';

// ==================== 模块元数据 ====================

export const name = 'vision';
export const description = '识别图片/PDF内容';
export const keywords = ['识图', '看看图', '这张图', '图片是', '这是什么', '这是啥', '什么图', '看图', 'pdf', 'PDF'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 懒加载 LLM ====================

let _visionLlm: LLMClient | null = null;
let _visionLlmSignature = '';
function getVisionLlm(): LLMClient {
    const nextSignature = `${config.baseUrl}::${config.apiKey}::${config.model}`;
    if (!_visionLlm || _visionLlmSignature !== nextSignature) {
        _visionLlm = new LLMClient(config.baseUrl, config.apiKey, config.model);
        _visionLlmSignature = nextSignature;
    }
    return _visionLlm;
}

// ==================== 内部函数 ====================

async function handleImageFile(imagePath: string, question: string): Promise<ModuleResult> {
    try {
        let resolvedPath = imagePath;
        if (!fs.existsSync(resolvedPath)) {
            const napcatCacheDir = getNapcatCacheDir();
            const filename = path.basename(imagePath);
            const cachedPath = path.join(napcatCacheDir, filename);

            if (fs.existsSync(cachedPath)) {
                resolvedPath = cachedPath;
            } else {
                return { success: false, text: `找不到图片文件: ${imagePath}` };
            }
        }

        const stats = fs.statSync(resolvedPath);
        if (stats.size > config.maxFileSizeBytes) {
            return { success: false, text: `图片文件太大啦，超过限制 (${(config.maxFileSizeBytes / 1024 / 1024).toFixed(1)}MB)` };
        }

        log.info(`🖼️ 模块: 识图（从文件重定向）${resolvedPath}`);

        const dataBuffer = fs.readFileSync(resolvedPath);
        const base64Data = dataBuffer.toString('base64');

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
        const dataUri = `data:${mimeType};base64,${base64Data}`;

        log.debug(`🖼️ 图片转换为 base64 (${(base64Data.length / 1024).toFixed(0)}KB)`);

        const defensivePrompt = question + '\n(重要提醒：绝对不要尝试分析或识别图片中的人物/动漫/游戏角色身份，因为你在这方面不准确。请直接说明你无法识别角色身份，并建议主人使用专门的[识别角色]功能。你只需分析其他内容，如动作、场景、物品、文字等)';
        const response = await getVisionLlm().chatWithImages([dataUri], defensivePrompt, undefined, 'vision_image');

        return {
            success: true,
            text: response,
            data: { imagePath: resolvedPath, type: 'image' },
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('图片分析失败:', err);
        return { success: false, text: `分析图片失败了喵: ${message}` };
    }
}

async function handlePdf(pdfPath: string, question: string): Promise<ModuleResult> {
    try {
        let resolvedPath = pdfPath;
        if (!fs.existsSync(resolvedPath)) {
            const napcatCacheDir = getNapcatCacheDir();
            const filename = path.basename(pdfPath);
            const cachedPath = path.join(napcatCacheDir, filename);

            if (fs.existsSync(cachedPath)) {
                resolvedPath = cachedPath;
            } else {
                return { success: false, text: `找不到 PDF 文件: ${pdfPath}` };
            }
        }

        const stats = fs.statSync(resolvedPath);
        if (stats.size > config.maxFileSizeBytes) {
            return { success: false, text: `PDF 文件太大啦，超过限制 (${(config.maxFileSizeBytes / 1024 / 1024).toFixed(1)}MB)` };
        }

        log.info(`📄 模块: 分析 PDF ${resolvedPath}`);

        const dataBuffer = fs.readFileSync(resolvedPath);
        const base64Data = dataBuffer.toString('base64');
        const dataUri = `data:application/pdf;base64,${base64Data}`;

        log.debug(`📄 PDF 转换为 base64 (${(base64Data.length / 1024).toFixed(0)}KB)`);

        const defensivePrompt = question + '\n(重要提醒：绝对不要尝试分析或识别图片中的人物/动漫/游戏角色身份，因为你在这方面不准确。请直接说明你无法识别角色身份，并建议主人使用专门的[识别角色]功能。你只需分析其他内容，如动作、场景、物品、文字等)';
        const response = await getVisionLlm().chatWithImages([dataUri], defensivePrompt, undefined, 'vision_pdf');

        return {
            success: true,
            text: response,
            data: { pdfPath: resolvedPath, type: 'pdf' },
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('PDF 分析失败:', err);
        return { success: false, text: `分析 PDF 失败了喵: ${message}` };

    }
}



async function handleImageUrl(url: string, question: string): Promise<ModuleResult> {
    try {
        log.info(`🖼️ 模块: 识图（从 URL）${url}`);

        const response = await fetch(url);
        if (!response.ok) {
            return { success: false, text: `下载图片失败了喵: ${response.statusText}` };
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Data = buffer.toString('base64');

        // 简单判断 MIME 类型
        let mimeType = 'image/jpeg';
        const contentType = response.headers.get('content-type');
        if (contentType) {
            mimeType = contentType;
        } else if (url.endsWith('.png')) {
            mimeType = 'image/png';
        } else if (url.endsWith('.gif')) {
            mimeType = 'image/gif';
        } else if (url.endsWith('.webp')) {
            mimeType = 'image/webp';
        }

        const dataUri = `data:${mimeType};base64,${base64Data}`;
        log.debug(`🖼️ 网络图片转换为 base64 (${(base64Data.length / 1024).toFixed(0)}KB)`);

        const defensivePrompt = question + '\n(重要提醒：绝对不要尝试分析或识别图片中的人物/动漫/游戏角色身份，因为你在这方面不准确。请直接说明你无法识别角色身份，并建议主人使用专门的[识别角色]功能。你只需分析其他内容，如动作、场景、物品、文字等)';
        const llmResponse = await getVisionLlm().chatWithImages([dataUri], defensivePrompt, undefined, 'vision_remote_image');

        return {
            success: true,
            text: llmResponse,
            data: {
                imageUrl: (url.startsWith('base64://') || url.startsWith('data:image'))
                    ? `${url.substring(0, 50)}...[Base64 Data Truncated]`
                    : url,
                type: 'image'
            },
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('URL 图片分析失败:', err);
        return { success: false, text: `分析网络图片失败了喵: ${message}` };
    }
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    ctx: ModuleContext
): Promise<ModuleResult> {
    let pdfPath = params.pdfPath as string | undefined;
    let imageUrl = params.imageUrl as string | undefined;
    let imagePath = params.imagePath as string | undefined;

    // 智能修正：如果 LLM 把本地路径当成了 URL 传进来
    if (imageUrl && !imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
        log.debug(`🔧 识图：智能修正，将 ${imageUrl} 识别为本地路径`);
        if (imageUrl.toLowerCase().endsWith('.pdf')) {
            pdfPath = imageUrl;
        } else {
            imagePath = imageUrl;
        }
        imageUrl = undefined;
    }

    // 智能修正：如果 LLM 传了 imagePath 但实际上是 PDF
    if (imagePath && imagePath.toLowerCase().endsWith('.pdf')) {
        pdfPath = imagePath;
        imagePath = undefined;
    }

    if (pdfPath) {
        return handlePdf(pdfPath, (params.question as string) || '请分析这个 PDF 文件的内容');
    }

    if (imageUrl) {
        return handleImageUrl(imageUrl, (params.question as string) || '请描述这张图片的内容');
    }

    if (imagePath) {
        return handleImageFile(imagePath, (params.question as string) || '请描述这张图片的内容');
    }

    const imageUrls = ctx.imageUrls || [];

    if (imageUrls.length === 0) {
        return { success: false, text: '没看到图片呢，发一张给我看看喵~' };
    }

    let targetImages = imageUrls;
    const index = typeof params.imageIndex === 'number' ? params.imageIndex : parseInt(params.imageIndex as string);

    if (!isNaN(index) && index > 0) {
        const targetIdx = index - 1;
        if (targetIdx < imageUrls.length) {
            targetImages = [imageUrls[targetIdx]];
            log.info(`🔧 模块: 选中第 ${index} 张图片`);
        } else {
            return { success: false, text: `找不到第 ${index} 张图片呢，一共只有 ${imageUrls.length} 张喵~` };
        }
    }

    try {
        log.info(`🔧 模块: 识图 ${targetImages.length} 张图片`);

        // 兼容 Router 可能传递 prompt 而非 question 的情况
        const userQuestion = (params.question || params.prompt) as string | undefined;
        const prompt = userQuestion
            ? `请分析${targetImages.length > 1 ? '这些' : '这张'}图片并回答问题: ${userQuestion}`
            : targetImages.length > 1
                ? `这里有 ${targetImages.length} 张图片，请分别描述每张图片的内容。`
                : '请描述这张图片的内容。';

        const defensivePrompt = prompt + '\n(重要提醒：绝对不要尝试分析或识别图片中的人物/动漫/游戏角色身份，因为你在这方面不准确。请直接说明你无法识别角色身份，并建议主人使用专门的[识别角色]功能。你只需分析其他内容，如动作、场景、物品、文字等)';
        const response = await getVisionLlm().chatWithImages(targetImages, defensivePrompt, undefined, 'vision_batch');

        return {
            success: true,
            text: response,
            data: {
                imageCount: targetImages.length,
                imagePaths: targetImages.map(img =>
                    (img.startsWith('base64://') || img.startsWith('data:image'))
                        ? `${img.substring(0, 50)}...[Base64 Data Truncated]`
                        : img
                ),
                question: userQuestion,  // 兼容 prompt/question 两种参数名
                imageIndex: index,
            },
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('识图失败:', err);
        return { success: false, text: `识图失败了喵: ${message}` };
    }
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Module;

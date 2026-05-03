/**
 * Draw 模块 - AI 绘图
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../logger.js';
import { config } from './config.js';
import { schema } from './schema.js';
import { resolveFileForSend } from '../../utils/file.js';
import { buildPersonaSelfDrawPrompt } from '../../utils/personaLoader.js';
import { applyDrawToolSelfReferenceFallback } from '../../utils/selfReferenceDraw.js';
import type { Module, ModuleContext, ModuleResult } from '../types.js';

// ==================== 类型定义 ====================

/** images/generations API 响应格式 */
interface DrawImageResponse {
    created: number;
    data: Array<{
        url?: string;
        b64_json?: string;
        revised_prompt?: string;
    }>;
}

interface DrawParams {
    prompt?: string;
    text?: string;
    size?: string;
    selfReference?: boolean;
    botAppearance?: string;
    personaPromptResolved?: boolean;
    detectedSelfReference?: boolean;
    selfReferenceSource?: string;
    promptResolutionMode?: string;
}

// ==================== 模块元数据 ====================

export const name = 'draw';
export const description = 'AI 绘图。prompt 优先使用英文标签或简洁英文短语；如果是画机器人自己，传 selfReference=true，工具会自动注入当前人设外貌锚点。';
export const keywords = ['画', '绘', '生成图', '画一个', '画一张', 'draw', 'paint'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 内部函数 ====================

const IMAGE_SAVE_DIR = path.join(process.cwd(), 'data', 'images');

function ensureImageDir(): void {
    if (!fs.existsSync(IMAGE_SAVE_DIR)) {
        fs.mkdirSync(IMAGE_SAVE_DIR, { recursive: true });
        log.debug(`🎨 创建图片目录: ${IMAGE_SAVE_DIR}`);
    }
}

/** 默认绘图尺寸 */
const DEFAULT_IMAGE_SIZE = '1024x1024';

async function downloadImageBuffer(imageUrl: string): Promise<Buffer | null> {
    try {
        const response = await fetch(imageUrl);
        if (!response.ok) {
            log.warn(`下载图片失败: ${response.status}`);
            return null;
        }
        return Buffer.from(await response.arrayBuffer());
    } catch (err) {
        log.warn('下载图片失败:', err);
        return null;
    }
}

function saveImageToLocal(buffer: Buffer, imageUrl: string): string | null {
    try {
        ensureImageDir();
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 8);
        const ext = imageUrl.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || 'webp';
        const filename = `draw_${timestamp}_${random}.${ext}`;
        const localPath = path.join(IMAGE_SAVE_DIR, filename);
        fs.writeFileSync(localPath, buffer);
        log.debug(`🎨 图片已保存: ${localPath} (${Math.round(buffer.length / 1024)}KB)`);
        return localPath;
    } catch (err) {
        log.warn('保存图片失败:', err);
        return null;
    }
}

function bufferToBase64(buffer: Buffer): string {
    return `base64://${buffer.toString('base64')}`;
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    _ctx: ModuleContext
): Promise<ModuleResult> {
    const p = applyDrawToolSelfReferenceFallback(params) as DrawParams;
    let prompt = p.prompt || p.text || '';

    if (!prompt) {
        return { success: false, text: '要画什么呀？告诉我想画的内容喵~' };
    }

    const size = p.size || DEFAULT_IMAGE_SIZE;

    // 自引用处理
    const isSelfRef = p.selfReference === true;
    if (isSelfRef && p.personaPromptResolved === true) {
        log.info('🎨 模块: 自引用绘图，使用上游已生成的最终 prompt');
        log.debug(`🎨 最终 prompt: "${prompt.slice(0, 120)}..."`);
    } else if (isSelfRef) {
        const originalPrompt = prompt;
        prompt = buildPersonaSelfDrawPrompt(prompt, p.botAppearance);
        log.info(`🎨 模块: 自引用绘图，注入人设外貌`);
        if (p.promptResolutionMode === 'draw_tool_fallback') {
            log.info('🎨 模块: 在 draw 工具末端自动识别到自画像请求，补走自画像链路');
        }
        log.debug(`🎨 原始 prompt: "${originalPrompt}"`);
        log.debug(`🎨 融合后 prompt: "${prompt.slice(0, 100)}..."`);
    } else {
        log.info(`🎨 模块: 绘图 "${prompt.slice(0, 50)}..."`);
    }

    try {
        const url = `${config.baseUrl}/images/generations`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
                model: config.model,
                prompt,
                size,
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            log.error('绘图 API 错误:', errText);
            return { success: false, text: '绘图失败了喵，等会再试试~' };
        }

        const data = await response.json() as DrawImageResponse;
        const outputImage = data.data?.[0];
        const remoteUrl = outputImage?.url || null;
        const inlineBuffer = typeof outputImage?.b64_json === 'string' && outputImage.b64_json
            ? Buffer.from(outputImage.b64_json, 'base64')
            : null;

        if (!remoteUrl && !inlineBuffer) {
            log.warn('无法从响应中提取图片URL:', JSON.stringify(data));
            return { success: false, text: '绘图失败了喵，没有得到图片~' };
        }

        log.debug(remoteUrl ? `🎨 绘图成功: ${remoteUrl}` : '🎨 绘图成功: 响应内嵌 base64 图片');

        let imageUrl = remoteUrl || '';
        let localPath: string | null = null;
        let buffer: Buffer | null = inlineBuffer;

        // 优先使用响应内嵌图片；否则再下载远程图用于存档和发送
        if (!buffer && remoteUrl) {
            buffer = await downloadImageBuffer(remoteUrl);
        }

        if (buffer) {
            // 保存到本地
            localPath = saveImageToLocal(buffer, remoteUrl || 'draw.png');
            if (localPath) {
                log.debug(`🎨 图片已保存: ${localPath}`);
            }

            if (config.sendMode === 'base64') {
                imageUrl = bufferToBase64(buffer);
                log.debug(`🎨 使用 base64 发送 (${Math.round(buffer.length / 1024)}KB)`);
            } else if (config.sendMode === 'local' && localPath) {
                imageUrl = resolveFileForSend(localPath);
                log.debug(`🎨 使用本地路径发送: ${localPath}`);
            } else if (!remoteUrl && localPath) {
                imageUrl = resolveFileForSend(localPath);
                log.debug(`🎨 使用本地路径发送内嵌图片: ${localPath}`);
            } else if (!remoteUrl) {
                imageUrl = bufferToBase64(buffer);
                log.debug(`🎨 使用内嵌图片 base64 发送 (${Math.round(buffer.length / 1024)}KB)`);
            } else {
                log.debug('🎨 使用远程 URL 发送');
            }
        } else {
            log.warn('🎨 下载失败，使用远程 URL');
        }

        return {
            success: true,
            text: remoteUrl ? `🎨 画好啦喵~\n${remoteUrl}` : '🎨 画好啦喵~',
            // 统一消息段格式
            segments: [{ type: 'image', data: { file: imageUrl } }],
            data: {
                imageUrl: imageUrl.startsWith('base64://') ? `${imageUrl.substring(0, 50)}...[Base64 Data Truncated]` : imageUrl,
                remoteUrl,
                localPath,
                prompt,
            },
        };
    } catch (err) {
        log.error('绘图失败:', err);
        const errMsg = err instanceof Error ? err.message : '未知错误';
        return { success: false, text: `绘图出错了喵: ${errMsg}` };
    }
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Module;

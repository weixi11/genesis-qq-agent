/**
 * Read Audio 模块 - 听取并分析音频内容
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../logger.js';
import { config } from './config.js';
import { schema } from './schema.js';
import { getNapcatCacheDir } from '../../utils/napcatPath.js';
import type { Module, ModuleContext, ModuleResult } from '../types.js';

// ==================== 模块元数据 ====================

export const name = 'read_audio';
export const description = '听取并分析音频内容';
export const keywords = ['听音频', '分析音频', '这段语音', '声音内容', '音频说什么'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 内部函数 ====================

function checkFileSize(filePath: string): boolean {
    try {
        const stats = fs.statSync(filePath);
        return stats.size <= config.maxFileSizeBytes;
    } catch {
        return false;
    }
}

function resolveFilePath(inputPath: string): string | undefined {
    if (fs.existsSync(inputPath)) {
        return inputPath;
    }

    const napcatCacheDir = getNapcatCacheDir();
    const filename = path.basename(inputPath);
    const cachedPath = path.join(napcatCacheDir, filename);

    if (fs.existsSync(cachedPath)) {
        log.debug(`📁 找到缓存文件: ${cachedPath}`);
        return cachedPath;
    }

    if (!inputPath.includes('/') && !inputPath.includes('\\')) {
        const directPath = path.join(napcatCacheDir, inputPath);
        if (fs.existsSync(directPath)) {
            log.debug(`📁 找到缓存文件: ${directPath}`);
            return directPath;
        }
    }

    return undefined;
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    ctx: ModuleContext
): Promise<ModuleResult> {
    let targetPath = ctx.audioPaths?.[0] || '';
    const index = typeof params.audioIndex === 'number' ? params.audioIndex : parseInt(params.audioIndex as string);

    if (!isNaN(index) && index > 0) {
        if (ctx.audioPaths && index <= ctx.audioPaths.length) {
            targetPath = ctx.audioPaths[index - 1];
            log.info(`🔊 模块: 选中第 ${index} 个语音`);
        } else {
            // audioIndex 找不到对应语音时，如果 LLM 提供了 path 参数则 fallback，否则报错
            const fallbackPath = (params.path as string) || (params.file as string);
            if (!fallbackPath) {
                return { success: false, text: `找不到第 ${index} 个语音呢，一共只有 ${ctx.audioPaths?.length || 0} 个喵~` };
            }
            log.info(`🔊 模块: audioIndex=${index} 无匹配，fallback 到 path 参数`);
        }
    }

    const filePathRaw = (params.path as string) || (params.file as string) || targetPath;
    if (!filePathRaw) {
        return { success: false, text: '请指定要分析的音频文件路径' };
    }

    const inputPath = filePathRaw.replace(/^['"]|['"]$/g, '');
    const filePath = resolveFilePath(inputPath);

    if (!filePath) {
        return { success: false, text: `找不到文件: ${inputPath}` };
    }

    if (!checkFileSize(filePath)) {
        return { success: false, text: `音频文件太大了，超过限制 (${(config.maxFileSizeBytes / 1024 / 1024).toFixed(1)}MB)` };
    }

    const ext = path.extname(filePath).toLowerCase().replace('.', '');

    log.info(`🔊 模块: 分析音频 ${filePath}`);

    try {
        const fileData = fs.readFileSync(filePath);
        const base64Data = fileData.toString('base64');
        const fmt = ext === 'amr' ? 'wav' : ext;

        const url = `${config.baseUrl}/chat/completions`;
        const prompt = (params.question as string | undefined) || "请听这段音频，告诉我里面在说什么，或者是什么声音？";

        const payload = {
            model: config.model,
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    {
                        type: "input_audio",
                        input_audio: {
                            data: base64Data,
                            format: fmt === 'mp3' || fmt === 'wav' ? fmt : 'mp3',
                        },
                    },
                ],
            }],
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API Error ${response.status}: ${errText}`);
        }

        interface ChatCompletionResponse {
            choices?: Array<{ message?: { content?: string } }>;
        }
        const data: ChatCompletionResponse = await response.json() as ChatCompletionResponse;
        const content = data.choices?.[0]?.message?.content || '未获取到内容';

        return {
            success: true,
            text: content,
            data: { filePath, duration: 'unknown' },
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('分析音频失败:', err);
        return { success: false, text: `分析音频出错: ${message}` };
    }
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Module;

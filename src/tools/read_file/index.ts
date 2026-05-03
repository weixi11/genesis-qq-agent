/**
 * Read File 模块 - 读取并分析文件内容
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mammoth = require('mammoth');
const XLSX = require('xlsx');

import { log } from '../../logger.js';
import { getNapcatCacheDir } from '../../utils/napcatPath.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Module, ModuleContext, ModuleResult } from '../types.js';

// ==================== 模块元数据 ====================

export const name = 'read_file';
export const description = '读取并分析文件内容（支持 Word, Excel, 文本等，PDF请用识图工具）';
export const keywords = ['读文件', '读取文件', '分析文件', '看文件', '文件内容', '读文档'];

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

async function readDocx(filePath: string): Promise<string> {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
}

function readExcel(filePath: string): string {
    const workbook = XLSX.readFile(filePath);
    let content = '';

    for (const sheetName of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(worksheet);
        if (csv.trim()) {
            content += `--- Sheet: ${sheetName} ---\n${csv}\n\n`;
        }
    }
    return content;
}

function readText(filePath: string): string {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch {
        return fs.readFileSync(filePath).toString();
    }
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    ctx: ModuleContext
): Promise<ModuleResult> {
    const filePathRaw = (params.path as string) || (params.file as string) || ctx.filePaths?.[0] || '';
    if (!filePathRaw) {
        return { success: false, text: '请指定要读取的文件路径' };
    }

    const inputPath = filePathRaw.replace(/^['"]|['"]$/g, '');
    const filePath = resolveFilePath(inputPath);

    if (!filePath) {
        return { success: false, text: `找不到文件: ${inputPath}` };
    }

    if (!checkFileSize(filePath)) {
        return { success: false, text: `文件太大啦，超过限制 (${(config.maxFileSizeBytes / 1024 / 1024).toFixed(1)}MB)` };
    }

    log.info(`📄 模块: 读取文件 ${filePath}`);

    try {
        const ext = path.extname(filePath).toLowerCase();

        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
        if (imageExts.includes(ext)) {
            return {
                success: false,
                text: '检测到图片文件，请使用识图工具来分析图片内容，我可以帮你看看图片里有什么~',
            };
        }

        if (ext === '.pdf') {
            return {
                success: false,
                text: '检测到 PDF 文件，请使用识图工具来分析 PDF 内容，我可以帮你看 PDF 里写了什么~',
            };
        }

        let content = '';
        if (ext === '.docx') {
            content = await readDocx(filePath);
        } else if (ext === '.xlsx' || ext === '.xls') {
            content = readExcel(filePath);
        } else {
            content = readText(filePath);
        }

        if (!content.trim()) {
            return { success: true, text: '文件内容为空或无法识别。' };
        }

        const preview = content.slice(0, 200).replace(/\n/g, ' ');
        log.debug(`读取成功，预览: ${preview}...`);

        const url = `${config.baseUrl}/chat/completions`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
                model: config.model,
                messages: [{
                    role: 'user',
                    content: params.question
                        ? `请根据以下文件内容回答问题：${params.question as string}\n\n文件内容：\n${content}`
                        : `请阅读以下文件内容，并总结它的核心信息：\n\n${content}`,
                }],
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API Error ${response.status}: ${errText}`);
        }

        interface ChatCompletionResponse {
            choices?: Array<{ message?: { content?: string } }>;
        }
        const data: ChatCompletionResponse = await response.json() as ChatCompletionResponse;
        const summary = data.choices?.[0]?.message?.content || '无法总结文件内容';

        return {
            success: true,
            text: summary,
            data: { filePath, contentLength: content.length },
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('读取文件失败:', err);
        return { success: false, text: `读取文件出错: ${message}` };
    }
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Module;

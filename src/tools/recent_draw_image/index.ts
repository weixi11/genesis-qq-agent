import fs from 'fs';
import path from 'path';
import { resolveFileForSend } from '../../utils/file.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

export const name = 'recent_draw_image';
export const description = '重发之前由绘图工具生成并保存在本机的图片';
export const keywords = ['之前画的图', '上次画的图', '刚才画的图', '重发图', '再发图', '最近画的图'];

type Source = 'all' | 'draw' | 'banana_draw';

interface GeneratedImage {
    source: Exclude<Source, 'all'>;
    path: string;
    mtimeMs: number;
}

const IMAGE_EXT_PATTERN = /\.(?:png|jpe?g|webp|gif|bmp)$/iu;

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

function normalizeSource(value: unknown): Source {
    return value === 'draw' || value === 'banana_draw' ? value : 'all';
}

function clampCount(value: unknown): number {
    const numeric = typeof value === 'number' ? value : Number(value ?? 1);
    if (!Number.isFinite(numeric)) return 1;
    return Math.max(1, Math.min(config.maxCount, Math.floor(numeric)));
}

function normalizeOffset(value: unknown): number {
    const numeric = typeof value === 'number' ? value : Number(value ?? 0);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.floor(numeric));
}

function listImagesInDir(dirPath: string, source: GeneratedImage['source']): GeneratedImage[] {
    if (!fs.existsSync(dirPath)) {
        return [];
    }

    const images: GeneratedImage[] = [];
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isFile() || !IMAGE_EXT_PATTERN.test(entry.name)) {
            continue;
        }

        const filePath = path.join(dirPath, entry.name);
        try {
            const stat = fs.statSync(filePath);
            images.push({ source, path: filePath, mtimeMs: stat.mtimeMs });
        } catch {
            // 文件可能刚好被清理，跳过即可。
        }
    }
    return images;
}

export function listGeneratedImages(source: Source = 'all'): GeneratedImage[] {
    const drawDir = path.resolve(process.cwd(), config.drawDir);
    const bananaDir = path.resolve(process.cwd(), config.bananaDir);

    const images = [
        ...(source === 'all' || source === 'draw' ? listImagesInDir(drawDir, 'draw') : []),
        ...(source === 'all' || source === 'banana_draw' ? listImagesInDir(bananaDir, 'banana_draw') : []),
    ];

    return images.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function execute(
    params: Record<string, unknown>,
    _ctx: ToolContext,
): Promise<ToolResult> {
    const source = normalizeSource(params.source);
    const count = clampCount(params.count);
    const offset = normalizeOffset(params.offset);
    const selected = listGeneratedImages(source).slice(offset, offset + count);

    if (selected.length === 0) {
        const sourceText = source === 'banana_draw' ? 'Banana 绘图' : source === 'draw' ? '普通绘图' : '绘图';
        return {
            success: false,
            text: `没找到可重发的${sourceText}图片。`,
            data: { source, count, offset, localPaths: [] },
        };
    }

    return {
        success: true,
        text: selected.length === 1
            ? '已找到最近画的图片，准备重发。'
            : `已找到最近 ${selected.length} 张画图结果，准备重发。`,
        segments: selected.map((item) => ({
            type: 'image',
            data: {
                file: resolveFileForSend(item.path),
                summary: item.source === 'banana_draw' ? 'Banana 绘图历史图片' : '绘图历史图片',
            },
        })),
        data: {
            source,
            count,
            offset,
            localPaths: selected.map((item) => item.path),
            sources: selected.map((item) => item.source),
        },
    };
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;

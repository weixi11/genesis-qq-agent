import fs from 'fs';
import path from 'path';
import { log } from '../../logger.js';
import { config } from './config.js';
import type { ToolContext } from '../types.js';

export interface BananaInputImage {
    source: string;
    buffer: Buffer;
    mimeType: string;
    filename: string;
}

const MIME_EXT_MAP: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
};

function isRemoteUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

function decodeDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } | null {
    const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
        return null;
    }
    try {
        return {
            mimeType: match[1],
            buffer: Buffer.from(match[2], 'base64'),
        };
    } catch (error) {
        log.warn('banana_draw 解析 data URL 失败:', error);
        return null;
    }
}

function detectImageType(buffer: Buffer, contentType = '', sourceHint = ''): { mimeType: string; ext: string } {
    const headerMime = contentType.split(';')[0].trim().toLowerCase();
    if (MIME_EXT_MAP[headerMime]) {
        return { mimeType: headerMime, ext: MIME_EXT_MAP[headerMime] };
    }

    const hintExt = path.extname(sourceHint).toLowerCase();
    if (hintExt === '.png') return { mimeType: 'image/png', ext: '.png' };
    if (hintExt === '.jpg' || hintExt === '.jpeg') return { mimeType: 'image/jpeg', ext: '.jpg' };
    if (hintExt === '.webp') return { mimeType: 'image/webp', ext: '.webp' };
    if (hintExt === '.gif') return { mimeType: 'image/gif', ext: '.gif' };
    if (hintExt === '.bmp') return { mimeType: 'image/bmp', ext: '.bmp' };

    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
        return { mimeType: 'image/png', ext: '.png' };
    }
    if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return { mimeType: 'image/jpeg', ext: '.jpg' };
    }
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        return { mimeType: 'image/webp', ext: '.webp' };
    }
    return { mimeType: 'image/jpeg', ext: '.jpg' };
}

async function downloadImage(source: string): Promise<{ buffer: Buffer; contentType: string } | null> {
    try {
        const response = await fetch(source, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(config.downloadTimeoutMs),
        });
        if (!response.ok) {
            log.warn(`banana_draw 下载图片失败: ${response.status} ${source}`);
            return null;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) {
            return null;
        }
        return {
            buffer,
            contentType: response.headers.get('content-type') || '',
        };
    } catch (error) {
        log.warn('banana_draw 下载图片失败:', error);
        return null;
    }
}

export async function normalizeInputImage(source: string): Promise<BananaInputImage | null> {
    if (typeof source !== 'string' || !source.trim()) {
        return null;
    }

    const value = source.trim();
    if (value.startsWith('data:')) {
        const decoded = decodeDataUrl(value);
        if (!decoded) {
            return null;
        }
        const { ext } = detectImageType(decoded.buffer, decoded.mimeType);
        return {
            source: value,
            buffer: decoded.buffer,
            mimeType: decoded.mimeType,
            filename: `banana_input_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`,
        };
    }

    if (!isRemoteUrl(value) && fs.existsSync(value)) {
        const buffer = fs.readFileSync(value);
        const { mimeType, ext } = detectImageType(buffer, '', value);
        return {
            source: value,
            buffer,
            mimeType,
            filename: path.basename(value) || `banana_input_${Date.now()}${ext}`,
        };
    }

    if (!isRemoteUrl(value)) {
        return null;
    }

    const downloaded = await downloadImage(value);
    if (!downloaded) {
        return null;
    }
    const { mimeType, ext } = detectImageType(downloaded.buffer, downloaded.contentType, value);
    return {
        source: value,
        buffer: downloaded.buffer,
        mimeType,
        filename: `banana_input_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`,
    };
}

function normalizeStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
    }
    if (typeof value === 'string' && value.trim()) {
        return [value.trim()];
    }
    return [];
}

export function collectImageSources(params: Record<string, unknown>, ctx: ToolContext): string[] {
    const merged = [
        ...normalizeStringArray(params.imageUrls),
        ...normalizeStringArray(params.imageUrl),
        ...normalizeStringArray(params.imagePath),
        ...(ctx.imageUrls || []).filter((item): item is string => typeof item === 'string' && item.trim().length > 0),
    ];

    return [...new Set(merged)];
}

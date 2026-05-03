import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { log } from '../../logger.js';
import { resolveFileForSend } from '../../utils/file.js';
import { config } from './config.js';
import type { MessageSegment } from '../types.js';

type FetchInitWithDispatcher = RequestInit & { dispatcher?: unknown };
type ProxyAgentCtor = new (proxyUrl: string) => unknown;
const require = createRequire(import.meta.url);
const { ProxyAgent } = require('undici') as { ProxyAgent: ProxyAgentCtor };

export interface BananaOutputImage {
    url?: string;
    b64_json?: string;
    mime_type?: string;
}

export interface PreparedOutputImage {
    segment: MessageSegment;
    localPath: string | null;
    remoteUrl: string | null;
}

const IMAGE_SAVE_DIR = path.join(process.cwd(), 'data', 'images', 'banana_draw');
let cachedProxyAgent: unknown | null = null;
let cachedProxyUrl = '';

function ensureImageDir(): void {
    if (!fs.existsSync(IMAGE_SAVE_DIR)) {
        fs.mkdirSync(IMAGE_SAVE_DIR, { recursive: true });
    }
}

function detectExt(sourceHint: string, mimeType = ''): string {
    if (mimeType === 'image/png') return '.png';
    if (mimeType === 'image/jpeg') return '.jpg';
    if (mimeType === 'image/webp') return '.webp';
    if (mimeType === 'image/gif') return '.gif';
    if (mimeType === 'image/bmp') return '.bmp';
    const matched = sourceHint.match(/\.(jpg|jpeg|png|gif|webp|bmp)(?:\?|$)/i)?.[1];
    return matched ? `.${matched.toLowerCase()}` : '.png';
}

function saveImage(buffer: Buffer, sourceHint: string, mimeType = ''): string | null {
    try {
        ensureImageDir();
        const filename = `banana_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${detectExt(sourceHint, mimeType)}`;
        const localPath = path.join(IMAGE_SAVE_DIR, filename);
        fs.writeFileSync(localPath, buffer);
        return localPath;
    } catch (error) {
        log.warn('banana_draw 保存图片失败:', error);
        return null;
    }
}

function bufferToBase64(buffer: Buffer): string {
    return `base64://${buffer.toString('base64')}`;
}

function isRetryableDownloadError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    return error.name === 'TimeoutError'
        || error.name === 'AbortError'
        || /aborted due to timeout|fetch failed|network|socket|econnreset|etimedout/i.test(error.message);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getProxyAgent(proxyUrl: string): unknown {
    if (!cachedProxyAgent || cachedProxyUrl !== proxyUrl) {
        cachedProxyAgent = new ProxyAgent(proxyUrl);
        cachedProxyUrl = proxyUrl;
    }
    return cachedProxyAgent;
}

async function downloadRemoteImage(url: string): Promise<Buffer | null> {
    const retryCount = Math.max(1, Number(config.downloadRetryCount) || 1);
    const proxyUrl = String(config.downloadProxyUrl || '').trim();

    for (let attempt = 1; attempt <= retryCount; attempt += 1) {
        const timeoutMs = Math.max(1, Number(config.downloadTimeoutMs) || 0) * attempt;

        try {
            const init: FetchInitWithDispatcher = { signal: AbortSignal.timeout(timeoutMs) };
            if (proxyUrl) {
                init.dispatcher = getProxyAgent(proxyUrl);
            }
            const response = await fetch(url, init);
            if (!response.ok) {
                log.warn(`banana_draw 下载输出图片失败: HTTP ${response.status} (attempt ${attempt}/${retryCount}${proxyUrl ? ', proxy' : ''})`);
            } else {
                return Buffer.from(await response.arrayBuffer());
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            log.warn(`banana_draw 下载输出图片失败 (attempt ${attempt}/${retryCount}${proxyUrl ? ', proxy' : ''}): ${reason}`);
            if (!isRetryableDownloadError(error) || attempt >= retryCount) {
                return null;
            }
        }

        if (attempt < retryCount) {
            await sleep(500 * attempt);
        }
    }

    return null;
}

export async function prepareOutputImages(images: BananaOutputImage[]): Promise<PreparedOutputImage[]> {
    const results: PreparedOutputImage[] = [];

    for (const image of images) {
        const remoteUrl = typeof image.url === 'string' ? image.url : null;
        const mimeType = typeof image.mime_type === 'string' ? image.mime_type : 'image/png';
        let buffer: Buffer | null = null;

        if (typeof image.b64_json === 'string' && image.b64_json) {
            buffer = Buffer.from(image.b64_json, 'base64');
        } else if (remoteUrl) {
            buffer = await downloadRemoteImage(remoteUrl);
        }

        let file = config.sendMode === 'url' ? remoteUrl || '' : '';
        let localPath: string | null = null;
        if (buffer) {
            localPath = saveImage(buffer, remoteUrl || 'banana.png', mimeType);
            if (config.sendMode === 'base64') {
                file = bufferToBase64(buffer);
            } else if (config.sendMode === 'local' && localPath) {
                file = resolveFileForSend(localPath);
            } else if (!remoteUrl && localPath) {
                file = resolveFileForSend(localPath);
            } else if (!remoteUrl) {
                file = bufferToBase64(buffer);
            }
        }

        if (!file) {
            continue;
        }

        results.push({
            segment: { type: 'image', data: { file } },
            localPath,
            remoteUrl,
        });
    }

    return results;
}

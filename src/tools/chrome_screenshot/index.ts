/**
 * Chrome Screenshot 工具
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from '../../logger.js';
import { resolveFileForSend } from '../../utils/file.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';

const execFileAsync = promisify(execFile);

export const name = 'chrome_screenshot';
export const description = '使用 Chrome/Chromium 对网页进行截图';
export const keywords = ['网页截图', '浏览器截图', '截图网页', 'chrome截图', '网页快照', '页面截图', '手机截图'];

type DeviceType = 'desktop' | 'mobile';

interface ScreenshotParams {
    url?: string;
    device?: DeviceType;
    waitMs?: number;
    width?: number;
    height?: number;
}

const MOBILE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

function ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function normalizeUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
        throw new Error('截图地址不能为空');
    }

    const normalized = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;

    let parsed: URL;
    try {
        parsed = new URL(normalized);
    } catch {
        throw new Error('截图地址不是有效的 URL');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('截图地址仅支持 http 或 https');
    }

    return parsed.toString();
}

function pickViewport(params: ScreenshotParams): { width: number; height: number; device: DeviceType } {
    const device = params.device === 'mobile' ? 'mobile' : 'desktop';
    const fallbackWidth = device === 'mobile' ? config.mobileWidth : config.desktopWidth;
    const fallbackHeight = device === 'mobile' ? config.mobileHeight : config.desktopHeight;
    const width = Number.isInteger(params.width) && (params.width as number) >= 320 ? Number(params.width) : fallbackWidth;
    const height = Number.isInteger(params.height) && (params.height as number) >= 320 ? Number(params.height) : fallbackHeight;
    return { width, height, device };
}

function pickWaitMs(value: unknown): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return config.defaultWaitMs;
    const rounded = Math.round(numeric);
    if (rounded < 0) return 0;
    if (rounded > config.maxWaitMs) return config.maxWaitMs;
    return rounded;
}

function buildOutputFilename(device: DeviceType): string {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const random = Math.random().toString(36).slice(2, 8);
    return `chrome_${device}_${stamp}_${random}.png`;
}

async function runChromeScreenshot(options: {
    url: string;
    device: DeviceType;
    width: number;
    height: number;
    waitMs: number;
    outputDir: string;
    outputFilename: string;
}): Promise<string> {
    ensureDir(options.outputDir);

    const chromeArgs = [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        '--disable-dev-shm-usage',
        '--allow-pre-commit-input',
        `--window-size=${options.width},${options.height}`,
        `--virtual-time-budget=${options.waitMs}`,
        `--screenshot=${options.outputFilename}`,
    ];

    if (options.device === 'mobile') {
        chromeArgs.push(`--user-agent=${MOBILE_USER_AGENT}`);
    }

    chromeArgs.push(options.url);

    log.info(`📸 Chrome 截图: ${options.url} (${options.device}, ${options.width}x${options.height}, wait=${options.waitMs}ms)`);

    try {
        const result = await execFileAsync(config.chromeBin, chromeArgs, {
            cwd: options.outputDir,
            timeout: config.timeoutMs,
            maxBuffer: 1024 * 1024 * 4,
        });

        if (result.stderr?.trim()) {
            log.debug(`📸 Chromium stderr: ${result.stderr.trim().slice(0, 500)}`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Chrome 截图执行失败: ${message}`);
    }

    const outputPath = path.join(options.outputDir, options.outputFilename);
    if (!fs.existsSync(outputPath)) {
        throw new Error('截图命令已执行，但未找到输出文件');
    }

    return outputPath;
}

export async function execute(
    params: Record<string, unknown>,
    _ctx: ToolContext,
): Promise<ToolResult> {
    const input = params as ScreenshotParams;

    try {
        if (!fs.existsSync(config.chromeBin)) {
            return {
                success: false,
                text: `未找到可用的 Chrome/Chromium，可检查 CHROME_SCREENSHOT_BIN：${config.chromeBin}`,
            };
        }

        const url = normalizeUrl(String(input.url || ''));
        const { width, height, device } = pickViewport(input);
        const waitMs = pickWaitMs(input.waitMs);
        const outputDir = path.resolve(process.cwd(), config.saveDir);
        const outputFilename = buildOutputFilename(device);
        const outputPath = await runChromeScreenshot({
            url,
            device,
            width,
            height,
            waitMs,
            outputDir,
            outputFilename,
        });

        const fileForSend = resolveFileForSend(outputPath);
        const fileSizeKb = Math.round(fs.statSync(outputPath).size / 1024);

        return {
            success: true,
            text: `已完成网页截图：${device === 'mobile' ? '手机视口' : '桌面视口'}，尺寸 ${width}x${height}，等待 ${waitMs}ms。`,
            segments: [
                {
                    type: 'image',
                    data: {
                        file: fileForSend,
                        summary: `网页截图 ${width}x${height}`,
                    },
                },
            ],
            data: {
                url,
                device,
                width,
                height,
                waitMs,
                localPath: outputPath,
                fileSizeKb,
            },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('📸 Chrome 截图失败:', error);
        return {
            success: false,
            text: `网页截图失败：${message}`,
        };
    }
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;

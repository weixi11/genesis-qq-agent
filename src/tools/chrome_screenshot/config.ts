/**
 * Chrome Screenshot 模块配置
 */

import { existsSync } from 'fs';

const DEFAULT_CANDIDATES = [
    process.env.CHROME_SCREENSHOT_BIN,
    process.env.CHROMIUM_BIN,
    '/snap/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
].filter((item): item is string => Boolean(item && item.trim()));

function resolveChromeBin(): string {
    for (const candidate of DEFAULT_CANDIDATES) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return DEFAULT_CANDIDATES[0] || '/snap/bin/chromium';
}

export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_CHROME_SCREENSHOT_ENABLED?.toLowerCase();
        return envEnabled !== 'false' && envEnabled !== '0';
    })(),

    chromeBin: resolveChromeBin(),

    timeoutMs: parseInt(process.env.CHROME_SCREENSHOT_TIMEOUT_MS || '30000', 10),
    concurrency: parseInt(process.env.CHROME_SCREENSHOT_CONCURRENCY || '2', 10),
    defaultWaitMs: parseInt(process.env.CHROME_SCREENSHOT_WAIT_MS || '1500', 10),
    maxWaitMs: parseInt(process.env.CHROME_SCREENSHOT_MAX_WAIT_MS || '10000', 10),
    desktopWidth: parseInt(process.env.CHROME_SCREENSHOT_DESKTOP_WIDTH || '1440', 10),
    desktopHeight: parseInt(process.env.CHROME_SCREENSHOT_DESKTOP_HEIGHT || '1100', 10),
    mobileWidth: parseInt(process.env.CHROME_SCREENSHOT_MOBILE_WIDTH || '430', 10),
    mobileHeight: parseInt(process.env.CHROME_SCREENSHOT_MOBILE_HEIGHT || '932', 10),
    saveDir: process.env.CHROME_SCREENSHOT_SAVE_DIR || 'data/chrome_screenshot',
} as const;

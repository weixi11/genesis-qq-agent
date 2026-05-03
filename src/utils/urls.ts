/**
 * URL Utilities
 * Centralized management for external service URLs to avoid hardcoding.
 */

import { config } from '../config.js';

export const URLS = {
    // QQ Avatar Service
    QQ_AVATAR: (userId: number | string, spec: string = '640') =>
        `https://q.qlogo.cn/headimg_dl?dst_uin=${userId}&spec=${spec}`,

    // QWeather API (Scheme handled here)
    QWEATHER_API: (host: string, path: string) =>
        `https://${host}${path.startsWith('/') ? path : '/' + path}`,
} as const;

/**
 * Get Bot Avatar URL
 */
export function getBotAvatarUrl(): string {
    return config.botQQ ? URLS.QQ_AVATAR(config.botQQ) : '';
}

/**
 * Get User Avatar URL
 */
export function getUserAvatarUrl(userId: number): string {
    return URLS.QQ_AVATAR(userId);
}

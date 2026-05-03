import { createHash } from 'node:crypto';
import { log } from '../logger.js';
import { safeParseRecord } from './json.js';

export interface BlogApiResponse<T = unknown> {
    code: number;
    msg: string;
    data: T;
}

export interface BlogApiConfig {
    apiBaseUrl: string;
    apiToken?: string;
    apiUsername?: string;
    apiPassword?: string;
    loginClientType?: string;
    timeoutMs?: number;
}

interface BlogRequestOptions {
    method: string;
    path: string;
    body?: unknown;
    queryParams?: Record<string, string>;
    requiredAuth?: boolean;
}

interface CachedToken {
    token: string;
    expiresAt: number;
    source: 'env' | 'login';
}

const DEFAULT_TIMEOUT_MS = 15000;
const AUTH_REFRESH_BUFFER_MS = 60_000;
const authCache = new Map<string, CachedToken>();

function trim(value: string | undefined): string {
    return value?.trim() ?? '';
}

function normalizeBaseUrl(baseUrl: string): string {
    return trim(baseUrl).replace(/\/+$/, '');
}

function fingerprintSecret(value: string): string {
    if (!value) {
        return '';
    }
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function getCacheKey(config: BlogApiConfig): string {
    return [
        normalizeBaseUrl(config.apiBaseUrl),
        trim(config.apiUsername),
        trim(config.loginClientType) || 'Backend',
        fingerprintSecret(getStaticToken(config)),
        fingerprintSecret(trim(config.apiPassword)),
    ].join('|');
}

function getStaticToken(config: BlogApiConfig): string {
    return trim(config.apiToken);
}

function canUsePasswordAuth(config: BlogApiConfig): boolean {
    return !!trim(config.apiUsername) && !!trim(config.apiPassword);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
        const parts = token.split('.');
        if (parts.length < 2) return null;
        const payload = parts[1];
        const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
        const json = Buffer.from(padded, 'base64').toString('utf8');
        return safeParseRecord(json);
    } catch {
        return null;
    }
}

function getTokenExpiry(token: string): number {
    const payload = decodeJwtPayload(token);
    const exp = typeof payload?.exp === 'number' ? payload.exp : null;
    return exp ? exp * 1000 : Date.now() + 24 * 60 * 60 * 1000;
}

function getCachedToken(config: BlogApiConfig): CachedToken | undefined {
    const cached = authCache.get(getCacheKey(config));
    if (cached && cached.expiresAt > Date.now() + AUTH_REFRESH_BUFFER_MS) {
        return cached;
    }

    if (cached) {
        authCache.delete(getCacheKey(config));
    }
    return;
}

function saveToken(config: BlogApiConfig, token: string, source: CachedToken['source']): string {
    authCache.set(getCacheKey(config), {
        token,
        expiresAt: getTokenExpiry(token),
        source,
    });
    return token;
}

function clearCachedToken(config: BlogApiConfig): void {
    authCache.delete(getCacheKey(config));
}

function buildUrl(baseUrl: string, path: string, queryParams?: Record<string, string>): string {
    let url = `${normalizeBaseUrl(baseUrl)}${path}`;
    if (queryParams && Object.keys(queryParams).length > 0) {
        const params = new URLSearchParams(queryParams);
        url += `?${params.toString()}`;
    }
    return url;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return await fetch(url, { ...init, signal });
}

async function loginWithPassword(config: BlogApiConfig): Promise<string> {
    const apiBaseUrl = normalizeBaseUrl(config.apiBaseUrl);
    const username = trim(config.apiUsername);
    const password = trim(config.apiPassword);
    const clientType = trim(config.loginClientType) || 'Backend';

    const body = new URLSearchParams({ username, password });
    const response = await fetchWithTimeout(`${apiBaseUrl}/user/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Client-Type': clientType,
        },
        body,
    }, config.timeoutMs);

    const result = await response.json() as BlogApiResponse<{ token?: string }>;
    const token = trim(result.data?.token);

    if (result.code !== 200 || !token) {
        throw new Error(result.msg || '博客登录未返回有效 token');
    }

    log.info('[blog_api] 已通过账号密码刷新博客 token');
    return saveToken(config, token, 'login');
}

async function resolveAuthToken(config: BlogApiConfig, requiredAuth: boolean, forceRefresh = false): Promise<string | undefined> {
    let cachedToken: CachedToken | undefined;
    const staticToken = getStaticToken(config);

    if (!forceRefresh) {
        cachedToken = getCachedToken(config);
        if (cachedToken) {
            return cachedToken.token;
        }
    } else {
        clearCachedToken(config);
    }

    if (!requiredAuth) {
        return staticToken ? saveToken(config, staticToken, 'env') : undefined;
    }

    if (canUsePasswordAuth(config)) {
        try {
            return await loginWithPassword(config);
        } catch (error) {
            if (staticToken) {
                log.warn(`[blog_api] 账号密码登录失败，回退到静态 token: ${error instanceof Error ? error.message : '未知错误'}`);
                return saveToken(config, staticToken, 'env');
            }
            throw error;
        }
    }

    if (staticToken) {
        return saveToken(config, staticToken, 'env');
    }

    if (requiredAuth) {
        throw new Error('博客接口缺少认证配置，请设置 BLOG_API_TOKEN 或 BLOG_API_USERNAME/BLOG_API_PASSWORD');
    }

    return undefined;
}

function shouldRetryWithFreshLogin(config: BlogApiConfig, requiredAuth: boolean, result: BlogApiResponse<unknown>): boolean {
    if (!requiredAuth || !canUsePasswordAuth(config)) {
        return false;
    }

    const msg = String(result.msg || '').toLowerCase();
    return result.code === 1008
        || result.code === 401
        || msg.includes('access denied')
        || msg.includes('not login')
        || msg.includes('no permission')
        || msg.includes('系统内部错误')
        || msg.includes('没有登录')
        || msg.includes('权限');
}

async function sendRequest<T>(
    config: BlogApiConfig,
    options: BlogRequestOptions,
    forceRefresh = false,
): Promise<BlogApiResponse<T>> {
    const requiredAuth = options.requiredAuth ?? false;
    const headers = new Headers();
    const token = await resolveAuthToken(config, requiredAuth, forceRefresh);
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    let body: BodyInit | undefined;
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const isUrlEncoded = options.body instanceof URLSearchParams;
    const isRawBody = typeof options.body === 'string'
        || options.body instanceof Blob
        || options.body instanceof ArrayBuffer
        || ArrayBuffer.isView(options.body)
        || isFormData
        || isUrlEncoded;

    if (options.body !== undefined) {
        if (isRawBody) {
            body = options.body as BodyInit;
            if (isUrlEncoded) {
                headers.set('Content-Type', 'application/x-www-form-urlencoded');
            }
        } else {
            headers.set('Content-Type', 'application/json');
            body = JSON.stringify(options.body);
        }
    }

    const response = await fetchWithTimeout(buildUrl(config.apiBaseUrl, options.path, options.queryParams), {
        method: options.method,
        headers,
        body,
    }, config.timeoutMs);

    return await response.json() as BlogApiResponse<T>;
}

export async function requestBlogApi<T>(
    config: BlogApiConfig,
    options: BlogRequestOptions,
): Promise<BlogApiResponse<T>> {
    const result = await sendRequest<T>(config, options);
    if (!shouldRetryWithFreshLogin(config, options.requiredAuth ?? false, result)) {
        return result;
    }

    log.warn(`[blog_api] 检测到疑似认证失效，准备重登后重试 ${options.method} ${options.path}`);
    return await sendRequest<T>(config, options, true);
}

export const __blogApiTestUtils = {
    clearAuthCache(): void {
        authCache.clear();
    },
};

/**
 * Genesis Web 控制台服务器
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type IncomingMessage } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

import { log } from '../logger.js';
import { getWebConsoleConfig } from '../config.js';
import { apiRouter } from './routes/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SESSION_COOKIE_NAME = 'genesis_web_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SESSION_TOKEN_VERSION = 'v1';
const SESSION_REVOCATION_FILE = join(process.cwd(), 'data', 'web-session-revocations.json');

type SessionRevocationMap = Map<string, number>;
let sessionRevocationCache: SessionRevocationMap | null = null;

function buildWebPath(basePath: string, path: string): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (!basePath) {
        return normalizedPath;
    }
    return normalizedPath === '/'
        ? `${basePath}/`
        : `${basePath}${normalizedPath}`;
}

function getWebPasswordHash(): string {
    const { password } = getWebConsoleConfig();
    return password
        ? createHash('sha256').update(`genesis-web-password:${password}`).digest('hex')
        : '';
}

function getWebSessionSecret(): string {
    const passwordHash = getWebPasswordHash();
    if (!passwordHash) {
        return '';
    }

    const { apiToken, basePath, host, port } = getWebConsoleConfig();
    return createHash('sha256')
        .update([
            'genesis-web-session',
            passwordHash,
            apiToken || '',
            basePath || '',
            host || '',
            String(port),
        ].join(':'))
        .digest('hex');
}

// 日志订阅者
const logSubscribers = new Set<WebSocket>();

// 广播日志到 WebSocket
function broadcastLog(level: string, message: string) {
    if (logSubscribers.size === 0) return;
    const packet = JSON.stringify({
        time: Date.now(),
        level,
        message,
    });
    for (const ws of logSubscribers) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(packet);
        }
    }
}

function normalizeRemoteAddress(address: string | undefined): string {
    if (!address) return '';
    if (address.startsWith('::ffff:')) {
        return address.slice(7);
    }
    return address;
}

function isLoopbackAddress(address: string | undefined): boolean {
    const normalized = normalizeRemoteAddress(address);
    return normalized === '127.0.0.1' || normalized === '::1';
}

function isLoopbackHost(host: string): boolean {
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function getHeaderValue(
    value: string | string[] | undefined,
): string {
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0] : '';
    }
    return typeof value === 'string' ? value : '';
}

function extractHostName(hostHeader: string | undefined): string {
    const rawHost = (hostHeader || '').trim();
    if (!rawHost) {
        return '';
    }

    if (rawHost.startsWith('[')) {
        const closingIndex = rawHost.indexOf(']');
        return closingIndex >= 0 ? rawHost.slice(1, closingIndex) : rawHost.slice(1);
    }

    const colonIndex = rawHost.indexOf(':');
    return colonIndex >= 0 ? rawHost.slice(0, colonIndex) : rawHost;
}

function hasForwardingHeaders(headers: IncomingMessage['headers']): boolean {
    return Boolean(
        getHeaderValue(headers['x-forwarded-for'])
        || getHeaderValue(headers['x-forwarded-host'])
        || getHeaderValue(headers['x-forwarded-proto'])
        || getHeaderValue(headers.forwarded),
    );
}

function isTrustedLoopbackRequest(remoteAddress: string | undefined, headers: IncomingMessage['headers']): boolean {
    if (!isLoopbackAddress(remoteAddress)) {
        return false;
    }

    if (hasForwardingHeaders(headers)) {
        return false;
    }

    const hostName = extractHostName(getHeaderValue(headers.host));
    return !hostName || isLoopbackHost(hostName);
}

function safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookieHeader(rawValue: string | undefined): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!rawValue) return cookies;

    for (const chunk of rawValue.split(';')) {
        const separatorIndex = chunk.indexOf('=');
        if (separatorIndex === -1) continue;

        const key = chunk.slice(0, separatorIndex).trim();
        const value = chunk.slice(separatorIndex + 1).trim();
        if (!key) continue;

        try {
            cookies[key] = decodeURIComponent(value);
        } catch {
            cookies[key] = value;
        }
    }

    return cookies;
}

function createAuthorizedSession(): string {
    const secret = getWebSessionSecret();
    if (!secret) {
        return '';
    }

    const issuedAt = Date.now();
    const expiresAt = issuedAt + SESSION_TTL_SECONDS * 1000;
    const nonce = randomBytes(16).toString('base64url');
    const payload = `${SESSION_TOKEN_VERSION}.${issuedAt}.${expiresAt}.${nonce}`;
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function getAuthorizedSession(cookieHeader: string | undefined): string {
    return parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME] || '';
}

function hashSessionValue(sessionValue: string): string {
    return createHash('sha256')
        .update(`genesis-web-session:${sessionValue}`)
        .digest('hex');
}

function pruneExpiredSessionRevocations(records: SessionRevocationMap, now: number = Date.now()): boolean {
    let changed = false;
    for (const [digest, expiresAt] of records.entries()) {
        if (!Number.isFinite(expiresAt) || expiresAt <= now) {
            records.delete(digest);
            changed = true;
        }
    }
    return changed;
}

function loadSessionRevocationsFromDisk(): SessionRevocationMap {
    const records: SessionRevocationMap = new Map();

    try {
        if (!fs.existsSync(SESSION_REVOCATION_FILE)) {
            return records;
        }

        const raw = fs.readFileSync(SESSION_REVOCATION_FILE, 'utf8').trim();
        if (!raw) {
            return records;
        }

        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) {
            return records;
        }

        for (const item of parsed) {
            if (!item || typeof item !== 'object') continue;
            const digest = typeof item.digest === 'string' ? item.digest : '';
            const expiresAt = typeof item.expiresAt === 'number' ? item.expiresAt : Number.NaN;
            if (!digest || !Number.isFinite(expiresAt)) continue;
            records.set(digest, expiresAt);
        }
    } catch {
        return records;
    }

    return records;
}

function saveSessionRevocationsToDisk(records: SessionRevocationMap): void {
    try {
        fs.mkdirSync(dirname(SESSION_REVOCATION_FILE), { recursive: true });
        const serialized = Array.from(records.entries()).map(([digest, expiresAt]) => ({ digest, expiresAt }));
        fs.writeFileSync(SESSION_REVOCATION_FILE, JSON.stringify(serialized, null, 2), 'utf8');
    } catch {
        // Ignore revocation persistence errors so auth flow itself still works.
    }
}

function getSessionRevocations(): SessionRevocationMap {
    if (!sessionRevocationCache) {
        sessionRevocationCache = loadSessionRevocationsFromDisk();
    }
    return sessionRevocationCache;
}

function persistSessionRevocations(records: SessionRevocationMap): void {
    sessionRevocationCache = records;
    saveSessionRevocationsToDisk(records);
}

function isSessionRevoked(sessionValue: string): boolean {
    if (!sessionValue) {
        return false;
    }

    const records = getSessionRevocations();
    const changed = pruneExpiredSessionRevocations(records);
    const revoked = records.has(hashSessionValue(sessionValue));
    if (changed) {
        persistSessionRevocations(records);
    }
    return revoked;
}

function hasAuthorizedSession(cookieHeader: string | undefined): boolean {
    const secret = getWebSessionSecret();
    if (!secret) {
        return false;
    }

    const sessionValue = getAuthorizedSession(cookieHeader);
    if (!sessionValue) {
        return false;
    }
    if (isSessionRevoked(sessionValue)) {
        return false;
    }

    const parts = sessionValue.split('.');
    if (parts.length !== 5) {
        return false;
    }

    const [version, issuedAtRaw, expiresAtRaw, nonce, signature] = parts;
    if (version !== SESSION_TOKEN_VERSION || !nonce || !signature) {
        return false;
    }

    const issuedAt = Number.parseInt(issuedAtRaw, 10);
    const expiresAt = Number.parseInt(expiresAtRaw, 10);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
        return false;
    }

    if (expiresAt <= Date.now()) {
        return false;
    }

    if (expiresAt - issuedAt > SESSION_TTL_SECONDS * 1000 || issuedAt > expiresAt) {
        return false;
    }

    const payload = `${version}.${issuedAt}.${expiresAt}.${nonce}`;
    const expectedSignature = createHmac('sha256', secret).update(payload).digest('base64url');
    return safeEqual(signature, expectedSignature);
}

function revokeAuthorizedSession(cookieHeader: string | undefined): void {
    const sessionValue = getAuthorizedSession(cookieHeader);
    if (!sessionValue) {
        return;
    }

    const parts = sessionValue.split('.');
    const expiresAt = parts.length === 5 ? Number.parseInt(parts[2] || '', 10) : Number.NaN;
    const effectiveExpiresAt = Number.isFinite(expiresAt)
        ? expiresAt
        : Date.now() + SESSION_TTL_SECONDS * 1000;

    const records = getSessionRevocations();
    pruneExpiredSessionRevocations(records);
    records.set(hashSessionValue(sessionValue), effectiveExpiresAt);
    persistSessionRevocations(records);
}

function extractToken(rawValue: string | undefined): string {
    if (!rawValue) return '';
    const trimmed = rawValue.trim();
    return trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
}

function getSocketQueryToken(req: IncomingMessage): string {
    const url = req.url || '';
    const queryIndex = url.indexOf('?');
    if (queryIndex === -1) return '';

    const params = new URLSearchParams(url.slice(queryIndex + 1));
    return extractToken(params.get('token') || '');
}

function getRequestToken(req: Request): string {
    const headerToken = extractToken(req.header('authorization') || '');
    const queryToken = extractToken(typeof req.query.token === 'string' ? req.query.token : '');
    return headerToken || queryToken;
}

function stripTokenFromUrl(rawUrl: string, basePath: string): string {
    if (!rawUrl) return buildWebPath(basePath, '/');

    const [pathnameWithSearch, hash = ''] = rawUrl.split('#', 2);
    const [pathname = '/', search = ''] = pathnameWithSearch.split('?', 2);
    const params = new URLSearchParams(search);
    params.delete('token');

    const normalizedPath = sanitizeNextPath(pathname || '/', basePath);
    const nextSearch = params.toString();
    const nextHash = hash ? `#${hash}` : '';
    return `${normalizedPath}${nextSearch ? `?${nextSearch}` : ''}${nextHash}`;
}

function isAuthorizedRemoteToken(token: string): boolean {
    const { apiToken } = getWebConsoleConfig();
    return apiToken.length > 0 && token === apiToken;
}

function hasWebConsoleAccess(req: Request): boolean {
    const { password } = getWebConsoleConfig();
    if (!password) {
        return isTrustedLoopbackRequest(req.socket.remoteAddress, req.headers);
    }
    return hasAuthorizedSession(req.headers.cookie);
}

function isAuthorizedRequest(req: Request): boolean {
    if (hasWebConsoleAccess(req)) {
        return true;
    }

    const { password } = getWebConsoleConfig();
    if (!password && isTrustedLoopbackRequest(req.socket.remoteAddress, req.headers)) {
        return true;
    }

    return isAuthorizedRemoteToken(getRequestToken(req));
}

function isAuthorizedSocketRequest(req: IncomingMessage): boolean {
    if (hasAuthorizedSession(req.headers.cookie)) {
        return true;
    }

    const { password } = getWebConsoleConfig();
    if (!password && isTrustedLoopbackRequest(req.socket.remoteAddress, req.headers)) {
        return true;
    }

    const headerValue = req.headers.authorization;
    const headerToken = Array.isArray(headerValue)
        ? extractToken(typeof headerValue[0] === 'string' ? headerValue[0] : undefined)
        : extractToken(typeof headerValue === 'string' ? headerValue : undefined);
    const queryToken = getSocketQueryToken(req);
    return isAuthorizedRemoteToken(headerToken || queryToken);
}

function usesHttps(headers: IncomingMessage['headers']): boolean {
    const forwardedProto = headers['x-forwarded-proto'];
    const rawValue = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    if (!rawValue) return false;
    return rawValue.split(',').some(item => item.trim().toLowerCase() === 'https');
}

function shouldUseSecureCookie(req: Request): boolean {
    return req.secure || usesHttps(req.headers);
}

function buildSessionCookieHeader(req: Request, sessionValue: string): string {
    const { basePath } = getWebConsoleConfig();
    const secure = shouldUseSecureCookie(req) ? '; Secure' : '';
    const cookiePath = basePath || '/';
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionValue)}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

function buildClearSessionCookieHeader(req: Request): string {
    const { basePath } = getWebConsoleConfig();
    const secure = shouldUseSecureCookie(req) ? '; Secure' : '';
    const cookiePath = basePath || '/';
    return `${SESSION_COOKIE_NAME}=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
}

function sanitizeNextPath(nextPath: string | undefined, basePath = ''): string {
    if (!nextPath || !nextPath.startsWith('/') || nextPath.startsWith('//')) {
        return buildWebPath(basePath, '/');
    }
    return nextPath;
}

function buildLoginRedirect(req: Request, basePath: string): string {
    const nextPath = sanitizeNextPath(req.originalUrl || req.url, basePath);
    return `${buildWebPath(basePath, '/login')}?next=${encodeURIComponent(nextPath)}`;
}

function renderLoginPage(basePath: string, nextPath: string, errorMessage = ''): string {
    const safeNextPath = sanitizeNextPath(nextPath, basePath);
    const safeMessage = errorMessage
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const loginAction = buildWebPath(basePath, '/login');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0b1220">
  <title>Genesis 登录</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%230b1220'/%3E%3Cpath d='M18 18h28v8H27v10h14v8H27v2h19v8H18V18Z' fill='%2360a5fa'/%3E%3C/svg%3E">
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        radial-gradient(circle at top, rgba(80, 120, 255, 0.2), transparent 36%),
        linear-gradient(135deg, #0b1220, #121b2f 48%, #0f172a);
      font-family: "Noto Sans SC", "Microsoft YaHei", sans-serif;
      color: #e5eefb;
    }
    .panel {
      width: min(420px, calc(100vw - 32px));
      padding: 32px;
      border-radius: 20px;
      background: rgba(15, 23, 42, 0.86);
      border: 1px solid rgba(148, 163, 184, 0.2);
      box-shadow: 0 24px 80px rgba(15, 23, 42, 0.5);
      backdrop-filter: blur(14px);
    }
    h1 { margin: 0 0 10px; font-size: 28px; letter-spacing: 0.04em; }
    p { margin: 0 0 20px; color: #94a3b8; line-height: 1.6; }
    label { display: block; margin-bottom: 8px; color: #cbd5e1; font-size: 14px; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid rgba(148, 163, 184, 0.26);
      background: rgba(15, 23, 42, 0.92);
      color: #f8fafc;
      font-size: 15px;
      outline: none;
    }
    input:focus { border-color: rgba(96, 165, 250, 0.9); }
    button {
      width: 100%;
      margin-top: 18px;
      padding: 14px 16px;
      border: 0;
      border-radius: 12px;
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #eff6ff;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
    }
    .error {
      min-height: 22px;
      margin-bottom: 14px;
      color: #fca5a5;
      font-size: 13px;
    }
    .hint {
      margin-top: 14px;
      font-size: 12px;
      color: #64748b;
      text-align: center;
    }
  </style>
</head>
<body>
  <form class="panel" method="post" action="${loginAction}">
    <h1>Genesis</h1>
    <p>请输入 Web 控制台访问密码。</p>
    <div class="error">${safeMessage}</div>
    <input type="hidden" name="next" value="${safeNextPath}">
    <label class="sr-only" for="username">用户名</label>
    <input id="username" name="username" type="text" autocomplete="username" tabindex="-1" aria-hidden="true">
    <label for="password">访问密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">进入控制台</button>
    <div class="hint">登录成功后，页面、API 与日志流会共享当前会话。</div>
  </form>
</body>
</html>`;
}

function requireWebConsoleAccess(req: Request, res: Response, next: NextFunction): void {
    const { basePath } = getWebConsoleConfig();
    if (hasWebConsoleAccess(req)) {
        next();
        return;
    }

    const { password } = getWebConsoleConfig();
    if (!password) {
        res.status(403).type('text/plain').send('Web console is restricted to direct localhost access by default');
        return;
    }

    const requestToken = getRequestToken(req);
    if (isAuthorizedRemoteToken(requestToken)) {
        const sessionValue = createAuthorizedSession();
        res.setHeader('Set-Cookie', buildSessionCookieHeader(req, sessionValue));
        if (req.method === 'GET' || req.method === 'HEAD') {
            res.redirect(302, stripTokenFromUrl(req.originalUrl || req.url, basePath));
            return;
        }
        next();
        return;
    }

    res.redirect(302, buildLoginRedirect(req, basePath));
}

function requireApiAccess(req: Request, res: Response, next: NextFunction): void {
    if (isAuthorizedRequest(req)) {
        next();
        return;
    }

    const { password, apiToken } = getWebConsoleConfig();
    res.status(401).json({
        success: false,
        error: password
            ? 'Authentication required'
            : (apiToken ? 'Forbidden' : 'Web API is restricted to localhost by default'),
    });
}

export function startWebServer() {
    const webConfig = getWebConsoleConfig();
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server, path: buildWebPath(webConfig.basePath, '/ws/logs') });
    const webRouter = express.Router();

    // Middleware
    webRouter.use(express.json({ limit: '20mb' }));
    webRouter.use(express.urlencoded({ extended: false }));

    webRouter.get('/login', (req, res) => {
        if (!webConfig.password) {
            res.redirect(302, buildWebPath(webConfig.basePath, '/'));
            return;
        }

        if (hasWebConsoleAccess(req)) {
            const nextPath = sanitizeNextPath(typeof req.query.next === 'string' ? req.query.next : '/', webConfig.basePath);
            res.redirect(302, nextPath);
            return;
        }

        const nextPath = sanitizeNextPath(typeof req.query.next === 'string' ? req.query.next : '/', webConfig.basePath);
        res.status(200).type('html').send(renderLoginPage(webConfig.basePath, nextPath));
    });

    webRouter.post('/login', (req, res) => {
        if (!webConfig.password) {
            res.redirect(302, buildWebPath(webConfig.basePath, '/'));
            return;
        }

        const submittedPassword = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
        const nextPath = sanitizeNextPath(typeof req.body?.next === 'string' ? req.body.next : '/', webConfig.basePath);
        const submittedHash = createHash('sha256')
            .update(`genesis-web-password:${submittedPassword}`)
            .digest('hex');

        if (!safeEqual(submittedHash, getWebPasswordHash())) {
            res.status(401).type('html').send(renderLoginPage(webConfig.basePath, nextPath, '密码错误，请重试。'));
            return;
        }

        const sessionValue = createAuthorizedSession();
        res.setHeader('Set-Cookie', buildSessionCookieHeader(req, sessionValue));
        res.redirect(302, nextPath);
    });

    webRouter.post('/logout', (req, res) => {
        revokeAuthorizedSession(req.headers.cookie);
        res.setHeader('Set-Cookie', buildClearSessionCookieHeader(req));
        res.status(204).end();
    });

    // API Routes
    webRouter.use('/api', requireApiAccess);
    webRouter.use('/api', apiRouter);

    webRouter.use(requireWebConsoleAccess);
    webRouter.use(express.static(join(__dirname, 'public')));
    app.use(webConfig.basePath || '/', webRouter);

    // WebSocket handling
    wss.on('connection', (ws, req) => {
        if (!isAuthorizedSocketRequest(req)) {
            ws.close(1008, 'Forbidden');
            return;
        }
        logSubscribers.add(ws);
        // log.debug('WebSocket 日志客户端已连接');
        ws.on('close', () => logSubscribers.delete(ws));
    });

    // 注册日志监听器
    log.addListener((level, msg) => broadcastLog(level, msg));

    if (!isLoopbackHost(webConfig.host) && !webConfig.apiToken && !webConfig.password) {
        log.warn(`Web API is bound to ${webConfig.host} without WEB_API_TOKEN; non-local requests will be rejected`);
    } else if (!isLoopbackHost(webConfig.host) && webConfig.password && !webConfig.apiToken) {
        log.info('🌍 Web 控制台可远程登录访问；未登录或脚本直连的 API/WS 请求仍会被拒绝');
    }

    if (webConfig.password) {
        log.info('🔐 Web 控制台已启用密码登录保护');
    }

    server.listen(webConfig.port, webConfig.host, () => {
        const binding = webConfig.host.includes(':')
            ? `http://[${webConfig.host}]:${webConfig.port}`
            : `http://${webConfig.host}:${webConfig.port}`;
        const externalPath = buildWebPath(webConfig.basePath, '/');
        log.info(`Web API binding: ${binding}`);
        log.info(`🌐 Web 控制台已启动: http://localhost:${webConfig.port}${externalPath}`);
    });
}

export const __webServerTestUtils = {
    extractHostName,
    hasForwardingHeaders,
    isTrustedLoopbackRequest,
    createAuthorizedSession,
    hasAuthorizedSession,
    revokeAuthorizedSession,
};

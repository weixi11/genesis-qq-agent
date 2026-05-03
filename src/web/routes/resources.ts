import express from 'express';
import type { Router, Request, Response } from 'express';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { KnowledgeRequest, BlacklistRequest, UpdateProfileRequest } from '../types.js';
import { log } from '../../logger.js';
import { config, getWebConsoleConfig } from '../../config.js';
import { profiler } from '../../agents/profiler.js';
import { getContextSessionFromDisk, listContextSessionsFromDisk, memory } from '../../memory.js';
import { getAllProfiles, getProfileAsync, deleteProfile, deleteAllProfiles, updateProfile } from '../../profiler/store.js';
import {
    enqueueProfilerReanalyzeRequest,
    getProfilerReanalyzeRequest,
} from '../../profiler/reanalyze_request_store.js';
import type { AnalysisMessage, FormattedMessage, ProfileTagEvidence, UserProfile } from '../../types.js';
import { listKnowledge, addKnowledge, deleteKnowledge, getKnowledge, updateKnowledge } from '../../vectordb/knowledge.js';
import { parseEnvFileSync, updateEnvVariable } from '../../utils/env.js';
import { isRecord, safeParseJson } from '../../utils/json.js';
import { getGenesisProcessRole, syncAdapterProcess, syncGenesisAgentProcess } from '../services/process_control.js';
import { memeCatalog } from '../../services/meme_catalog.js';

export const resourcesRouter: Router = express.Router();

const PROFILE_RECALCULATE_LIMIT = 20;
const PROFILE_RECALCULATE_CONTEXT_WINDOW = 6;
const PROFILE_RECALCULATE_REQUEST_POLL_MS = 300;
const PROFILE_RECALCULATE_WAIT_TIMEOUT_MS = 30000;
const DEFAULT_ADAPTER_ENV_PATH = '/root/ll/genesis-napcat-adapter/.env';
const DEFAULT_ADAPTER_FILTER_META_PATH = '/root/ll/genesis-napcat-adapter/cache/access-rules.json';
const PROFILE_EVIDENCE_FIELD_PAIRS = [
    ['traits', 'traitEvidence'],
    ['interests', 'interestEvidence'],
    ['identityFacts', 'identityEvidence'],
    ['likes', 'likeEvidence'],
    ['dislikes', 'dislikeEvidence'],
    ['redLines', 'redLineEvidence'],
    ['emotionPatterns', 'emotionPatternEvidence'],
    ['emotionalTriggers', 'emotionalTriggerEvidence'],
    ['calmingSignals', 'calmingSignalEvidence'],
    ['relationshipNotes', 'relationshipNoteEvidence'],
    ['boundaryNotes', 'boundaryNoteEvidence'],
] as const;

interface MemePackAdminRecord {
    id: string;
    label: string;
    description?: string;
    aliases: string[];
    scenes: string[];
    weight: number;
    cooldownSec: number;
    files: string[];
}

interface MemeManifestBody {
    version?: string;
    sourceDir?: string;
    packs?: MemePackAdminRecord[];
}

interface MemePackUpsertRequest {
    id?: string;
    label?: string;
    description?: string;
    aliases?: string[];
    scenes?: string[];
    weight?: number;
    cooldownSec?: number;
}

interface MemeFileUploadRequest {
    name?: string;
    dataUrl?: string;
}

interface MemeArchiveImportRequest extends MemePackUpsertRequest {
    name?: string;
    dataUrl?: string;
}

function parseUserIdParam(rawUserId: string): number {
    return parseInt(rawUserId, 10);
}

function getManualValues(entries: ProfileTagEvidence[]): string[] {
    return Array.from(new Set(
        entries
            .filter(entry => entry.source === 'manual')
            .map(entry => entry.value.trim())
            .filter(Boolean),
    ));
}

function getManualMemories(profile: UserProfile, field: 'importantMemories' | 'conflictRecords') {
    return profile[field].filter((entry) => entry.source === 'manual');
}

function buildEvidenceResetPayload(profile: UserProfile): UpdateProfileRequest {
    const payload: UpdateProfileRequest = {
        mood: 'neutral',
        notes: '',
        lastAnalyzed: 0,
        importantMemories: getManualMemories(profile, 'importantMemories'),
        conflictRecords: getManualMemories(profile, 'conflictRecords'),
    };

    for (const [valuesKey, evidenceKey] of PROFILE_EVIDENCE_FIELD_PAIRS) {
        payload[valuesKey] = getManualValues(profile[evidenceKey]);
    }

    return payload;
}

function resolveProfileMessageText(message: FormattedMessage): string {
    const candidate = message.text?.trim() || message.summary?.trim() || '';
    return candidate;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAdapterEnvPath(): string {
    return path.resolve(process.env.GENESIS_ADAPTER_ENV_PATH || DEFAULT_ADAPTER_ENV_PATH);
}

function getAdapterFilterMetaPath(): string {
    return path.resolve(process.env.GENESIS_ADAPTER_FILTER_META_PATH || DEFAULT_ADAPTER_FILTER_META_PATH);
}

function parseNumberArrayEnv(value: string | undefined): number[] {
    if (!value) return [];
    return value
        .split(',')
        .map(item => Number.parseInt(item.trim(), 10))
        .filter(item => Number.isFinite(item));
}

type AdapterFilterType = 'user' | 'group';
type AdapterFilterListType = 'black' | 'white';

interface AdapterFilterEntry {
    id: number;
    ruleId: string;
    type: AdapterFilterType;
    targetId: number;
    reason: string;
}

interface AdapterFilterMetaRecord {
    type: AdapterFilterType;
    listType: AdapterFilterListType;
    targetId: number;
    reason: string;
    createdAt: string;
}

function getAdapterFilterEnvKey(listType: AdapterFilterListType, type: AdapterFilterType): string {
    if (listType === 'white') {
        return type === 'group' ? 'WHITELIST_GROUPS' : 'WHITELIST_USERS';
    }
    return type === 'group' ? 'BLACKLIST_GROUPS' : 'BLACKLIST_USERS';
}

function getAdapterFilterReason(listType: AdapterFilterListType, type: AdapterFilterType): string {
    if (listType === 'white') {
        return type === 'group' ? '仅允许该群聊消息进入 genesis' : '仅允许该私聊用户进入 genesis';
    }
    return type === 'group' ? '直接丢弃该群聊消息' : '直接丢弃该私聊用户消息';
}

function buildAdapterFilterRuleId(listType: AdapterFilterListType, type: AdapterFilterType, targetId: number): string {
    return `${listType}:${type}:${targetId}`;
}

function parseAdapterFilterRuleId(ruleId: string): {
    listType: AdapterFilterListType;
    type: AdapterFilterType;
    targetId: number;
} | null {
    const matched = ruleId.match(/^(black|white):(group|user):(\d+)$/u);
    if (!matched) {
        return null;
    }

    return {
        listType: matched[1] as AdapterFilterListType,
        type: matched[2] as AdapterFilterType,
        targetId: Number.parseInt(matched[3], 10),
    };
}

function buildAdapterFilterEntry(
    listType: AdapterFilterListType,
    type: AdapterFilterType,
    targetId: number,
    reason: string,
    env: Record<string, string>,
): AdapterFilterEntry {
    const groupCount = parseNumberArrayEnv(env[getAdapterFilterEnvKey(listType, 'group')]).length;
    const currentTypeValues = parseNumberArrayEnv(env[getAdapterFilterEnvKey(listType, type)]);
    const currentTypeIndex = currentTypeValues.indexOf(targetId);
    const id = type === 'user'
        ? groupCount + (currentTypeIndex >= 0 ? currentTypeIndex + 1 : currentTypeValues.length + 1)
        : (currentTypeIndex >= 0 ? currentTypeIndex + 1 : currentTypeValues.length + 1);

    return {
        id,
        ruleId: buildAdapterFilterRuleId(listType, type, targetId),
        type,
        targetId,
        reason,
    };
}

function readAdapterFilterMeta(): AdapterFilterMetaRecord[] {
    const metaPath = getAdapterFilterMetaPath();
    try {
        if (!fs.existsSync(metaPath)) {
            return [];
        }
        const content = fs.readFileSync(metaPath, 'utf-8').trim();
        if (!content) return [];
        const parsed = safeParseJson(content);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is AdapterFilterMetaRecord => (
            isRecord(item)
            && (item.type === 'user' || item.type === 'group')
            && (item.listType === 'black' || item.listType === 'white')
            && Number.isFinite(item.targetId)
            && typeof item.reason === 'string'
            && typeof item.createdAt === 'string'
        ));
    } catch {
        return [];
    }
}

function writeAdapterFilterMeta(records: AdapterFilterMetaRecord[]): boolean {
    const metaPath = getAdapterFilterMetaPath();
    try {
        fs.mkdirSync(path.dirname(metaPath), { recursive: true });
        fs.writeFileSync(metaPath, JSON.stringify(records, null, 2), 'utf-8');
        return true;
    } catch {
        return false;
    }
}

function readAdapterFilterEntries(): { blacklist: AdapterFilterEntry[]; whitelist: AdapterFilterEntry[] } {
    syncAdapterFilterMetaWithEnv();
    const env = parseEnvFileSync(getAdapterEnvPath());
    const meta = readAdapterFilterMeta();
    const buildEntries = (listType: AdapterFilterListType): AdapterFilterEntry[] => {
        const entries: AdapterFilterEntry[] = [];
        for (const type of ['group', 'user'] as const) {
            const key = getAdapterFilterEnvKey(listType, type);
            const values = parseNumberArrayEnv(env[key]);
            for (const targetId of values) {
                const metaRecord = meta.find(item => item.listType === listType && item.type === type && item.targetId === targetId);
                entries.push({
                    id: entries.length + 1,
                    ruleId: buildAdapterFilterRuleId(listType, type, targetId),
                    type,
                    targetId,
                    reason: metaRecord?.reason || getAdapterFilterReason(listType, type),
                });
            }
        }
        return entries;
    };

    return {
        blacklist: buildEntries('black'),
        whitelist: buildEntries('white'),
    };
}

function persistAdapterFilterList(key: string, values: number[]): boolean {
    return updateEnvVariable(key, values.join(','), { envPath: getAdapterEnvPath() });
}

function rollbackAdapterFilterList(key: string, previousValues: number[]): boolean {
    return persistAdapterFilterList(key, previousValues);
}

function syncAdapterFilterMetaWithEnv(): void {
    const env = parseEnvFileSync(getAdapterEnvPath());
    const meta = readAdapterFilterMeta();
    const next = meta.filter((item) => {
        const key = getAdapterFilterEnvKey(item.listType, item.type);
        return parseNumberArrayEnv(env[key]).includes(item.targetId);
    });
    if (next.length !== meta.length) {
        writeAdapterFilterMeta(next);
    }
}

async function maybeSyncAdapterAfterFilterMutation<T extends Record<string, unknown>>(
    payload: T,
    successMessage: string,
): Promise<T & {
    adapterSync: Awaited<ReturnType<typeof syncAdapterProcess>>;
    message: string;
}> {
    const adapterSync = await syncAdapterProcess();
    return {
        ...payload,
        adapterSync,
        message: adapterSync.applied
            ? successMessage
            : `${successMessage}，但 NapCat 适配器同步失败`,
    };
}

async function buildRecentAnalysisMessages(userId: number): Promise<AnalysisMessage[]> {
    const collected: AnalysisMessage[] = [];
    const seen = new Set<string>();

    const role = getGenesisProcessRole();
    const sessions = role === 'web'
        ? await listContextSessionsFromDisk()
        : memory.getAllSessions();

    for (const session of sessions) {
        const messages = role === 'web'
            ? await getContextSessionFromDisk(session.key)
            : memory.getSessionByKey(session.key);
        if (!messages?.length) {
            continue;
        }

        for (let index = 0; index < messages.length; index++) {
            const message = messages[index];
            if (message.sender_id !== userId) {
                continue;
            }

            const text = resolveProfileMessageText(message);
            if (!text) {
                continue;
            }

            const identity = `${message.message_id}:${message.time}:${session.key}`;
            if (seen.has(identity)) {
                continue;
            }
            seen.add(identity);

            const context = messages
                .slice(Math.max(0, index - PROFILE_RECALCULATE_CONTEXT_WINDOW), index)
                .map((item) => ({
                    sender: item.sender_name || String(item.sender_id),
                    text: resolveProfileMessageText(item),
                }))
                .filter((item) => item.text);

            collected.push({
                userId,
                nickname: message.sender_name || String(userId),
                groupId: message.group_id,
                text,
                timestamp: message.time > 0 ? message.time * 1000 : Date.now(),
                context,
            });
        }
    }

    return collected
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(-PROFILE_RECALCULATE_LIMIT);
}

async function maybeSyncAgentAfterProfileMutation<T extends Record<string, unknown>>(
    payload: T,
    successMessage?: string,
): Promise<T & {
    agentSync?: Awaited<ReturnType<typeof syncGenesisAgentProcess>>;
    message?: string;
}> {
    if (getGenesisProcessRole() !== 'web') {
        return payload;
    }

    const agentSync = await syncGenesisAgentProcess();
    const message = successMessage
        ? (
            agentSync.applied
                ? `${successMessage}，genesis-agent 已同步`
                : `${successMessage}，但 genesis-agent 同步失败`
        )
        : undefined;
    return {
        ...payload,
        agentSync,
        ...(message ? { message } : {}),
    };
}

function getMemeManifestPath(): string {
    const manifestPath = config.autoMeme.manifestPath;
    return path.isAbsolute(manifestPath) ? manifestPath : path.join(process.cwd(), manifestPath);
}

function getDefaultMemeSourceDir(): string {
    const sourceDir = config.autoMeme.sourceDir;
    return path.isAbsolute(sourceDir) ? sourceDir : path.join(process.cwd(), sourceDir);
}

function readMemeManifest(): MemeManifestBody {
    const manifestPath = getMemeManifestPath();
    if (!fs.existsSync(manifestPath)) {
        return {
            version: '1.0.0',
            sourceDir: getDefaultMemeSourceDir(),
            packs: [],
        };
    }

    let parsed: MemeManifestBody;
    try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const parsedJson = safeParseJson(raw);
        if (!isRecord(parsedJson)) {
            throw new Error('manifest 不是 JSON 对象');
        }
        parsed = parsedJson as MemeManifestBody;
    } catch (err) {
        log.warn('🎭 解析表情包 manifest 失败，按空配置处理:', err);
        return {
            version: '1.0.0',
            sourceDir: getDefaultMemeSourceDir(),
            packs: [],
        };
    }

    return {
        version: parsed.version || '1.0.0',
        sourceDir: parsed.sourceDir || getDefaultMemeSourceDir(),
        packs: Array.isArray(parsed.packs) ? parsed.packs : [],
    };
}

function writeMemeManifest(manifest: MemeManifestBody): void {
    const manifestPath = getMemeManifestPath();
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    memeCatalog.invalidate();
}

function resolveMemeSourceDir(manifest: MemeManifestBody): string {
    const configured = manifest.sourceDir || getDefaultMemeSourceDir();
    return path.isAbsolute(configured) ? configured : path.join(path.dirname(getMemeManifestPath()), configured);
}

function sanitizeMemeId(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function normalizeStringArray(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return Array.from(new Set(raw
        .map(item => String(item).trim())
        .filter(Boolean)));
}

function buildMemePreviewUrl(packId: string, filename: string): string {
    const basePath = getWebConsoleConfig().basePath;
    const relativePath = `api/memes/${encodeURIComponent(packId)}/files/${encodeURIComponent(filename)}`;
    return basePath ? `${basePath}/${relativePath}` : `/${relativePath}`;
}

function serializeMemePack(pack: MemePackAdminRecord) {
    return {
        ...pack,
        previewUrls: pack.files.map(file => buildMemePreviewUrl(pack.id, file)),
    };
}

function isSupportedMemeImage(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext);
}

function listSourceDirFiles(sourceDir: string): string[] {
    if (!fs.existsSync(sourceDir)) return [];
    return fs.readdirSync(sourceDir)
        .filter(item => fs.statSync(path.join(sourceDir, item)).isFile())
        .filter(isSupportedMemeImage)
        .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function collectReferencedMemeFiles(manifest: MemeManifestBody): Set<string> {
    return new Set((manifest.packs || []).flatMap(pack => Array.isArray(pack.files) ? pack.files : []));
}

function getMemeOrphanFiles(manifest: MemeManifestBody): string[] {
    const sourceDir = resolveMemeSourceDir(manifest);
    const referenced = collectReferencedMemeFiles(manifest);
    return listSourceDirFiles(sourceDir).filter(file => !referenced.has(file));
}

function buildMemeOverview(manifest: MemeManifestBody) {
    const sourceDir = resolveMemeSourceDir(manifest);
    const orphanFiles = getMemeOrphanFiles(manifest);
    const totalFiles = (manifest.packs || []).reduce((sum, pack) => sum + (Array.isArray(pack.files) ? pack.files.length : 0), 0);
    return {
        manifestPath: getMemeManifestPath(),
        sourceDir,
        totalFiles,
        orphanFiles,
        packs: (manifest.packs || []).map(serializeMemePack),
    };
}

function inferMimeTypeByFilename(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    return 'application/octet-stream';
}

function decodeDataUrl(dataUrl: string): { buffer: Buffer; mime: string } | null {
    const matched = dataUrl.match(/^data:([^;]+);base64,(.+)$/u);
    if (!matched) return null;
    try {
        return {
            mime: matched[1],
            buffer: Buffer.from(matched[2], 'base64'),
        };
    } catch {
        return null;
    }
}

function getExtensionForMime(mime: string): string {
    if (mime === 'image/png') return '.png';
    if (mime === 'image/gif') return '.gif';
    if (mime === 'image/webp') return '.webp';
    return '.jpg';
}

function sanitizeUploadFilename(name: string, fallbackExt: string): string {
    const normalized = path.basename(name)
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!normalized) {
        return `meme_${Date.now()}${fallbackExt}`;
    }
    return path.extname(normalized) ? normalized : `${normalized}${fallbackExt}`;
}

function buildUniqueUploadFilename(sourceDir: string, filename: string): string {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext) || 'meme';
    let candidate = filename;
    let index = 1;
    while (fs.existsSync(path.join(sourceDir, candidate))) {
        candidate = `${base}_${index}${ext}`;
        index += 1;
    }
    return candidate;
}

function getArchiveExtension(name: string, mime: string): string {
    const lower = name.trim().toLowerCase();
    if (lower.endsWith('.tar.gz')) return '.tar.gz';
    if (lower.endsWith('.tgz')) return '.tgz';
    const ext = path.extname(lower);
    if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) {
        return ext;
    }
    if (mime.includes('zip')) return '.zip';
    if (mime.includes('rar')) return '.rar';
    if (mime.includes('7z')) return '.7z';
    if (mime.includes('tar')) return '.tar';
    return '.bin';
}

function sanitizeArchiveName(name: string, fallbackExt: string): string {
    const normalized = path.basename(name)
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!normalized) return `archive_${Date.now()}${fallbackExt}`;
    if (normalized.toLowerCase().endsWith('.tar.gz')) return normalized;
    return path.extname(normalized) ? normalized : `${normalized}${fallbackExt}`;
}

function resolveArchiveImportIdentity(request: MemeArchiveImportRequest, fallbackName: string) {
    const rawName = String(request.name || fallbackName || '').trim();
    const fallbackBase = rawName.replace(/\.(tar\.gz|zip|rar|7z|tar|gz|tgz)$/iu, '');
    const id = sanitizeMemeId(String(request.id || fallbackBase || 'meme_pack'));
    const label = String(request.label || fallbackBase || id).trim();
    return {
        id,
        label,
        description: String(request.description || '').trim(),
    };
}

function walkFilesRecursively(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) return [];
    const result: string[] = [];
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            result.push(...walkFilesRecursively(fullPath));
            continue;
        }
        if (entry.isFile()) {
            result.push(fullPath);
        }
    }
    return result;
}

function importArchiveImagesToPack(
    sourceDir: string,
    archiveName: string,
    decoded: { buffer: Buffer; mime: string },
): string[] {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-meme-archive-'));
    const archiveExt = getArchiveExtension(archiveName, decoded.mime);
    const archiveFilename = sanitizeArchiveName(archiveName, archiveExt);
    const archivePath = path.join(tempRoot, archiveFilename);
    const extractDir = path.join(tempRoot, 'extract');

    try {
        fs.mkdirSync(extractDir, { recursive: true });
        fs.writeFileSync(archivePath, decoded.buffer);

        const extracted = spawnSync('unar', ['-f', '-o', extractDir, archivePath], {
            encoding: 'utf-8',
        });
        if (extracted.error) {
            throw new Error('未找到 unar，请先安装以支持压缩包导入');
        }
        if (extracted.status !== 0) {
            throw new Error((extracted.stderr || extracted.stdout || '压缩包解压失败').trim());
        }

        const imageFiles = walkFilesRecursively(extractDir)
            .filter(file => isSupportedMemeImage(file))
            .sort((left, right) => left.localeCompare(right, 'zh-CN'));
        if (imageFiles.length === 0) {
            throw new Error('压缩包里没有可导入的图片');
        }

        fs.mkdirSync(sourceDir, { recursive: true });
        const importedFiles: string[] = [];
        for (const imagePath of imageFiles) {
            const ext = path.extname(imagePath).toLowerCase() || '.png';
            const baseName = sanitizeUploadFilename(path.basename(imagePath), ext);
            const targetName = buildUniqueUploadFilename(sourceDir, baseName);
            fs.copyFileSync(imagePath, path.join(sourceDir, targetName));
            importedFiles.push(targetName);
        }
        return importedFiles;
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

async function waitForProfilerReanalyzeRequest(
    requestId: string,
    timeoutMs: number = PROFILE_RECALCULATE_WAIT_TIMEOUT_MS,
) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const request = await getProfilerReanalyzeRequest(requestId);
        if (!request) {
            return undefined;
        }
        if (request.status === 'success' || request.status === 'failed') {
            return request;
        }
        await sleep(PROFILE_RECALCULATE_REQUEST_POLL_MS);
    }

    return getProfilerReanalyzeRequest(requestId);
}

function buildProfilerReanalyzeResponse(
    request: Awaited<ReturnType<typeof getProfilerReanalyzeRequest>>,
    profile?: UserProfile,
) {
    if (!request) {
        return { statusCode: 404, body: { success: false, error: '画像重算请求不存在' } };
    }

    if (request.status === 'success') {
        if (!profile) {
            return { statusCode: 404, body: { success: false, error: '画像不存在' } };
        }

        return {
            statusCode: 200,
            body: {
                success: true,
                queued: true,
                completed: true,
                requestId: request.requestId,
                analyzedCount: request.analyzedCount || request.messages.length,
                message: '画像重算已由 genesis-agent 执行完成',
                profile,
            },
        };
    }

    if (request.status === 'failed') {
        return {
            statusCode: 200,
            body: {
                success: false,
                queued: true,
                completed: true,
                requestId: request.requestId,
                analyzedCount: request.analyzedCount || request.messages.length,
                message: '画像重算请求已到达 genesis-agent，但执行失败',
                error: request.errorMessage || '画像重算失败',
                profile,
            },
        };
    }

    return {
        statusCode: 200,
        body: {
            success: true,
            queued: true,
            completed: false,
            requestId: request.requestId,
            analyzedCount: request.messages.length,
            message: request.status === 'running'
                ? '画像重算请求已被 genesis-agent 接收，正在执行中'
                : '画像重算请求已提交给 genesis-agent，等待执行',
            profile,
        },
    };
}

// Profiles
resourcesRouter.get('/profiles', (req, res) => {
    try {
        const profiles = getAllProfiles();
        res.json(profiles);
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.delete('/profiles', async (req, res) => {
    try {
        const deletedCount = deleteAllProfiles();
        log.info(`📊 Web 已清空全部画像，共 ${deletedCount} 条`);
        res.json(await maybeSyncAgentAfterProfileMutation({ success: true, deletedCount }, '已删除全部画像'));
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.get('/profiles/:userId', (req, res) => {
    try {
        const userId = parseInt(req.params.userId, 10);
        const profile = getProfileAsync(userId);
        if (!profile) return res.status(404).json({ error: '画像不存在' });
        res.json(profile);
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.put('/profiles/:userId', async (req: Request<{ userId: string }, unknown, UpdateProfileRequest>, res: Response) => {
    try {
        const userId = parseUserIdParam(req.params.userId);
        const profile = updateProfile(userId, req.body);
        res.json(await maybeSyncAgentAfterProfileMutation({ success: true, profile }, '画像已保存'));
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.post('/profiles/:userId/reset-evidence', async (req, res) => {
    try {
        const userId = parseUserIdParam(req.params.userId);
        const profile = getProfileAsync(userId);
        if (!profile) return res.status(404).json({ error: '画像不存在' });

        const updated = updateProfile(userId, buildEvidenceResetPayload(profile));
        if (!updated) return res.status(404).json({ error: '画像不存在' });

        log.info(`📊 已清理画像证据: ${updated.nickname} (${userId})`);
        res.json(await maybeSyncAgentAfterProfileMutation({ success: true, profile: updated }, '画像证据已清理'));
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.post('/profiles/:userId/recalculate', async (req, res) => {
    try {
        const userId = parseUserIdParam(req.params.userId);
        const profile = getProfileAsync(userId);
        if (!profile) return res.status(404).json({ error: '画像不存在' });

        const messages = await buildRecentAnalysisMessages(userId);
        if (messages.length === 0) {
            return res.status(400).json({ error: '近期记忆中没有可用于重算的消息' });
        }

        if (getGenesisProcessRole() === 'web') {
            const request = await enqueueProfilerReanalyzeRequest(userId, messages);
            const settled = await waitForProfilerReanalyzeRequest(request.requestId);
            if (settled?.status === 'failed') {
                return res.status(500).json({
                    error: settled.errorMessage || '画像重算失败',
                    requestId: request.requestId,
                });
            }

            const updated = getProfileAsync(userId);
            if (!updated) return res.status(404).json({ error: '画像不存在' });

            if (settled?.status === 'success') {
                log.info(`📊 已提交画像重算并由 agent 完成: ${updated.nickname} (${userId}), 使用 ${messages.length} 条近期消息`);
                return res.json({
                    success: true,
                    queued: true,
                    completed: true,
                    requestId: request.requestId,
                    analyzedCount: settled.analyzedCount || messages.length,
                    profile: updated,
                });
            }

            return res.json({
                success: true,
                queued: true,
                completed: false,
                requestId: request.requestId,
                analyzedCount: messages.length,
                profile: updated,
                message: '画像重算请求已提交给 agent，正在后台执行',
            });
        }

        await profiler.reanalyzeMessages(messages);

        const updated = getProfileAsync(userId);
        if (!updated) return res.status(404).json({ error: '画像不存在' });

        log.info(`📊 已重算画像: ${updated.nickname} (${userId}), 使用 ${messages.length} 条近期消息`);
        res.json(await maybeSyncAgentAfterProfileMutation({
            success: true,
            analyzedCount: messages.length,
            profile: updated,
        }, '画像已重算'));
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.get('/profiles/:userId/recalculate/:requestId', async (req, res) => {
    try {
        const userId = parseUserIdParam(req.params.userId);
        const request = await getProfilerReanalyzeRequest(req.params.requestId);
        if (request && request.userId !== userId) {
            return res.status(404).json({ success: false, error: '画像重算请求不存在' });
        }

        const profile = getProfileAsync(userId);
        const response = buildProfilerReanalyzeResponse(request, profile);
        res.status(response.statusCode).json(response.body);
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.delete('/profiles/:userId', async (req, res) => {
    try {
        const userId = parseUserIdParam(req.params.userId);
        deleteProfile(userId);
        res.json(await maybeSyncAgentAfterProfileMutation({ success: true }, '画像已删除'));
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

// Knowledge
resourcesRouter.get('/knowledge', async (req, res) => {
    try {
        const list = await listKnowledge(100);
        res.json(list);
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.get('/knowledge/:id', async (req, res) => {
    try {
        const item = await getKnowledge(req.params.id);
        if (!item) return res.status(404).json({ error: 'Knowledge not found' });
        res.json(item);
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.post('/knowledge', async (req: Request<unknown, unknown, KnowledgeRequest>, res: Response) => {
    const { text, source, category } = req.body;
    if (!text) return res.status(400).json({ error: '内容不能为空' });
    try {
        const count = await addKnowledge(text, source || 'Web控制台', category);
        res.json({ success: true, count });
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.put('/knowledge/:id', async (req: Request<{ id: string }, unknown, KnowledgeRequest>, res: Response) => {
    const { text, source, category } = req.body;
    const { id } = req.params;
    if (!text) return res.status(400).json({ error: '内容不能为空' });

    try {
        const updated = await updateKnowledge(id, text, source || '手动修改', category);
        if (!updated) {
            return res.status(404).json({ error: 'Knowledge not found' });
        }
        res.json({ success: true, id });
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.delete('/knowledge/:id', async (req, res) => {
    try {
        await deleteKnowledge(req.params.id);
        res.json({ success: true });
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.get('/memes', async (_req, res) => {
    try {
        const manifest = readMemeManifest();
        res.json({
            success: true,
            ...buildMemeOverview(manifest),
        });
    } catch (e: unknown) {
        res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.post('/memes/reload', async (_req, res) => {
    try {
        memeCatalog.invalidate();
        const manifest = readMemeManifest();
        res.json(await maybeSyncAgentAfterProfileMutation({
            success: true,
            ...buildMemeOverview(manifest),
        }, '表情包配置已重载'));
    } catch (e: unknown) {
        res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.post('/memes', async (req: Request<unknown, unknown, MemePackUpsertRequest>, res: Response) => {
    const manifest = readMemeManifest();
    const sourceDir = resolveMemeSourceDir(manifest);
    const id = sanitizeMemeId(String(req.body.id || ''));
    const label = String(req.body.label || '').trim();
    if (!id || !label) {
        return res.status(400).json({ success: false, error: '分组 id 和名称不能为空' });
    }
    if ((manifest.packs || []).some(item => item.id === id)) {
        return res.status(409).json({ success: false, error: '分组 id 已存在' });
    }

    const nextPack: MemePackAdminRecord = {
        id,
        label,
        description: String(req.body.description || '').trim(),
        aliases: normalizeStringArray(req.body.aliases),
        scenes: normalizeStringArray(req.body.scenes),
        weight: Math.max(1, Number(req.body.weight || 1)),
        cooldownSec: Math.max(0, Number(req.body.cooldownSec || 60)),
        files: [],
    };

    manifest.packs = [...(manifest.packs || []), nextPack];
    fs.mkdirSync(sourceDir, { recursive: true });
    writeMemeManifest(manifest);
    res.json(await maybeSyncAgentAfterProfileMutation({ success: true, pack: serializeMemePack(nextPack) }, '表情包分组已创建'));
});

resourcesRouter.put('/memes/:id', async (req: Request<{ id: string }, unknown, MemePackUpsertRequest>, res: Response) => {
    const manifest = readMemeManifest();
    const packs = manifest.packs || [];
    const index = packs.findIndex(item => item.id === req.params.id);
    if (index < 0) {
        return res.status(404).json({ success: false, error: '表情包分组不存在' });
    }

    const current = packs[index];
    const nextId = sanitizeMemeId(String(req.body.id || current.id));
    const nextLabel = String(req.body.label || current.label).trim();
    if (!nextId || !nextLabel) {
        return res.status(400).json({ success: false, error: '分组 id 和名称不能为空' });
    }
    if (nextId !== current.id && packs.some(item => item.id === nextId)) {
        return res.status(409).json({ success: false, error: '新的分组 id 已存在' });
    }

    const nextPack: MemePackAdminRecord = {
        ...current,
        id: nextId,
        label: nextLabel,
        description: String(req.body.description ?? current.description ?? '').trim(),
        aliases: normalizeStringArray(req.body.aliases ?? current.aliases),
        scenes: normalizeStringArray(req.body.scenes ?? current.scenes),
        weight: Math.max(1, Number(req.body.weight ?? current.weight)),
        cooldownSec: Math.max(0, Number(req.body.cooldownSec ?? current.cooldownSec)),
    };

    packs[index] = nextPack;
    manifest.packs = packs;
    writeMemeManifest(manifest);
    res.json(await maybeSyncAgentAfterProfileMutation({ success: true, pack: serializeMemePack(nextPack) }, '表情包分组已更新'));
});

resourcesRouter.delete('/memes/:id', async (req, res) => {
    const manifest = readMemeManifest();
    const packs = manifest.packs || [];
    const pack = packs.find(item => item.id === req.params.id);
    if (!pack) {
        return res.status(404).json({ success: false, error: '表情包分组不存在' });
    }

    manifest.packs = packs.filter(item => item.id !== req.params.id);
    writeMemeManifest(manifest);
    res.json(await maybeSyncAgentAfterProfileMutation({ success: true, pack: serializeMemePack(pack) }, '表情包分组已删除'));
});

resourcesRouter.get('/memes/:id/files/:name', async (req, res) => {
    try {
        const manifest = readMemeManifest();
        const pack = (manifest.packs || []).find(item => item.id === req.params.id);
        if (!pack) {
            return res.status(404).send('Pack not found');
        }
        const filename = path.basename(req.params.name);
        if (!pack.files.includes(filename)) {
            return res.status(404).send('File not found');
        }
        const sourceDir = resolveMemeSourceDir(manifest);
        const filePath = path.join(sourceDir, filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).send('File missing');
        }
        res.type(inferMimeTypeByFilename(filename));
        res.sendFile(filePath);
    } catch (e: unknown) {
        res.status(500).send(e instanceof Error ? e.message : String(e));
    }
});

resourcesRouter.post('/memes/:id/files', async (req: Request<{ id: string }, unknown, MemeFileUploadRequest>, res: Response) => {
    const manifest = readMemeManifest();
    const packs = manifest.packs || [];
    const pack = packs.find(item => item.id === req.params.id);
    if (!pack) {
        return res.status(404).json({ success: false, error: '表情包分组不存在' });
    }

    const dataUrl = String(req.body.dataUrl || '');
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded || !decoded.mime.startsWith('image/')) {
        return res.status(400).json({ success: false, error: '请上传有效的图片数据' });
    }

    const sourceDir = resolveMemeSourceDir(manifest);
    fs.mkdirSync(sourceDir, { recursive: true });
    const requestedName = sanitizeUploadFilename(String(req.body.name || ''), getExtensionForMime(decoded.mime));
    const filename = buildUniqueUploadFilename(sourceDir, requestedName);
    const filePath = path.join(sourceDir, filename);
    fs.writeFileSync(filePath, decoded.buffer);

    if (!pack.files.includes(filename)) {
        pack.files.push(filename);
    }
    writeMemeManifest(manifest);
    res.json(await maybeSyncAgentAfterProfileMutation({
        success: true,
        file: filename,
        pack: serializeMemePack(pack),
    }, '表情图片已上传'));
});

resourcesRouter.post('/memes/import-archive', async (req: Request<unknown, unknown, MemeArchiveImportRequest>, res: Response) => {
    const dataUrl = String(req.body.dataUrl || '');
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) {
        return res.status(400).json({ success: false, error: '请上传有效的压缩包数据' });
    }

    const manifest = readMemeManifest();
    const sourceDir = resolveMemeSourceDir(manifest);
    const identity = resolveArchiveImportIdentity(req.body, String(req.body.name || 'meme_pack'));
    if (!identity.id || !identity.label) {
        return res.status(400).json({ success: false, error: '导入时需要有效的分组 id 和名称' });
    }

    try {
        const importedFiles = importArchiveImagesToPack(sourceDir, String(req.body.name || 'meme_pack'), decoded);
        const packs = manifest.packs || [];
        const existingPack = packs.find(item => item.id === identity.id);

        if (existingPack) {
            existingPack.label = String(req.body.label || existingPack.label).trim();
            existingPack.description = req.body.description === undefined
                ? String(existingPack.description || '')
                : String(req.body.description || '').trim();
            existingPack.aliases = normalizeStringArray(req.body.aliases ?? existingPack.aliases);
            existingPack.scenes = normalizeStringArray(req.body.scenes ?? existingPack.scenes);
            existingPack.weight = Math.max(1, Number(req.body.weight ?? existingPack.weight));
            existingPack.cooldownSec = Math.max(0, Number(req.body.cooldownSec ?? existingPack.cooldownSec));
            existingPack.files = Array.from(new Set([...existingPack.files, ...importedFiles]));
            writeMemeManifest(manifest);
            return res.json(await maybeSyncAgentAfterProfileMutation({
                success: true,
                importedFiles,
                importedCount: importedFiles.length,
                pack: serializeMemePack(existingPack),
            }, `压缩包已导入，新增 ${importedFiles.length} 张图片`));
        }

        const nextPack: MemePackAdminRecord = {
            id: identity.id,
            label: identity.label,
            description: identity.description,
            aliases: normalizeStringArray(req.body.aliases),
            scenes: normalizeStringArray(req.body.scenes),
            weight: Math.max(1, Number(req.body.weight || 1)),
            cooldownSec: Math.max(0, Number(req.body.cooldownSec || 60)),
            files: importedFiles,
        };
        manifest.packs = [...packs, nextPack];
        writeMemeManifest(manifest);
        return res.json(await maybeSyncAgentAfterProfileMutation({
            success: true,
            importedFiles,
            importedCount: importedFiles.length,
            pack: serializeMemePack(nextPack),
        }, `压缩包已导入并创建分组，共 ${importedFiles.length} 张图片`));
    } catch (e: unknown) {
        return res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.delete('/memes/:id/files/:name', async (req, res) => {
    const manifest = readMemeManifest();
    const packs = manifest.packs || [];
    const pack = packs.find(item => item.id === req.params.id);
    if (!pack) {
        return res.status(404).json({ success: false, error: '表情包分组不存在' });
    }

    const filename = path.basename(req.params.name);
    if (!pack.files.includes(filename)) {
        return res.status(404).json({ success: false, error: '图片不存在' });
    }

    pack.files = pack.files.filter(item => item !== filename);
    const sourceDir = resolveMemeSourceDir(manifest);
    const filePath = path.join(sourceDir, filename);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
    writeMemeManifest(manifest);
    res.json(await maybeSyncAgentAfterProfileMutation({
        success: true,
        file: filename,
        pack: serializeMemePack(pack),
    }, '表情图片已删除'));
});

resourcesRouter.get('/memes/orphans', async (_req, res) => {
    try {
        const manifest = readMemeManifest();
        const orphanFiles = getMemeOrphanFiles(manifest);
        res.json({
            success: true,
            sourceDir: resolveMemeSourceDir(manifest),
            orphanFiles,
        });
    } catch (e: unknown) {
        res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.post('/memes/cleanup-orphans', async (_req, res) => {
    try {
        const manifest = readMemeManifest();
        const sourceDir = resolveMemeSourceDir(manifest);
        const orphanFiles = getMemeOrphanFiles(manifest);
        for (const file of orphanFiles) {
            const targetPath = path.join(sourceDir, file);
            if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
            }
        }
        memeCatalog.invalidate();
        res.json(await maybeSyncAgentAfterProfileMutation({
            success: true,
            deletedFiles: orphanFiles,
            deletedCount: orphanFiles.length,
            ...buildMemeOverview(readMemeManifest()),
        }, orphanFiles.length > 0 ? `已清理 ${orphanFiles.length} 个孤儿文件` : '没有需要清理的孤儿文件'));
    } catch (e: unknown) {
        res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.get('/blacklist', (req, res) => {
    res.json(readAdapterFilterEntries());
});

resourcesRouter.post('/blacklist', async (req: Request<unknown, unknown, BlacklistRequest>, res: Response) => {
    const { type, targetId, reason, listType } = req.body;
    const normalizedType: AdapterFilterType = type === 'group' ? 'group' : 'user';
    const normalizedListType: AdapterFilterListType = listType === 'white' ? 'white' : 'black';
    const parsedTargetId = Number.parseInt(targetId, 10);
    if (!Number.isFinite(parsedTargetId) || parsedTargetId <= 0) {
        return res.status(400).json({ success: false, error: '目标 QQ/群号必须是正整数' });
    }

    try {
        const env = parseEnvFileSync(getAdapterEnvPath());
        const key = getAdapterFilterEnvKey(normalizedListType, normalizedType);
        const current = parseNumberArrayEnv(env[key]);
        const oppositeKey = getAdapterFilterEnvKey(normalizedListType === 'white' ? 'black' : 'white', normalizedType);
        const oppositeCurrent = parseNumberArrayEnv(env[oppositeKey]);
        if (oppositeCurrent.includes(parsedTargetId)) {
            return res.status(409).json({
                success: false,
                error: `该${normalizedType === 'group' ? '群组' : '用户'}已存在于${normalizedListType === 'white' ? '黑' : '白'}名单，请先移除冲突规则`,
            });
        }

        const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
        if (current.includes(parsedTargetId)) {
            const meta = readAdapterFilterMeta();
            const existingMetaIndex = meta.findIndex((item) => (
                item.listType === normalizedListType
                && item.type === normalizedType
                && item.targetId === parsedTargetId
            ));
            const updatedMeta = [...meta];
            if (trimmedReason) {
                if (existingMetaIndex >= 0) {
                    updatedMeta[existingMetaIndex] = {
                        ...updatedMeta[existingMetaIndex],
                        reason: trimmedReason,
                    };
                } else {
                    updatedMeta.push({
                        listType: normalizedListType,
                        type: normalizedType,
                        targetId: parsedTargetId,
                        reason: trimmedReason,
                        createdAt: new Date().toISOString(),
                    });
                }
            }
            if (trimmedReason && !writeAdapterFilterMeta(updatedMeta)) {
                return res.status(500).json({ success: false, error: '保存规则备注失败' });
            }
            const existingReason = updatedMeta.find(item => item.listType === normalizedListType && item.type === normalizedType && item.targetId === parsedTargetId)?.reason
                || getAdapterFilterReason(normalizedListType, normalizedType);
            return res.json({
                success: true,
                duplicate: true,
                entry: buildAdapterFilterEntry(normalizedListType, normalizedType, parsedTargetId, existingReason, env),
                message: trimmedReason ? '规则已存在，备注已更新' : '规则已存在',
            });
        }

        const next = [...current, parsedTargetId];
        const saved = persistAdapterFilterList(key, next);
        if (!saved) {
            return res.status(500).json({ success: false, error: '保存适配器过滤规则失败' });
        }

        const meta = readAdapterFilterMeta().filter((item) => !(item.listType === normalizedListType && item.type === normalizedType && item.targetId === parsedTargetId));
        meta.push({
            listType: normalizedListType,
            type: normalizedType,
            targetId: parsedTargetId,
            reason: trimmedReason || getAdapterFilterReason(normalizedListType, normalizedType),
            createdAt: new Date().toISOString(),
        });
        if (!writeAdapterFilterMeta(meta)) {
            if (!rollbackAdapterFilterList(key, current)) {
                return res.status(500).json({ success: false, error: '保存规则备注失败，且无法回滚过滤规则文件' });
            }
            return res.status(500).json({ success: false, error: '保存规则备注失败' });
        }

        log.info(`⛔ 更新适配器${normalizedListType === 'white' ? '白' : '黑'}名单: ${normalizedType} ${parsedTargetId}${reason ? ` (${reason})` : ''}`);
        const nextEnv = {
            ...env,
            [key]: next.join(','),
        };
        res.json(await maybeSyncAdapterAfterFilterMutation({
            success: true,
            entry: buildAdapterFilterEntry(
                normalizedListType,
                normalizedType,
                parsedTargetId,
                trimmedReason || getAdapterFilterReason(normalizedListType, normalizedType),
                nextEnv,
            ),
        }, `适配器${normalizedListType === 'white' ? '白' : '黑'}名单已更新`));
    } catch (e: unknown) {
        res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.delete('/blacklist/:id', async (req, res) => {
    const rawId = String(req.params.id || '').trim();
    const { listType } = req.query;
    const parsedRuleId = parseAdapterFilterRuleId(rawId);
    const normalizedListType: AdapterFilterListType = parsedRuleId?.listType || (listType === 'white' ? 'white' : 'black');
    const numericId = parsedRuleId ? null : parseInt(rawId, 10);
    if (!parsedRuleId && (!Number.isInteger(numericId) || Number(numericId) <= 0)) {
        return res.status(400).json({ success: false, error: '规则 ID 无效' });
    }

    try {
        const entries = readAdapterFilterEntries();
        const list = normalizedListType === 'white' ? entries.whitelist : entries.blacklist;
        const entry = parsedRuleId
            ? list.find((item) => item.ruleId === rawId)
            : list.find((item) => item.id === numericId);
        if (!entry) {
            return res.status(404).json({ success: false, error: '条目不存在' });
        }

        const env = parseEnvFileSync(getAdapterEnvPath());
        const key = getAdapterFilterEnvKey(normalizedListType, entry.type);
        const current = parseNumberArrayEnv(env[key]);
        const next = current.filter(item => item !== entry.targetId);
        const saved = persistAdapterFilterList(key, next);
        if (!saved) {
            return res.status(500).json({ success: false, error: '保存适配器过滤规则失败' });
        }

        const meta = readAdapterFilterMeta().filter((item) => !(
            item.listType === normalizedListType
            && item.type === entry.type
            && item.targetId === entry.targetId
        ));
        if (!writeAdapterFilterMeta(meta)) {
            if (!rollbackAdapterFilterList(key, current)) {
                return res.status(500).json({ success: false, error: '保存规则备注失败，且无法回滚过滤规则文件' });
            }
            return res.status(500).json({ success: false, error: '保存规则备注失败' });
        }

        res.json(await maybeSyncAdapterAfterFilterMutation(
            { success: true, entry },
            `适配器${normalizedListType === 'white' ? '白' : '黑'}名单已更新`,
        ));
    } catch (e: unknown) {
        res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
});

// Database Management
resourcesRouter.get('/database/export', (req, res) => {
    try {
        const profiles = getAllProfiles();
        res.setHeader('Content-Disposition', 'attachment; filename=profiles.json');
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(profiles, null, 2));
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

resourcesRouter.get('/database/stats', (req, res) => {
    try {
        const profiles = getAllProfiles();
        const filterEntries = readAdapterFilterEntries();
        res.json({
            profileCount: profiles.length,
            blacklistCount: filterEntries.blacklist.length,
            whitelistCount: filterEntries.whitelist.length,
        });
    } catch (e: unknown) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
});

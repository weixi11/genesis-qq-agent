import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { log } from '../logger.js';
import { resolveFileForSend } from '../utils/file.js';
import type { MessageSegment } from '../utils/message.js';
import { isRecord, safeParseJson } from '../utils/json.js';

export interface MemePackDefinition {
    id: string;
    label: string;
    description?: string;
    aliases: string[];
    scenes: string[];
    weight: number;
    cooldownSec: number;
    files: string[];
}

interface MemeManifest {
    version?: string;
    sourceDir?: string;
    packs?: MemePackDefinition[];
}

function parseManifest(raw: string): MemeManifest | null {
    const parsed = safeParseJson(raw);
    return isRecord(parsed) ? parsed as MemeManifest : null;
}

export interface ResolvedMemePack extends MemePackDefinition {
    sourceDir: string;
    resolvedFiles: string[];
}

class MemeCatalogService {
    private cache: ResolvedMemePack[] | null = null;
    private cacheAt = 0;
    private readonly CACHE_TTL_MS = 5000;

    private resolveManifestPath(): string {
        const manifestPath = config.autoMeme.manifestPath;
        return path.isAbsolute(manifestPath) ? manifestPath : path.join(process.cwd(), manifestPath);
    }

    private loadPacks(): ResolvedMemePack[] {
        const manifestPath = this.resolveManifestPath();
        if (!fs.existsSync(manifestPath)) {
            log.warn(`🎭 表情包 manifest 不存在: ${manifestPath}`);
            return [];
        }

        try {
            const raw = fs.readFileSync(manifestPath, 'utf-8');
            const parsed = parseManifest(raw);
            if (!parsed) {
                log.warn('🎭 表情包 manifest 结构无效，已回退为空列表');
                return [];
            }
            const manifestDir = path.dirname(manifestPath);
            const defaultSourceDir = path.isAbsolute(config.autoMeme.sourceDir)
                ? config.autoMeme.sourceDir
                : path.join(process.cwd(), config.autoMeme.sourceDir);
            const sourceDir = parsed.sourceDir
                ? (path.isAbsolute(parsed.sourceDir) ? parsed.sourceDir : path.join(manifestDir, parsed.sourceDir))
                : defaultSourceDir;

            const packs = Array.isArray(parsed.packs) ? parsed.packs : [];
            return packs.map(pack => {
                const resolvedFiles = (Array.isArray(pack.files) ? pack.files : [])
                    .map(file => path.join(sourceDir, file))
                    .filter(file => fs.existsSync(file));

                return {
                    id: pack.id,
                    label: pack.label,
                    description: typeof pack.description === 'string' ? pack.description : '',
                    aliases: Array.isArray(pack.aliases) ? pack.aliases : [],
                    scenes: Array.isArray(pack.scenes) ? pack.scenes : [],
                    weight: Number.isFinite(pack.weight) ? pack.weight : 1,
                    cooldownSec: Number.isFinite(pack.cooldownSec) ? pack.cooldownSec : 60,
                    files: Array.isArray(pack.files) ? pack.files : [],
                    sourceDir,
                    resolvedFiles,
                };
            }).filter(pack => pack.id && pack.label && pack.resolvedFiles.length > 0);
        } catch (error) {
            log.error('🎭 读取表情包 manifest 失败:', error);
            return [];
        }
    }

    private ensureCache(): ResolvedMemePack[] {
        const now = Date.now();
        if (!this.cache || now - this.cacheAt > this.CACHE_TTL_MS) {
            this.cache = this.loadPacks();
            this.cacheAt = now;
        }
        return this.cache;
    }

    listPacks(): ResolvedMemePack[] {
        return this.ensureCache();
    }

    findPackByQuery(query?: string): ResolvedMemePack | null {
        const normalized = String(query || '').trim().toLowerCase();
        if (!normalized) return null;

        const packs = this.ensureCache();
        return packs.find(pack => {
            const keywords = [pack.id, pack.label, ...pack.aliases, ...pack.scenes]
                .map(item => item.toLowerCase());
            return keywords.some(keyword => normalized === keyword || normalized.includes(keyword) || keyword.includes(normalized));
        }) || null;
    }

    findPacksByScene(scene: string): ResolvedMemePack[] {
        const normalized = scene.trim().toLowerCase();
        if (!normalized) return [];
        return this.ensureCache().filter(pack => pack.scenes.some(item => item.toLowerCase() === normalized));
    }

    pickRandomPack(packs: ResolvedMemePack[]): ResolvedMemePack | null {
        if (packs.length === 0) return null;
        const totalWeight = packs.reduce((sum, pack) => sum + Math.max(1, pack.weight), 0);
        let random = Math.random() * totalWeight;
        for (const pack of packs) {
            random -= Math.max(1, pack.weight);
            if (random <= 0) {
                return pack;
            }
        }
        return packs[0];
    }

    pickFiles(pack: ResolvedMemePack, count: number, exclude: string[] = []): string[] {
        const excluded = new Set(exclude);
        const preferred = pack.resolvedFiles.filter(file => !excluded.has(file));
        const pool = preferred.length > 0 ? preferred : pack.resolvedFiles;
        const shuffled = [...pool];

        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        return shuffled.slice(0, Math.min(Math.max(1, count), shuffled.length));
    }

    buildSegments(files: string[]): MessageSegment[] {
        return files.map(file => ({
            type: 'image',
            data: { file: resolveFileForSend(file) },
        }));
    }

    invalidate(): void {
        this.cache = null;
        this.cacheAt = 0;
    }
}

export const memeCatalog = new MemeCatalogService();

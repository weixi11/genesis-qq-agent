/**
 * Music 模块 - 网易云点歌
 */

import { log } from '../../logger.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Module, ModuleContext, ModuleResult } from '../types.js';

// ==================== 类型定义 ====================

interface MusicInfo {
    id: number;
    name: string;
    artists: string;
    alias: string;
    picUrl?: string;
}

// ==================== 模块元数据 ====================

export const name = 'music';
export const description = '网易云点歌';
export const keywords = ['点歌', '来首', '播放', '听歌', '分享音乐'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 内部函数 ====================

async function searchMusic(keyword: string, limit = 5): Promise<MusicInfo[]> {
    try {
        const url = `http://music.163.com/api/search/get/web?s=${encodeURIComponent(keyword)}&type=1&offset=0&total=true&limit=${limit}`;

        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json() as Record<string, unknown>;
        const result = data?.result as { songs?: Array<Record<string, unknown>> } | undefined;
        const songs = result?.songs || [];

        return songs.map((s) => ({
            id: s.id as number,
            name: s.name as string,
            artists: Array.isArray(s.artists)
                ? s.artists.map((a: Record<string, unknown>) => a?.name).filter(Boolean).join('/')
                : '',
            alias: Array.isArray(s.alias) && s.alias.length ? s.alias.join(',') : '',
            picUrl: (s.album as Record<string, unknown>)?.picUrl as string ||
                (s.artists as Array<Record<string, unknown>>)?.[0]?.img1v1Url as string || '',
        }));
    } catch (err) {
        log.error('网易云搜索失败:', err);
        return [];
    }
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    _ctx: ModuleContext
): Promise<ModuleResult> {
    // 兼容 Router 可能传递 keywords（复数）的情况
    const keyword = ((params.keyword || params.keywords) as string)?.trim();
    const index = ((params.index as number) || 1) - 1;

    if (!keyword) {
        return { success: false, text: '想听什么歌呀？请告诉我歌名或歌手喵~' };
    }

    try {
        log.info(`🔧 模块: 搜索音乐 "${keyword}"`);

        const songs = await searchMusic(keyword);

        if (songs.length === 0) {
            return { success: false, text: `找不到关于 "${keyword}" 的歌曲呢，换个关键词试试？` };
        }

        const safeIndex = Math.max(0, Math.min(songs.length - 1, index));
        const song = songs[safeIndex];

        const songDesc = `🎵 ${song.name} - ${song.artists}`;

        return {
            success: true,
            text: `已为您点歌: ${songDesc}`,
            // 统一消息段格式
            segments: [{ type: 'music', data: { type: '163', id: String(song.id) } }],
            data: {
                song,
                list: songs,
                message: `已为您点歌: ${songDesc}`,
            },
        };
    } catch (err) {
        log.error('点歌失败:', err);
        const errMsg = err instanceof Error ? err.message : String(err);
        return { success: false, text: `点歌失败了喵: ${errMsg}` };
    }
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Module;

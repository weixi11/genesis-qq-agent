/**
 * Media Extraction Utilities
 * Handles extracting media paths from messages and history.
 */

import type { FormattedMessage } from '../types.js';

/**
 * Validates if a file extension matches a category
 */
export const FileExtensions = {
    IMAGE: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'],
    VIDEO: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp'],
    AUDIO: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'amr', 'silk'],
    DOC: ['docx', 'doc', 'xlsx', 'xls', 'txt', 'md', 'py', 'js', 'ts', 'json', 'csv', 'xml'],
    PDF: ['pdf'],
};

export function isFileType(filename: string, types: string[]): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return types.includes(ext);
}

/**
 * Extract image paths from a message
 */
export function extractImages(message: FormattedMessage): string[] {
    const images: string[] = [];

    // 1. Main message images
    if (message.images?.length) {
        for (const img of message.images) {
            // Check if it's a string or object (based on runtime reality vs types)
            if (typeof img === 'string') {
                images.push(img);
            } else if (img && typeof img === 'object') {
                const imgObj = img as { path?: string; file?: string; url?: string };
                const url = imgObj.path || imgObj.file || imgObj.url;
                if (url) images.push(url);
            }
        }
    }

    // 2. Reply images
    if (images.length === 0 && message.reply?.media?.images?.length) {
        message.reply.media.images.forEach(img => {
            const url = img.path || img.file || img.url;
            if (url) images.push(url);
        });
    }

    // 3. Images in files
    if (images.length === 0 && message.files?.length) {
        for (const f of message.files) {
            if (f) {
                const path = f.path || f.url || '';
                const name = f.name || path;
                if (path && isFileType(name, FileExtensions.IMAGE)) {
                    images.push(path);
                }
            }
        }
    }

    return images;
}

/**
 * Extract video paths from a message
 */
export function extractVideos(message: FormattedMessage): string[] {
    const videos: string[] = [];

    // 1. Main message videos
    if (message.videos?.length) {
        for (const v of message.videos) {
            if (typeof v === 'string') videos.push(v);
            else if (v && typeof v === 'object') {
                const vPath = v.path || v.file || v.url;
                if (vPath) videos.push(vPath);
            }
        }
    }

    // 2. Reply videos
    if (videos.length === 0 && message.reply?.media?.videos?.length) {
        message.reply.media.videos.forEach(v => {
            const vPath = v.path || v.file || v.url;
            if (vPath) videos.push(vPath);
        });
    }

    // 3. Videos in files
    if (videos.length === 0 && message.files?.length) {
        for (const f of message.files) {
            if (f) {
                const path = f.path || f.url || '';
                const name = f.name || path;
                if (path && isFileType(name, FileExtensions.VIDEO)) {
                    videos.push(path);
                }
            }
        }
    }

    return videos;
}

/**
 * Extract audio paths from a message
 */
export function extractAudios(message: FormattedMessage): string[] {
    const audios: string[] = [];

    // 1. Main message records
    if (message.records?.length) {
        for (const r of message.records) {
            if (typeof r === 'string') audios.push(r);
            else if (r && typeof r === 'object') {
                const rPath = r.path || r.file || r.url;
                if (rPath) audios.push(rPath);
            }
        }
    }

    // 2. Reply records
    if (audios.length === 0 && message.reply?.media?.records?.length) {
        message.reply.media.records.forEach(r => {
            const rPath = r.path || r.file || r.url;
            if (rPath) audios.push(rPath);
        });
    }

    // 3. Audios in files
    if (audios.length === 0 && message.files?.length) {
        for (const f of message.files) {
            if (f) {
                const path = f.path || f.url || '';
                const name = f.name || path;
                if (path && isFileType(name, FileExtensions.AUDIO)) {
                    audios.push(path);
                }
            }
        }
    }

    return audios;
}

/**
 * Extract generic file paths from a message
 */
export function extractFiles(message: FormattedMessage): string[] {
    const files: string[] = [];

    // 1. Main message files
    if (message.files?.length) {
        for (const f of message.files) {
            if (typeof f === 'string') files.push(f);
            else if (f && typeof f === 'object') {
                const file = f as { path?: string; file?: string; url?: string };
                const fPath = file.path || file.file || file.url || '';
                if (fPath) files.push(fPath);
            }
        }
    }

    // 2. Reply files
    if (files.length === 0 && message.reply?.media?.files?.length) {
        message.reply.media.files.forEach(f => {
            const file = f as { path?: string; file?: string; url?: string };
            const fPath = file.path || file.file || file.url || '';
            if (fPath) files.push(fPath);
        });
    }

    return files;
}

// === History Extraction ===

export interface MediaItem {
    path: string;
    senderId: number;
}

export function extractHistoryImages(history: FormattedMessage[], senderIdFilter?: number, index: number = 1): string | null {
    if (!history?.length) return null;

    const allItems: MediaItem[] = [];

    // Traverse backwards (latest first)
    for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        const imgs = extractImages(msg);
        for (const img of imgs) {
            allItems.push({ path: img, senderId: msg.sender_id });
        }
    }

    let filtered = allItems;
    if (senderIdFilter) {
        filtered = allItems.filter(item => item.senderId === senderIdFilter);
    }

    const tIdx = Math.max(0, Math.min(index - 1, filtered.length - 1));
    return filtered.length > 0 ? filtered[tIdx].path : null;
}

export function extractHistoryVideos(history: FormattedMessage[], senderIdFilter?: number, index: number = 1): string | null {
    if (!history?.length) return null;

    const allItems: MediaItem[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        const vids = extractVideos(msg);
        for (const v of vids) {
            allItems.push({ path: v, senderId: msg.sender_id });
        }
    }

    let filtered = allItems;
    if (senderIdFilter) {
        filtered = allItems.filter(item => item.senderId === senderIdFilter);
    }

    const tIdx = Math.max(0, Math.min(index - 1, filtered.length - 1));
    return filtered.length > 0 ? filtered[tIdx].path : null;
}

export function extractHistoryAudios(history: FormattedMessage[], senderIdFilter?: number, index: number = 1): string | null {
    if (!history?.length) return null;

    const allItems: MediaItem[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        const audios = extractAudios(msg);
        for (const a of audios) {
            allItems.push({ path: a, senderId: msg.sender_id });
        }
    }

    let filtered = allItems;
    if (senderIdFilter) {
        filtered = allItems.filter(item => item.senderId === senderIdFilter);
    }

    const tIdx = Math.max(0, Math.min(index - 1, filtered.length - 1));
    return filtered.length > 0 ? filtered[tIdx].path : null;
}

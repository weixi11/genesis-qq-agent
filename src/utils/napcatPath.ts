import * as fs from 'fs';
import * as path from 'path';

function resolveCandidate(rawPath: string): string {
    return path.resolve(process.cwd(), rawPath);
}

export function getNapcatCacheDir(): string {
    const configured = process.env.NAPCAT_CACHE_DIR?.trim();
    const candidates = [
        configured,
        '../genesis-napcat-adapter/cache/file',
        '../napcat/cache/file',
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
        const resolved = resolveCandidate(candidate);
        if (fs.existsSync(resolved)) {
            return resolved;
        }
    }

    return resolveCandidate(candidates[0] || '../genesis-napcat-adapter/cache/file');
}

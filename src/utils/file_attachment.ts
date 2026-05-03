export interface FileAttachment {
    /** 本机绝对路径，必须是 NapCat 可读取的路径 */
    path: string;
    /** 发送到 QQ 时显示的文件名；留空则使用 path basename */
    name?: string;
}

export function normalizeFileAttachments(value: unknown): FileAttachment[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const files: FileAttachment[] = [];
    for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
            files.push({ path: item.trim() });
            continue;
        }

        if (!item || typeof item !== 'object') {
            continue;
        }

        const record = item as Record<string, unknown>;
        const rawPath = record.path ?? record.file ?? record.localPath;
        if (typeof rawPath !== 'string' || !rawPath.trim()) {
            continue;
        }

        const rawName = record.name ?? record.fileName ?? record.filename;
        files.push({
            path: rawPath.trim(),
            name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined,
        });
    }

    return files;
}

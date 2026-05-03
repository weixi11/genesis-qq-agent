interface TaskCacheScopeInput {
    sessionKey: string;
    replyMessageId?: number | null;
    atUsers?: number[];
    imageUrls?: string[];
    videoPaths?: string[];
    audioPaths?: string[];
    filePaths?: string[];
}

export function buildTaskCacheScope(input: TaskCacheScopeInput): string {
    return JSON.stringify({
        session: input.sessionKey,
        replyMessageId: input.replyMessageId ?? null,
        atUsers: [...(input.atUsers || [])].sort((a, b) => a - b),
        images: [...(input.imageUrls || [])],
        videos: [...(input.videoPaths || [])],
        audios: [...(input.audioPaths || [])],
        files: [...(input.filePaths || [])],
    });
}

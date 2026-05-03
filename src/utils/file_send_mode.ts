export type FileSendMode = 'auto' | 'base64' | 'local';
export type ImageToolSendMode = 'url' | 'base64' | 'local';

export function normalizeFileSendMode(value: string | undefined): FileSendMode | null {
    const mode = value?.trim().toLowerCase();
    if (mode === 'auto' || mode === 'base64' || mode === 'local') {
        return mode;
    }
    return null;
}

export function normalizeImageToolSendMode(value: string | undefined): ImageToolSendMode | null {
    const mode = value?.trim().toLowerCase();
    if (mode === 'url' || mode === 'base64' || mode === 'local') {
        return mode;
    }
    return null;
}

export function getGlobalFileSendMode(envValue: string | undefined = process.env.FILE_SEND_MODE): FileSendMode {
    return normalizeFileSendMode(envValue) || 'auto';
}

export function resolveImageToolSendMode(
    overrideValue: string | undefined,
    globalValue: string | undefined = process.env.FILE_SEND_MODE,
): ImageToolSendMode {
    const overrideMode = normalizeImageToolSendMode(overrideValue);
    if (overrideMode) {
        return overrideMode;
    }

    // 工具未显式覆盖时，跟随全局文件发送模式，统一走“先落本地再按全局发送”的链路。
    if (normalizeFileSendMode(globalValue)) {
        return 'local';
    }

    return 'url';
}

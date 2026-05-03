export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_MEME_SEND_ENABLED?.toLowerCase();
        return envEnabled !== 'false' && envEnabled !== '0';
    })(),

    timeoutMs: parseInt(process.env.MEME_SEND_TIMEOUT_MS || '5000', 10),
    concurrency: parseInt(process.env.MEME_SEND_CONCURRENCY || '5', 10),
};

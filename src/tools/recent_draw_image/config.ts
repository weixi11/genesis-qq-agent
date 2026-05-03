export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_RECENT_DRAW_IMAGE_ENABLED?.toLowerCase();
        return envEnabled !== 'false' && envEnabled !== '0';
    })(),

    timeoutMs: parseInt(process.env.RECENT_DRAW_IMAGE_TIMEOUT_MS || '10000', 10),
    concurrency: parseInt(process.env.RECENT_DRAW_IMAGE_CONCURRENCY || '5', 10),
    maxCount: parseInt(process.env.RECENT_DRAW_IMAGE_MAX_COUNT || '5', 10),
    drawDir: process.env.RECENT_DRAW_IMAGE_DRAW_DIR || 'data/images',
    bananaDir: process.env.RECENT_DRAW_IMAGE_BANANA_DIR || 'data/images/banana_draw',
} as const;

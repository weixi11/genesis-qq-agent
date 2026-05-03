import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'chrome_screenshot',
    description: '使用 Chrome/Chromium 无头模式打开网页并截图，适合截取网页、控制台页面、后台面板、活动页和移动端页面效果。',
    parameters: {
        type: 'object',
        properties: {
            url: {
                type: 'string',
                description: '要截图的网页 URL。优先传完整的 http:// 或 https:// 地址。',
            },
            device: {
                type: 'string',
                enum: ['desktop', 'mobile'],
                description: '截图设备类型。desktop 为桌面视口，mobile 为手机视口。',
                default: 'desktop',
            },
            waitMs: {
                type: 'integer',
                description: '打开页面后额外等待的毫秒数，用于等待异步内容加载完成。建议 0 到 10000。',
                default: 1500,
            },
            width: {
                type: 'integer',
                description: '可选，自定义截图宽度像素。',
            },
            height: {
                type: 'integer',
                description: '可选，自定义截图高度像素。',
            },
        },
        required: ['url'],
    },
};

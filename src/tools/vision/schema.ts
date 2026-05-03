import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'vision',
    description: '识别图片或PDF文件内容。支持格式：.jpg, .jpeg, .png, .gif, .webp, .bmp, .pdf。当消息包含图片或PDF文件时调用此工具。（注意：此工具无法准确识别人物身份。如果用户要“识别图片里的二次元/动漫/游戏角色是谁/出处”，请务必使用专门的 anime_trace 工具，不要使用本工具分析角色身份！）',
    parameters: {
        type: 'object',
        properties: {
            question: { type: 'string', description: '关于图片/PDF的问题（可选，不填则描述图片内容）' },
            imageIndex: { type: 'integer', description: '指定查看第几张图片（1=最近的，2=倒数第二张）' },
            imagePath: { type: 'string', description: '图片或PDF的本地绝对路径。从会话媒体记录中获取。' },
            imageUrl: { type: 'string', description: '图片的 URL 地址（http/https开头）。如果前序步骤返回了网络图片链接，请填入此参数。' },
            senderId: { type: 'integer', description: '只查看该用户发送的图片。从对话历史中获取用户QQ号。' },
        },
        required: [],
    },
};

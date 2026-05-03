import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'banana_draw',
    description: '高级 Banana 绘图工具。支持普通文生图、带图改图、图生图、手办化、四格漫画、自拍化等场景。',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: '可选的补充提示词。预设模式下可以留空。' },
            mode: {
                type: 'string',
                description: '绘图模式：auto/generate/edit/figurine/comic/selfie',
                enum: ['auto', 'generate', 'edit', 'figurine', 'comic', 'selfie'],
            },
            size: { type: 'string', description: '输出尺寸，如 "1024x1024" 或 "1024x1536"' },
            preserveIdentity: { type: 'boolean', description: '是否尽量保留人物身份与核心外观。人物改图时建议为 true。' },
            selfReference: { type: 'boolean', description: '当用户要求画机器人自己/落落/自画像时传 true，执行前会注入当前人设外貌锚点。' },
            personaPromptResolved: { type: 'boolean', description: '内部字段：自画像 prompt 已经被上游改写成最终英文提示词时为 true。' },
            imageUrl: { type: 'string', description: '单张输入图片 URL 或本地路径，可选。' },
            imageUrls: { type: 'array', description: '多张输入图片 URL 或本地路径，可选。', items: { type: 'string' } },
        },
        required: [],
    },
};

import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'draw',
    description: 'AI 绘图。当用户请求画图、生成图片时调用。prompt 优先使用英文标签或简洁英文短语；如果是画机器人自己，传 selfReference=true，让工具自动注入当前人设外貌锚点。',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: '绘图提示词。优先写英文标签/英文短语，保留角色外貌、动作、场景、镜头、风格等关键锚点。' },
            size: { type: 'string', description: '要求的图片比例或尺寸，如 "1920x1080", "1024x1024"' },
        },
        required: ['prompt'],
    },
};

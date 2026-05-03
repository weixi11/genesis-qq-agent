import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'anime_trace',
    description: '识别动漫、Galgame、二次元游戏图片中的角色身份和出处。当用户想知道图片中的动漫/游戏角色是谁、来自哪部作品时调用此工具。比通用识图更准确。',
    parameters: {
        type: 'object',
        properties: {
            model: {
                type: 'string',
                enum: ['anime', 'anime_model_lovelive', 'pre_stable', 'full_game_model_kira', 'animetrace_high_beta'],
                description: '识别模型。anime=通用动漫, full_game_model_kira=Galgame/二次元游戏, pre_stable=预稳定版, animetrace_high_beta=高精度Beta',
            },
            mode: {
                type: 'string',
                enum: ['anime', 'game'],
                description: '快捷模式：anime=动漫角色识别, game=Galgame/二次元游戏角色识别',
            },
        },
        required: [],
    },
};

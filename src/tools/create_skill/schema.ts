import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'create_skill',
    description: '为Bot创建新的技能工具。当主人要求Bot"给自己写一个xxx工具"、"创建一个xxx技能"、"添加xxx功能"时调用。仅主人可用。',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: '工具名称（英文小写+下划线，如 dice_roll, translate, random_pick）',
            },
            description: {
                type: 'string',
                description: '工具的功能描述，越详细越好。包括：工具做什么、接受哪些参数、返回什么结果',
            },
        },
        required: ['name', 'description'],
    },
};

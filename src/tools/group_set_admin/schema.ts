
import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'group_set_admin',
    description: '设置或取消群管理员。主人或群主可以操作，普通管理员和群员不能任免管理员。',
    parameters: {
        type: 'object',
        properties: {
            user_id: {
                type: 'integer',
                description: '目标用户QQ号',
            },
            enable: {
                type: 'boolean',
                description: 'true为设置管理员，false为取消管理员',
            },
        },
        required: ['user_id', 'enable'],
    },
};

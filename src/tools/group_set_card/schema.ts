
import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'group_set_card',
    description: '修改群昵称（群名片）。默认修改机器人的群昵称，也可以指定用户修改；修改他人或机器人群名片时需要管理员及以上权限。',
    parameters: {
        type: 'object',
        properties: {
            card: {
                type: 'string',
                description: '新的群昵称',
            },
            user_id: {
                type: 'integer',
                description: '目标用户QQ号（可选，默认为机器人自己）',
            },
        },
        required: ['card'],
    },
};


import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'group_set_name',
    description: '修改当前群名称。主人/群主/管理员可以操作，普通群员不能改群名。',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: '新的群名称',
            },
        },
        required: ['name'],
    },
};

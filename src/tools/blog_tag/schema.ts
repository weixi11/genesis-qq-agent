/**
 * Blog Tag 模块 Schema
 *
 * 用于 LLM Function Calling
 */

import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'blog_tag',
    description: '博客标签管理工具。可以查看标签列表、创建标签、修改标签、删除标签。发布文章前需要先获取或创建标签。',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'create', 'update', 'delete', 'search', 'get'],
                description: '操作类型：list=标签列表, create=创建标签, update=修改标签, delete=删除标签, search=搜索标签, get=根据ID查询标签',
            },
            id: {
                type: 'integer',
                description: '标签ID（get/update/delete 时需要）',
            },
            tag_name: {
                type: 'string',
                description: '标签名称（create/update/search 时使用）',
            },
        },
        required: ['action'],
    },
};

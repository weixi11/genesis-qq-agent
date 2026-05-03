/**
 * Blog Article 模块 Schema
 *
 * 用于 LLM Function Calling
 */

import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'blog_article',
    description: '博客文章管理工具。可以发布文章、查看文章列表、查看文章详情、搜索文章、删除文章、修改文章状态、置顶文章、上传封面图片、上传文章内图片。当用户要求管理博客文章时调用。',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['publish', 'list', 'detail', 'search', 'delete', 'update_status', 'toggle_top', 'upload_cover', 'upload_image', 'delete_cover'],
                description: '操作类型：publish=发布文章, list=文章列表, detail=文章详情, search=搜索文章, delete=删除文章, update_status=修改状态, toggle_top=置顶/取消置顶, upload_cover=上传封面图, upload_image=上传文章内图片, delete_cover=删除封面图',
            },
            id: {
                type: 'integer',
                description: '文章ID（detail/delete/update_status/toggle_top/upload_image/upload_cover 时需要/可选）',
            },
            title: {
                type: 'string',
                description: '文章标题（publish/search 时使用）',
            },
            content: {
                type: 'string',
                description: '文章正文内容，支持Markdown（publish 时需要）',
            },
            category_id: {
                type: 'integer',
                description: '分类ID（publish 时需要）',
            },
            tag_ids: {
                type: 'array',
                description: '标签ID数组（publish 时需要）',
                items: { type: 'integer' },
            },
            cover: {
                type: 'string',
                description: '文章封面图URL（publish 时可选）',
            },
            article_type: {
                type: 'integer',
                description: '文章类型：1=原创, 2=转载, 3=翻译（publish 时可选，默认1）',
            },
            status: {
                type: 'integer',
                description: '文章状态：1=已发布, 2=私密, 3=草稿（publish/update_status 时使用）',
            },
            is_top: {
                type: 'integer',
                description: '是否置顶：0=否, 1=是（toggle_top 时使用）',
            },
            file_path: {
                type: 'string',
                description: '本地文件路径（upload_cover/upload_image 时使用，从消息中接收的文件路径）',
            },
            image_url: {
                type: 'string',
                description: '图片URL（upload_cover/upload_image 时使用，从消息中接收的图片URL）',
            },
            cover_url: {
                type: 'string',
                description: '封面图URL（delete_cover 时需要，要删除的封面图地址）',
            },
            page: {
                type: 'integer',
                description: '页码（list 时可选，默认1）',
            },
            page_size: {
                type: 'integer',
                description: '每页数量（list 时可选，默认10）',
            },
        },
        required: ['action'],
    },
};

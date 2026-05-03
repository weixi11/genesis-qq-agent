/**
 * search_web 模块 Schema
 *
 * 用于 LLM Function Calling
 */

import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'search_web',
    description: '联网搜索与网页内容提取。支持两种模式：\n1. search (默认): 当用户询问实时信息、新闻、汇率、天气或需要查资料时\n2. extract: 当用户提供了一个或多个网页链接 (URL) 让你阅读/总结其正文内容时',
    parameters: {
        type: 'object',
        properties: {
            mode: {
                type: 'string',
                enum: ['search', 'extract'],
                description: '工作模式。需要搜索时用 search，需要阅读/提取特定网页链接正文时用 extract。默认为 search。',
            },
            query: {
                type: 'string',
                description: '【仅 search 模式需要】搜索关键词，应简洁精确，如"2026年NBA总决赛结果"、"今日人民币美元汇率"',
            },
            urls: {
                type: 'array',
                items: { type: 'string' },
                description: '【仅 extract 模式需要】需要提取网页正文的 URL 列表',
            }
        },
        required: [],
    },
};

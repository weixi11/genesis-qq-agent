import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
    name: 'web_research',
    description: '深度联网搜索、网页正文提取与自动研究。适合让 Bot 实时获取在线信息，并从多个网页中提炼出关键结论、重点和来源。',
    parameters: {
        type: 'object',
        properties: {
            mode: {
                type: 'string',
                enum: ['research', 'search', 'extract'],
                description: '工作模式。research=先搜索再自动深读多个网页并提炼重点；search=仅搜索并返回结构化结果；extract=只读取指定链接正文。默认 research。',
            },
            query: {
                type: 'string',
                description: '【research/search 模式需要】要搜索的问题或关键词，例如"Claude Code 最新更新"、"今日黄金价格"。',
            },
            objective: {
                type: 'string',
                description: '【research 模式可选】这次搜索最关注什么，例如"重点看价格、发布时间、主要变化"。',
            },
            max_results: {
                type: 'integer',
                description: '【research/search 模式可选】搜索结果数量上限，通常 3-8。',
            },
            max_extract: {
                type: 'integer',
                description: '【research 模式可选】自动深读的网页数量上限，通常 2-4。',
            },
            urls: {
                type: 'array',
                items: { type: 'string' },
                description: '【extract 模式需要】需要提取正文的 URL 列表。',
            },
        },
        required: [],
    },
};

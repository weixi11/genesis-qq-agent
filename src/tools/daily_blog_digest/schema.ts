import type { ModuleSchema } from '../types.js';

export const schema: ModuleSchema = {
    name: 'daily_blog_digest',
    description: '自动生成并发布一篇中文博客日报：按时间段选题（或使用 topic_hint）、优先联网检索当天信息、在无搜索结果时自动降级为离线主题稿、补齐封面图、检查/创建分类与标签并发布到博客，返回发布详情。若 topic_hint 是一整段长写作指令，系统会自动提取安全主题，避免把整段提示词直接用于搜索、标题和封面 URL。',
    parameters: {
        type: 'object',
        properties: {
            topic_hint: { type: 'string', description: '主题提示，可覆盖系统自动选题；建议写简短主题名，如“GitHub 开源项目推荐”，不要直接塞整段长提示词' },
            category_name: { type: 'string', description: '博客分类名，默认落落日报' },
            tag_names: {
                type: 'array',
                description: '标签名列表，如 ["AI", "科技"]',
                items: { type: 'string' },
            },
            status: { type: 'integer', description: '发布状态，默认 1（发布）' },
            require_cover: { type: 'boolean', description: '是否强制包含封面图，默认 true' },
            allow_empty_sources: { type: 'boolean', description: '是否允许在没有检索到公开资料时仍然继续发布，默认 true；设为 false 时会在检索失败/无结果时取消发布' },
            signature: { type: 'string', description: '文章末尾署名，默认 作者：落落（Luoluo）' },
            style: { type: 'string', description: '文风/体裁，默认 新闻简报/轻评论' },
            writing_requirements: { type: 'string', description: '可选的补充写作要求；需要详细约束时放这里，不要塞进 topic_hint' },
        },
        required: [],
    },
};

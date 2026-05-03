/**
 * 预定义的工具链模式
 * 
 * 用于快速匹配常见的多工具场景
 */

import type { ToolNode, ExecutionMode } from './types.js';

/** 工具链模式定义 */
export interface ToolChainPattern {
    /** 模式ID */
    id: string;
    /** 模式描述 */
    description: string;
    /** 触发关键词 */
    keywords: string[];
    /** 触发正则 */
    patterns: RegExp[];
    /** 所需工具 */
    requiredTools: string[];
    /** 节点模板 */
    nodes: ToolNode[];
    /** 执行模式 */
    mode: ExecutionMode;
}

/** 预定义的工具链模式 */
export const TOOL_CHAIN_PATTERNS: ToolChainPattern[] = [
    {
        id: 'vision_then_draw',
        description: '看图再画类似的',
        keywords: ['看', '图', '再', '画', '类似'],
        patterns: [
            /看.*图.*再.*画/,
            /识别.*然后.*画/,
            /这.*图.*画.*类似/,
            /分析.*图.*生成/,
        ],
        requiredTools: ['vision', 'draw'],
        nodes: [
            {
                id: 'step1_vision',
                toolName: 'vision',
                params: { question: '详细描述这张图片的内容、风格、色调' },
                dependsOn: [],
            },
            {
                id: 'step2_draw',
                toolName: 'draw',
                params: {
                    prompt: '${step1_vision.text}',
                    useVisionOutput: true,
                },
                dependsOn: ['step1_vision'],
            },
        ],
        mode: 'sequential',
    },
    {
        id: 'multi_city_weather',
        description: '多城市天气查询',
        keywords: ['和', '跟', '以及', '天气'],
        patterns: [
            /(.+)(和|跟|以及|还有)(.+)天气/,
            /天气.*(和|跟|以及)/,
            /查.*多个.*天气/,
        ],
        requiredTools: ['weather'],
        nodes: [
            {
                id: 'city1',
                toolName: 'weather',
                params: { city: '${cities[0]}' },
                dependsOn: [],
            },
            {
                id: 'city2',
                toolName: 'weather',
                params: { city: '${cities[1]}' },
                dependsOn: [],
            },
        ],
        mode: 'parallel',
    },
    {
        id: 'video_then_summarize',
        description: '视频内容总结',
        keywords: ['视频', '总结', '概括', '讲了什么'],
        patterns: [
            /视频.*(总结|概括|讲)/,
            /(总结|概括).*视频/,
        ],
        requiredTools: ['read_video'],
        nodes: [
            {
                id: 'step1_video',
                toolName: 'read_video',
                params: { question: '总结视频的主要内容' },
                dependsOn: [],
            },
        ],
        mode: 'sequential',
    },
];

/**
 * 匹配工具链模式
 */
export function matchToolChainPattern(
    text: string,
    availableTools: string[]
): ToolChainPattern | null {
    for (const pattern of TOOL_CHAIN_PATTERNS) {
        // 检查所需工具是否可用
        const toolsAvailable = pattern.requiredTools.every(
            tool => availableTools.includes(tool)
        );
        if (!toolsAvailable) continue;

        // 检查正则匹配
        if (pattern.patterns.some(p => p.test(text))) {
            return pattern;
        }

        // 检查关键词匹配（需要匹配多个关键词）
        const matchedKeywords = pattern.keywords.filter(kw => text.includes(kw));
        if (matchedKeywords.length >= 2) {
            return pattern;
        }
    }

    return null;
}

/**
 * 从文本中提取城市列表（用于多城市天气）
 */
export function extractCities(text: string): string[] {
    // 匹配 "北京和上海" 或 "北京、上海、广州" 格式
    const cityPattern = /([\u4e00-\u9fa5]{2,4})(和|跟|以及|还有|、|,)/g;
    const cities: string[] = [];

    let match;
    while ((match = cityPattern.exec(text)) !== null) {
        cities.push(match[1]);
    }

    // 提取最后一个城市（在"天气"前）
    const lastCityMatch = text.match(/([\u4e00-\u9fa5]{2,4})(?:的)?天气/);
    if (lastCityMatch && !cities.includes(lastCityMatch[1])) {
        cities.push(lastCityMatch[1]);
    }

    return cities;
}

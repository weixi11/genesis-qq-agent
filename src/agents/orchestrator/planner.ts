/**
 * 执行计划生成器
 * 
 * 分析用户意图，检测是否需要多工具编排，生成执行计划
 */

import { randomUUID } from 'crypto';
import { log } from '../../logger.js';
import type { ExecutionPlan, OrchestrationDetection, ToolNode, ExecutionMode } from './types.js';
import { matchToolChainPattern, extractCities, type ToolChainPattern } from './patterns.js';

/** 顺序词 */
const SEQUENTIAL_KEYWORDS = ['然后', '接着', '再', '之后', '完了', '好了之后'];

/** 并行词 */
const PARALLEL_KEYWORDS = ['同时', '一起', '都', '和', '以及', '还有'];

export class ExecutionPlanner {
    /**
     * 检测是否需要多工具编排
     */
    detectOrchestration(text: string, toolNames: string[]): OrchestrationDetection {
        // 1. 检查预定义模式
        const pattern = matchToolChainPattern(text, toolNames);
        if (pattern) {
            return {
                needed: true,
                pattern: pattern.id,
                keywords: pattern.keywords.filter(kw => text.includes(kw)),
                mode: pattern.mode,
            };
        }

        // 2. 检查顺序词
        const seqMatches = SEQUENTIAL_KEYWORDS.filter(kw => text.includes(kw));
        if (seqMatches.length > 0) {
            return {
                needed: true,
                keywords: seqMatches,
                mode: 'sequential',
            };
        }

        // 3. 检查并行词（需要配合多个实体）
        const paraMatches = PARALLEL_KEYWORDS.filter(kw => text.includes(kw));
        if (paraMatches.length > 0 && text.includes('天气')) {
            const cities = extractCities(text);
            if (cities.length >= 2) {
                return {
                    needed: true,
                    keywords: paraMatches,
                    mode: 'parallel',
                };
            }
        }

        // 不需要编排
        return {
            needed: false,
            keywords: [],
            mode: 'sequential',
        };
    }

    /**
     * 生成执行计划
     */
    createPlan(
        text: string,
        tools: { name: string; params: Record<string, unknown> }[],
        availableTools: string[]
    ): ExecutionPlan | null {
        // 1. 如果有明确的工具列表（来自 LLM），优先使用
        if (tools.length > 0) {
            const detection = this.detectOrchestration(text, availableTools);
            return this.createPlanFromTools(text, tools, detection.mode);
        }

        // 2. 尝试匹配预定义模式 (仅作为 Fallback)
        const pattern = matchToolChainPattern(text, availableTools);
        if (pattern) {
            return this.createPlanFromPattern(text, pattern);
        }

        return null;
    }

    /**
     * 从预定义模式创建计划
     */
    private createPlanFromPattern(text: string, pattern: ToolChainPattern): ExecutionPlan {
        const planId = randomUUID().slice(0, 8);

        // 克隆节点并替换变量
        const nodes = pattern.nodes.map(node => {
            const clonedNode = { ...node, params: { ...node.params } };

            // 替换城市变量
            if (pattern.id === 'multi_city_weather') {
                const cities = extractCities(text);
                if (node.id === 'city1' && cities[0]) {
                    clonedNode.params.city = cities[0];
                } else if (node.id === 'city2' && cities[1]) {
                    clonedNode.params.city = cities[1];
                }
            }

            return clonedNode;
        });

        log.info(`📋 生成执行计划: ${pattern.id} (${nodes.length} 个节点)`);

        return {
            id: planId,
            input: text,
            nodes,
            mode: pattern.mode,
            createdAt: Date.now(),
        };
    }

    /**
     * 从工具列表创建计划
     */
    private createPlanFromTools(
        text: string,
        tools: { name: string; params: Record<string, unknown> }[],
        mode: ExecutionMode
    ): ExecutionPlan {
        const planId = randomUUID().slice(0, 8);

        const nodes: ToolNode[] = tools.map((tool, index) => ({
            id: `step${index + 1}`,
            toolName: tool.name,
            params: tool.params,
            dependsOn: mode === 'sequential' && index > 0 ? [`step${index}`] : [],
        }));

        log.info(`📋 生成执行计划: ${mode} (${nodes.length} 个节点)`);

        return {
            id: planId,
            input: text,
            nodes,
            mode,
            createdAt: Date.now(),
        };
    }
}

// 全局单例
export const planner = new ExecutionPlanner();

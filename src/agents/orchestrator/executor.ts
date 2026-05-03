/**
 * 执行计划执行器
 * 
 * 按照执行计划执行工具，处理依赖关系和结果聚合
 */

import { log } from '../../logger.js';
import { executeModule } from '../../tools/index.js';
import type { ExecutionPlan, NodeResult, PlanResult, ToolNode } from './types.js';
import type { ModuleContext } from '../../tools/types.js';
import { taskManager } from '../../task/index.js';
import { buildTaskCacheScope } from '../../task/cache-scope.js';
import { toolStats } from '../../web/store/tool_stats.js';
import { stringifyForDisplay } from '../../utils/format.js';

export class PlanExecutor {
    private async runModule(toolName: string, params: Record<string, unknown>, ctx: ModuleContext) {
        return await executeModule(toolName, params, ctx);
    }

    /**
     * 执行计划
     */
    async execute(plan: ExecutionPlan, ctx: ModuleContext): Promise<PlanResult> {
        const startTime = Date.now();
        const nodeResults: NodeResult[] = [];
        const context: Record<string, NodeResult> = {};

        log.info(`🔗 开始执行计划: ${plan.id} (${plan.mode}, ${plan.nodes.length} 节点)`);

        if (plan.mode === 'parallel') {
            // 并行执行
            const results = await this.executeParallel(plan.nodes, ctx);
            nodeResults.push(...results);
        } else {
            // 顺序执行（含依赖处理）
            const sortedNodes = this.topologicalSort(plan.nodes);

            for (const node of sortedNodes) {
                // 检查依赖是否满足
                const depsOk = this.checkDependencies(node, nodeResults);
                if (!depsOk) {
                    log.warn(`⏭️ 跳过节点 ${node.id}: 依赖未满足`);
                    continue;
                }

                // 替换参数中的占位符
                const resolvedParams = this.resolveParams(node.params, context);

                // 执行节点
                const result = await this.executeNode(node, resolvedParams, ctx);
                nodeResults.push(result);
                context[node.id] = result;

                // 如果节点失败且有后续依赖，考虑是否继续
                if (!result.success && this.hasDownstreamDependents(node.id, plan.nodes)) {
                    log.warn(`⚠️ 节点 ${node.id} 失败，可能影响后续节点`);
                }
            }
        }

        const totalDuration = Date.now() - startTime;
        const finalResult = this.aggregateResults(plan, nodeResults, totalDuration);

        log.info(`✅ 计划执行完成: ${plan.id} (${totalDuration}ms, ${nodeResults.filter(r => r.success).length}/${nodeResults.length} 成功)`);

        return finalResult;
    }

    /**
     * 并行执行节点
     */
    private async executeParallel(nodes: ToolNode[], ctx: ModuleContext): Promise<NodeResult[]> {
        const promises = nodes.map(node => this.executeNode(node, node.params, ctx));
        return Promise.all(promises);
    }

    /**
     * 执行单个节点
     */
    private async executeNode(
        node: ToolNode,
        params: Record<string, unknown>,
        ctx: ModuleContext
    ): Promise<NodeResult> {
        const startTime = Date.now();
        const cacheScope = buildTaskCacheScope({
            sessionKey: ctx.groupId ? `group:${ctx.groupId}` : `private:${ctx.senderId}`,
            atUsers: ctx.atUsers,
            imageUrls: ctx.imageUrls,
            videoPaths: ctx.videoPaths,
            audioPaths: ctx.audioPaths,
            filePaths: ctx.filePaths,
        });
        const cachedTask = taskManager.checkCache(ctx.senderId, node.toolName, params, cacheScope);
        if (cachedTask) {
            if (cachedTask.status === 'pending' || cachedTask.status === 'running') {
                return {
                    nodeId: node.id,
                    toolName: node.toolName,
                    success: true,
                    text: `[${node.toolName} 已在执行中，无需重复调用，任务ID: ${cachedTask.id.slice(0, 8)}]`,
                    duration: 0,
                };
            }
            if (cachedTask.status === 'success' && cachedTask.result) {
                return {
                    nodeId: node.id,
                    toolName: node.toolName,
                    success: cachedTask.result.success,
                    text: cachedTask.result.text,
                    data: cachedTask.result.data,
                    duration: 0,
                };
            }
        }

        const task = taskManager.createTask(ctx.senderId, ctx.groupId, node.toolName, params, cacheScope);
        taskManager.startTask(task.id);

        try {
            log.debug(`▶️ 执行节点: ${node.id} (${node.toolName})`);

            // 2. 执行模块
            const result = await this.runModule(node.toolName, params, ctx);
            const duration = Date.now() - startTime;

            if (taskManager.isCancellationRequested(task.id)) {
                const interruptedTask = taskManager.getTask(task.id);
                const interruptedText = interruptedTask?.status === 'timeout' ? '执行超时' : '任务已取消';
                toolStats.add({
                    name: node.toolName,
                    params,
                    result: interruptedText,
                    success: false,
                    duration,
                    time: Date.now(),
                    user: {
                        id: ctx.senderId,
                        name: String(ctx.senderId),
                    },
                    taskId: task.id,
                });
                taskManager.completeTask(task.id, false, interruptedText, undefined, interruptedText);
                return {
                    nodeId: node.id,
                    toolName: node.toolName,
                    success: false,
                    text: interruptedText,
                    duration,
                };
            }

            // 3. 记录 stats
            // 将执行结果中的数据合并到 params 中，以便在前端日志中展示
            const logParams = { ...params };
            if (result.data && typeof result.data === 'object') {
                Object.assign(logParams, result.data);
            }

            toolStats.add({
                name: node.toolName,
                params: logParams,
                result: result.text || (result.success ? '成功' : '失败'),
                success: result.success,
                duration,
                time: Date.now(),
                user: {
                    id: ctx.senderId,
                    name: String(ctx.senderId), // 暂时用 ID 当名字，因为 Context 里没有 Name
                },
                taskId: task.id,
            });

            // 4. 完成任务
            taskManager.completeTask(
                task.id,
                result.success,
                result.text,
                result.data,
                result.success ? undefined : (result.text || 'Unknown error')
            );

            return {
                nodeId: node.id,
                toolName: node.toolName,
                success: result.success,
                text: result.text,
                data: result.data,
                segments: result.segments,  // 保留消息段（音乐卡片、图片等）
                files: result.files,
                duration,
            };
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            log.error(`❌ 节点执行失败: ${node.id}`, err);
            taskManager.completeTask(
                task.id,
                false,
                `执行失败: ${errorMsg}`,
                undefined,
                errorMsg,
            );

            return {
                nodeId: node.id,
                toolName: node.toolName,
                success: false,
                text: `执行失败: ${errorMsg}`,
                error: errorMsg,
                duration: Date.now() - startTime,
            };
        }
    }

    /**
     * 拓扑排序（确保依赖顺序）
     */
    private topologicalSort(nodes: ToolNode[]): ToolNode[] {
        const sorted: ToolNode[] = [];
        const visited = new Set<string>();
        const nodeMap = new Map(nodes.map(n => [n.id, n]));

        const visit = (nodeId: string): void => {
            if (visited.has(nodeId)) return;
            visited.add(nodeId);

            const node = nodeMap.get(nodeId);
            if (!node) return;

            // 先访问依赖
            for (const depId of node.dependsOn) {
                visit(depId);
            }

            sorted.push(node);
        };

        for (const node of nodes) {
            visit(node.id);
        }

        return sorted;
    }

    /**
     * 检查节点依赖是否满足
     */
    private checkDependencies(node: ToolNode, results: NodeResult[]): boolean {
        if (node.dependsOn.length === 0) return true;

        for (const depId of node.dependsOn) {
            const depResult = results.find(r => r.nodeId === depId);
            if (!depResult || !depResult.success) {
                return false;
            }
        }

        return true;
    }

    /**
     * 检查是否有下游依赖
     */
    private hasDownstreamDependents(nodeId: string, allNodes: ToolNode[]): boolean {
        return allNodes.some(n => n.dependsOn.includes(nodeId));
    }

    /**
     * 替换参数中的占位符
     * 支持 ${nodeId.text}、${nodeId.data.field} 格式
     */
    private resolveParams(
        params: Record<string, unknown>,
        context: Record<string, NodeResult>
    ): Record<string, unknown> {
        const resolved: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(params)) {
            if (typeof value === 'string' && value.includes('${')) {
                resolved[key] = this.resolveTemplate(value, context);
            } else {
                resolved[key] = value;
            }
        }

        return resolved;
    }

    /**
     * 解析模板字符串
     */
    private resolveTemplate(
        template: string,
        context: Record<string, NodeResult>
    ): string {
        return template.replace(/\$\{([^}]+)\}/g, (match: string, rawPath: string) => {
            const parts = rawPath.split('.');
            const nodeId = parts[0];
            const field = parts[1] || 'text';
            const dataKey = parts[2];

            const nodeResult = context[nodeId];
            if (!nodeResult) {
                log.warn(`⚠️ 找不到节点结果: ${nodeId}`);
                return match;
            }

            if (field === 'text') {
                return nodeResult.text || '';
            } else if (field === 'data' && dataKey) {
                const data = nodeResult.data as Record<string, unknown> | undefined;
                return stringifyForDisplay(data?.[dataKey] ?? '');
            }

            // 访问其他字段
            const resultRecord = nodeResult as unknown as Record<string, unknown>;
            return stringifyForDisplay(resultRecord[field] ?? '');
        });
    }

    /**
     * 聚合结果
     */
    private aggregateResults(
        plan: ExecutionPlan,
        nodeResults: NodeResult[],
        totalDuration: number
    ): PlanResult {
        const successResults = nodeResults.filter(r => r.success);
        const failedResults = nodeResults.filter(r => !r.success);
        const skippedCount = Math.max(plan.nodes.length - nodeResults.length, 0);

        // 合并文本
        let finalText: string;
        if (plan.mode === 'parallel') {
            const parts = [
                ...successResults.map(r => r.text).filter(Boolean),
                ...failedResults.map(r => `【${r.toolName}失败】${r.text || r.error || '执行失败'}`),
            ];
            if (skippedCount > 0) {
                parts.push(`【跳过】有 ${skippedCount} 个节点因依赖未满足未执行`);
            }
            finalText = parts.join('\n\n---\n\n') || '执行失败';
        } else {
            const allSucceeded = skippedCount === 0
                && nodeResults.length > 0
                && failedResults.length === 0;

            if (allSucceeded) {
                finalText = nodeResults[nodeResults.length - 1].text || '执行失败';
            } else {
                const parts = [
                    ...successResults.map(r => r.text).filter(Boolean),
                    ...failedResults.map(r => `【${r.toolName}失败】${r.text || r.error || '执行失败'}`),
                ];
                if (skippedCount > 0) {
                    parts.push(`【跳过】有 ${skippedCount} 个节点因依赖未满足未执行`);
                }
                finalText = parts.join('\n\n---\n\n') || '执行失败';
            }
        }

        // 合并数据 (智能合并数组)
        const finalData = nodeResults.reduce((acc: Record<string, unknown>, r) => {
            if (r.data && typeof r.data === 'object') {
                const newData = r.data as Record<string, unknown>;
                for (const [key, value] of Object.entries(newData)) {
                    if (Array.isArray(value) && Array.isArray(acc[key])) {
                        // 数组：合并
                        acc[key] = [...(acc[key] as unknown[]), ...value];
                    } else {
                        // 其他：覆盖
                        acc[key] = value;
                    }
                }
            }
            return acc;
        }, {});

        // 合并所有节点的 segments（音乐卡片、图片等）
        const allSegments = nodeResults
            .filter(r => r.segments && r.segments.length > 0)
            .flatMap(r => r.segments!);
        const allFiles = nodeResults
            .filter(r => r.files && r.files.length > 0)
            .flatMap(r => r.files!);

        return {
            planId: plan.id,
            success: skippedCount === 0
                && nodeResults.length > 0
                && failedResults.length === 0,
            nodeResults,
            finalText,
            finalData: Object.keys(finalData).length > 0 ? finalData : undefined,
            finalSegments: allSegments.length > 0 ? allSegments : undefined,
            finalFiles: allFiles.length > 0 ? allFiles : undefined,
            totalDuration,
        };
    }
}

// 全局单例
export const executor = new PlanExecutor();

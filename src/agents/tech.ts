/**
 * Tech Agent (技术专家)
 * 
 * 职责：
 * - 执行 Router 规划的工具
 * - 管理工具执行上下文
 * - 处理多工具编排
 * 
 * 注意：工具选择已由 Router (PlanRouter) 完成，Tech 只负责执行
 */

import { log } from '../logger.js';
import { buildTechResolveParamsSystemPrompt, TECH_RESOLVE_PARAMS_USER_PROMPT } from '../prompts/tech.js';
import type { FormattedMessage, TaskPlan } from '../types.js';
import { toolStats } from '../web/store/tool_stats.js';
import { taskManager } from '../task/index.js';
import { toolRegistry } from '../services/tool_registry.js';
import { orchestrationService } from '../services/orchestration_service.js';
import { resolveImagePromptParams } from '../services/image_prompt_resolver.js';
import { techLlm } from '../llm.js';
import { safeParseLLMJson } from '../utils/json.js';
import { stringifyForDisplay } from '../utils/format.js';
import { getPersonaAppearance, getPersonaDisplayName } from '../utils/personaLoader.js';
import { normalizeSelfReferenceDrawParams } from '../utils/selfReferenceDraw.js';
import { buildTaskCacheScope } from '../task/cache-scope.js';
import { z } from 'zod';
import {
    executeModule,
    buildModuleContext,
} from '../tools/index.js';

import type { MessageSegment } from '../utils/message.js';
import type { FileAttachment } from '../utils/file_attachment.js';

/** 工具类型（动态，不再硬编码） */
export type ToolType = string;

/** 工具调用结果 */
export interface ToolResult {
    tool: string;
    /** 实际调用的所有工具名称（用于多工具场景） */
    toolNames?: string[];
    success: boolean;
    text: string;
    /** 统一消息段数组 */
    segments?: MessageSegment[];
    /** 本地文件附件 */
    files?: FileAttachment[];
    data?: unknown;
    /** 工具调用时使用的参数（用于上下文透传，单工具或合并后的参数） */
    params?: Record<string, unknown>;
    /** 多工具时每个工具的独立参数（用于上下文透传，避免参数覆盖） */
    toolParams?: Array<{ name: string; params: Record<string, unknown> }>;
}

/** 工具步骤（含依赖关系） */
export interface ToolStep {
    id?: string;
    name: string;
    params: Record<string, unknown>;
    dependsOn?: string[];
}

/** Tech 上下文 */
export interface TechContext {
    message: FormattedMessage;
    history: FormattedMessage[];
    /** Router/TaskPlan 提供的总目标，用于执行计划记录 */
    executionInput?: string;
    /** Router 提取的工具名（单工具兼容） */
    toolName?: string;
    /** Router 提取的工具名列表 */
    toolNames?: string[];
    /** Router 提取的工具参数（向后兼容：第一个工具的参数） */
    toolParams?: unknown;
    /** 完整的工具参数列表（每个工具独立参数，含依赖关系） */
    toolParamsList?: ToolStep[];
    /** 图片URL（用于识图） */
    imageUrl?: string;
    /** 是否有顺序依赖（来自 Router 规划） */
    _hasSequentialDeps?: boolean;
}

/** 工具分析结果（内部使用） */
interface ToolAnalysis {
    tools: ToolStep[];
    needsTool: boolean;
}

const toolParamsSchema = z.record(z.unknown());
const SELF_DRAW_PROMPT_SYSTEM_PROMPT = `You write final image-generation prompts for the bot's self portrait.

Rules:
1. Output a single final English prompt only.
2. Use concise English tags and short English phrases that are friendly to anime image models.
3. Preserve the bot's visual identity anchors from the persona appearance reference.
4. Merge the user's requested scene, action, framing, mood, clothing, and style into the final prompt.
5. Use the persona reference as guidance; do not copy it verbatim or include non-visual lore, account IDs, ownership, or group identity.
6. Do not explain. Do not output JSON. Do not output Chinese.`;

/**
 * Tech Agent
 */
export class TechAgent {
    private async resolveSelfReferenceDrawParams(
        params: Record<string, unknown>,
        userText: string,
    ): Promise<Record<string, unknown>> {
        return normalizeSelfReferenceDrawParams({
            params,
            userText,
            stage: '🎨 Tech',
            appearance: typeof params.botAppearance === 'string' ? params.botAppearance : getPersonaAppearance(),
            personaName: getPersonaDisplayName(),
            composePrompt: async ({ appearance, personaName, originalPrompt, missingAnchors, retry }) => techLlm.chat([
                {
                    role: 'system',
                    content: SELF_DRAW_PROMPT_SYSTEM_PROMPT,
                },
                {
                    role: 'user',
                    content: `Bot name: ${personaName}
Persona appearance reference:
${appearance}

User request:
${userText || originalPrompt}

Current draw request:
${originalPrompt}

${retry ? `Required identity anchors that must appear explicitly: ${(missingAnchors || []).join(', ') || 'pink_hair, purple_eyes, cat_ears'}\n` : ''}Return one final English image prompt only.`,
                },
            ], {
                temperature: 0,
            }, 'tech_self_draw_prompt'),
        });
    }

    private buildToolCacheScope(message: FormattedMessage): string {
        const currentImages = (message.images?.map(i => typeof i === 'string' ? i : (i.url || i.file || '')).filter(Boolean)) || [];
        const replyImages = (message.reply?.media?.images?.map(i => i.url || i.file || i.path || '').filter(Boolean)) || [];
        const currentVideos = (message.videos?.map(v => typeof v === 'string' ? v : (v.path || v.file || v.url || '')).filter(Boolean)) || [];
        const replyVideos = (message.reply?.media?.videos?.map(v => v.path || v.file || v.url || '').filter(Boolean)) || [];
        const currentAudios = (message.records?.map(r => typeof r === 'string' ? r : (r.path || r.file || r.url || '')).filter(Boolean)) || [];
        const replyAudios = (message.reply?.media?.records?.map(r => r.path || r.file || r.url || '').filter(Boolean)) || [];
        const currentFiles = (message.files?.map(f => f.path || f.file || f.url || '').filter(Boolean)) || [];
        const replyFiles = (message.reply?.media?.files?.map(f => {
            const file = f as { path?: string; file?: string; url?: string };
            return file.path || file.file || file.url || '';
        }).filter(Boolean)) || [];

        return buildTaskCacheScope({
            sessionKey: message.type === 'group' && message.group_id
                ? `group:${message.group_id}`
                : `private:${message.sender_id}`,
            replyMessageId: message.reply?.message_id || null,
            atUsers: message.at_users,
            imageUrls: [...currentImages, ...replyImages],
            videoPaths: [...currentVideos, ...replyVideos],
            audioPaths: [...currentAudios, ...replyAudios],
            filePaths: [...currentFiles, ...replyFiles],
        });
    }

    private resolveInterruptedTaskText(taskId: string): string {
        const task = taskManager.getTask(taskId);
        return task?.status === 'timeout' ? '执行超时' : '任务已取消';
    }

    private async prepareToolForExecution(
        tool: { name: string; params: Record<string, unknown> },
        userText: string,
    ): Promise<{ name: string; params: Record<string, unknown> }> {
        if (tool.name !== 'draw' && tool.name !== 'banana_draw') {
            return tool;
        }

        const selfResolvedParams = await this.resolveSelfReferenceDrawParams(tool.params, userText);
        const params = await resolveImagePromptParams({
            toolName: tool.name,
            params: selfResolvedParams,
            userText,
            stage: '🎨 Tech',
        });

        return { ...tool, params };
    }

    private summarizeToolResults(results: ToolResult[]): { success: boolean; text: string } {
        const successTexts = results
            .filter(r => r.success && r.text.trim())
            .map(r => r.text.trim());
        const failureTexts = results
            .filter(r => !r.success)
            .map(r => `【${r.tool}失败】${r.text || '执行失败'}`);

        const parts = [...successTexts, ...failureTexts].filter(Boolean);
        return {
            success: results.length > 0 && results.every(r => r.success),
            text: parts.join('\n\n---\n\n') || '执行失败',
        };
    }

    private getUnmetDependencies(
        tool: ToolStep,
        results: Map<string, ToolResult>,
    ): string[] {
        if (!tool.dependsOn || tool.dependsOn.length === 0) {
            return [];
        }

        return tool.dependsOn.filter((depId) => {
            const depResult = results.get(depId);
            return !depResult || !depResult.success;
        });
    }

    /**
     * 处理技术请求
     * 
     * 注意：工具选择已由 Router 完成，这里只负责执行
     */
    async handle(ctx: TechContext): Promise<ToolResult> {
        const { message, history, toolParams, toolName, toolNames, toolParamsList, executionInput } = ctx;

        // ========== 从 Router 提取工具信息 ==========
        // 如果 Router 没有提供工具，直接返回 none 让 Persona 处理
        if (!toolName && (!toolNames || toolNames.length === 0)) {
            log.debug('📋 Tech: Router 未提供工具，交给 Persona 处理');
            return { tool: 'none', success: true, text: '' };
        }

        // 构建工具分析结果
        let tools: ToolStep[];

        if (toolParamsList && toolParamsList.length > 0) {
            tools = toolParamsList;
        } else if (toolNames && toolNames.length > 0) {
            tools = toolNames.map(name => ({ name, params: (toolParams as Record<string, unknown>) || {} }));
        } else {
            tools = [{ name: toolName!, params: (toolParams as Record<string, unknown>) || {} }];
        }

        const preparedTools = await Promise.all(
            tools.map(tool => this.prepareToolForExecution(tool, executionInput || message.text || ''))
        );

        log.info(`📋 使用 Router 提供的工具: ${preparedTools.map(t => t.name).join(', ')}`);

        const analysis: ToolAnalysis = { tools: preparedTools, needsTool: true };

        // 合并 Router 传入的参数（如 selfReference, botAppearance）到工具参数
        const routerParams = (toolParams as Record<string, unknown>) || {};

        // 执行工具
        if (analysis.tools.length === 1) {
            return this.executeSingleTool(analysis.tools[0], routerParams, message, history);
        } else {
            // 传递完整的工具步骤信息（含依赖）和顺序标记
            return this.executeMultipleTools(
                analysis.tools,
                routerParams,
                message,
                history,
                executionInput || message.text || '',
                ctx._hasSequentialDeps
            );
        }
    }

    /**
     * 执行任务计划（新接口，替代分散参数）
     */
    async handlePlan(
        plan: TaskPlan,
        message: FormattedMessage,
        history: FormattedMessage[]
    ): Promise<ToolResult> {
        // 从 plan 提取工具信息
        const toolSteps = plan.steps.filter(s => s.tool);
        if (toolSteps.length === 0) {
            return { tool: 'none', success: true, text: '' };
        }

        const toolNames = toolSteps.map(s => s.tool!);

        // 保留完整的步骤信息（包含 dependsOn）
        const toolParamsList = toolSteps.map(s => ({
            id: s.id,
            name: s.tool!,
            params: s.params || {},
            dependsOn: s.dependsOn || [],
        }));

        // 检测是否有依赖关系（任意步骤有 dependsOn）
        const hasSequentialDeps = toolParamsList.some(t => t.dependsOn.length > 0);

        return this.handle({
            message,
            history,
            executionInput: plan.goal,
            toolName: toolNames[0],
            toolNames,
            toolParams: hasSequentialDeps ? {} : (toolSteps[0]?.params || {}),
            toolParamsList,
            // 标记是否来自 Router 的顺序规划
            _hasSequentialDeps: hasSequentialDeps,
        } as TechContext);
    }

    /**
     * 执行单个工具
     */
    private async executeSingleTool(
        tool: { name: string; params: Record<string, unknown> },
        routerParams: Record<string, unknown>,
        message: FormattedMessage,
        history: FormattedMessage[]
    ): Promise<ToolResult> {
        // 直接使用工具自身的参数，不再合并 routerParams
        // 原因：在顺序执行时，ReAct LLM 已经正确解析了每个工具的参数
        // 如果再合并 routerParams（第一个工具的参数），会覆盖掉 LLM 解析的结果
        const mergedParams = tool.params;

        log.info(`🔧 Tech: 执行工具 -> ${tool.name}`);

        // 检查是否有对应的模块
        const matchedModule = toolRegistry.findByName(tool.name);

        if (matchedModule) {
            log.debug(`📦 尝试通过模块执行: ${tool.name}`);

            const cacheScope = this.buildToolCacheScope(message);
            const cachedTask = taskManager.checkCache(message.sender_id, tool.name, mergedParams, cacheScope);
            if (cachedTask) {
                if (cachedTask.status === 'pending' || cachedTask.status === 'running') {
                    log.info(`🔧 Tech: 跳过重复工具调用 ${tool.name} (${cachedTask.id.slice(0, 8)}) - 正在执行中`);
                    return {
                        tool: tool.name,
                        toolNames: [tool.name],
                        success: true,
                        text: `[${tool.name} 已在执行中，无需重复调用，任务ID: ${cachedTask.id.slice(0, 8)}]`,
                        params: mergedParams,
                    };
                }
                if (cachedTask.status === 'success' && cachedTask.result) {
                    log.info(`🔧 Tech: 命中缓存 ${tool.name} (${cachedTask.id.slice(0, 8)}) - 直接返回结果`);
                    return {
                        tool: tool.name,
                        toolNames: [tool.name],
                        success: cachedTask.result.success,
                        text: cachedTask.result.text,
                        data: cachedTask.result.data,
                        params: mergedParams,
                    };
                }
            }

            // 创建任务记录
            const task = taskManager.createTask(message.sender_id, message.group_id, tool.name, mergedParams, cacheScope);
            taskManager.startTask(task.id);
            const startTime = Date.now();

            try {
                // 提取当前消息和引用消息中的所有媒体
                const currentImages = (message.images?.map(i => typeof i === 'string' ? i : (i.url || i.file || '')).filter(Boolean)) || [];
                const replyImages = (message.reply?.media?.images?.map(i => i.url || i.file || i.path || '').filter(Boolean)) || [];
                const currentVideos = (message.videos?.map(v => typeof v === 'string' ? v : (v.path || v.file || v.url || '')).filter(Boolean)) || [];
                const replyVideos = (message.reply?.media?.videos?.map(v => v.path || v.file || v.url || '').filter(Boolean)) || [];
                const currentAudios = (message.records?.map(r => typeof r === 'string' ? r : (r.path || r.file || r.url || '')).filter(Boolean)) || [];
                const replyAudios = (message.reply?.media?.records?.map(r => r.path || r.file || r.url || '').filter(Boolean)) || [];
                const currentFiles = (message.files?.map(f => f.path || f.file || f.url || '').filter(Boolean)) || [];
                const replyFiles = (message.reply?.media?.files?.map(f => {
                    const file = f as { path?: string; file?: string; url?: string };
                    return file.path || file.file || file.url || '';
                }).filter(Boolean)) || [];

                const moduleCtx = buildModuleContext({
                    senderId: message.sender_id,
                    groupId: message.group_id,
                    imageUrls: [...currentImages, ...replyImages],
                    videoPaths: [...currentVideos, ...replyVideos],
                    audioPaths: [...currentAudios, ...replyAudios],
                    filePaths: [...currentFiles, ...replyFiles],
                    atUsers: message.at_users,
                    senderRole: message.sender_role,
                });

                const moduleResult = await executeModule(tool.name, mergedParams, moduleCtx);
                const duration = Date.now() - startTime;

                if (taskManager.isCancellationRequested(task.id)) {
                    const interruptedText = this.resolveInterruptedTaskText(task.id);
                    toolStats.add({
                        name: tool.name,
                        params: mergedParams,
                        result: interruptedText,
                        success: false,
                        duration,
                        time: Date.now(),
                        user: { id: message.sender_id, name: message.sender_name },
                        taskId: task.id,
                    });
                    taskManager.completeTask(task.id, false, interruptedText, undefined, interruptedText);
                    log.info(`🚫 模块执行结果被取消状态拦截: ${tool.name} (${task.id.slice(0, 8)})`);
                    return {
                        tool: tool.name,
                        toolNames: [tool.name],
                        success: false,
                        text: interruptedText,
                        params: mergedParams,
                    };
                }

                // 记录工具统计
                toolStats.add({
                    name: tool.name,
                    params: mergedParams,
                    result: moduleResult.text || (moduleResult.success ? '成功' : '失败'),
                    success: moduleResult.success,
                    duration,
                    time: Date.now(),
                    user: { id: message.sender_id, name: message.sender_name },
                    taskId: task.id,
                });

                // 完成任务记录
                taskManager.completeTask(task.id, moduleResult.success, moduleResult.text, moduleResult.data);

                if (moduleResult.success) {
                    log.info(`✅ 模块执行成功: ${tool.name}`);
                    return {
                        tool: tool.name,
                        toolNames: [tool.name],
                        success: true,
                        text: moduleResult.text || '',
                        segments: moduleResult.segments,
                        files: moduleResult.files,
                        data: moduleResult.data,
                        params: mergedParams,
                    };
                } else {
                    log.warn(`⚠️ 模块执行失败: ${tool.name} - ${moduleResult.text}`);
                    return {
                        tool: tool.name,
                        toolNames: [tool.name],
                        success: false,
                        text: moduleResult.text || '执行失败',
                        params: mergedParams,
                    };
                }
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                taskManager.completeTask(task.id, false, `模块执行异常: ${errorMsg}`, undefined, errorMsg);
                log.error(`❌ 模块执行异常: ${tool.name}`, err);
                return {
                    tool: tool.name,
                    toolNames: [tool.name],
                    success: false,
                    text: `工具 ${tool.name} 执行出错: ${errorMsg}`,
                    params: mergedParams,
                };
            }
        }

        // 工具不存在
        log.warn(`⚠️ 未找到工具: ${tool.name}`);
        return {
            tool: tool.name,
            success: false,
            text: `工具 ${tool.name} 不存在或未启用`,
        };
    }

    /**
     * 执行多个工具
     * 
     * @param hasSequentialDeps 如果 true，强制顺序执行并传递结果（来自 Router 规划的 dependsOn）
     */
    private async executeMultipleTools(
        tools: ToolStep[],
        routerParams: Record<string, unknown>,
        message: FormattedMessage,
        history: FormattedMessage[],
        executionInput: string,
        hasSequentialDeps?: boolean
    ): Promise<ToolResult> {
        // 如果 Router 规划了顺序依赖，强制使用顺序执行
        if (hasSequentialDeps) {
            log.info(`🔧 Tech: 多工具顺序执行 [${tools.map(t => t.name).join(' → ')}]`);
            return this.executeSequentialWithDeps(tools, routerParams, message, history);
        }

        // 使用 Router 已规划的步骤执行多工具任务
        const orchestrationResult = await orchestrationService.execute({
            input: executionInput,
            tools,
            message,
        });

        if (orchestrationResult) {
            // 编排执行成功
            return {
                tool: tools[0].name,
                toolNames: tools.map(t => t.name),
                success: orchestrationResult.success,
                text: orchestrationResult.text,
                data: orchestrationResult.data,
                segments: orchestrationResult.segments,
                files: orchestrationResult.files,
                // 保留每个工具的独立参数（用于上下文透传）
                toolParams: tools.map(t => ({ name: t.name, params: t.params })),
            };
        }

        // 回退到并行执行
        log.info(`🔧 Tech: 多工具并行执行 [${tools.map(t => t.name).join(', ')}]`);

        const toolPromises = tools.map(t =>
            this.executeSingleTool(t, routerParams, message, history)
        );
        const allResults = await Promise.all(toolPromises);
        const summary = this.summarizeToolResults(allResults);

        return {
            tool: tools[0].name,
            toolNames: tools.map(t => t.name),
            success: summary.success,
            text: summary.text,
            // 合并所有 segments（音乐卡片、图片等）
            segments: allResults.flatMap(r => r.segments || []),
            files: allResults.flatMap(r => r.files || []),
            data: allResults.reduce((acc: Record<string, unknown>, r) => {
                const rData = (r.data as Record<string, unknown>) || {};
                for (const [key, value] of Object.entries(rData)) {
                    if (Array.isArray(value) && Array.isArray(acc[key])) {
                        acc[key] = [...(acc[key] as unknown[]), ...value];
                    } else {
                        acc[key] = value;
                    }
                }
                return acc;
            }, {}),
            params: allResults.reduce((acc, r) => ({ ...acc, ...(r.params || {}) }), {}),
            // 保留每个工具的独立参数（合并 Router 参数和工具执行结果 data）
            toolParams: tools.map((t, i) => {
                const result = allResults[i];
                const resultData = (result?.data as Record<string, unknown>) || {};
                // 合并 Router 参数 + 工具执行结果中的有用信息
                const mergedParams = { ...t.params, ...resultData };
                return { name: t.name, params: mergedParams };
            }),
        };
    }

    /**
     * 顺序执行工具并传递结果
     * 
     * 支持 ${stepN.text} 模板语法引用前序工具输出
     */
    private async executeSequentialWithDeps(
        tools: ToolStep[],
        routerParams: Record<string, unknown>,
        message: FormattedMessage,
        history: FormattedMessage[]
    ): Promise<ToolResult> {
        const results: Map<string, ToolResult> = new Map();
        const allResults: ToolResult[] = [];

        for (const tool of tools) {
            const unmetDependencies = this.getUnmetDependencies(tool, results);
            if (unmetDependencies.length > 0) {
                const skippedResult: ToolResult = {
                    tool: tool.name,
                    success: false,
                    text: `跳过执行：依赖步骤 ${unmetDependencies.join(', ')} 失败或未执行`,
                    params: tool.params,
                };
                log.warn(`⏭️ 跳过 ${tool.name}: 依赖未满足 (${unmetDependencies.join(', ')})`);
                allResults.push(skippedResult);
                if (tool.id) {
                    results.set(tool.id, skippedResult);
                }
                continue;
            }

            let finalParams = tool.params;

            // 如果有依赖，且依赖步骤已成功执行，使用 LLM 解析参数
            if (tool.dependsOn && tool.dependsOn.length > 0) {
                const depsResults = tool.dependsOn
                    .map(depId => results.get(depId))
                    .filter((r): r is ToolResult => r !== undefined && r.success);

                if (depsResults.length > 0) {
                    log.debug(`🧠 ReAct: 使用 LLM 解析 ${tool.name} 的参数`);
                    const resolvedParams = await this.resolveParamsWithLLM(
                        tool,
                        depsResults,
                        message.text || ''
                    );
                    finalParams = { ...tool.params, ...resolvedParams };
                }
            }

            // 解析模板引用 ${stepN.text}
            const resolvedParams = this.resolveTemplateParams(finalParams, results);
            const preparedTool = await this.prepareToolForExecution(
                { name: tool.name, params: resolvedParams },
                message.text || '',
            );
            // 注意：顺序执行时不合并 routerParams，因为每个工具有自己独立的参数
            // routerParams 是第一个工具的参数，不应覆盖后续工具的参数
            const mergedParams = preparedTool.params;

            log.debug(`▶️ 顺序执行: ${tool.name} (依赖: ${tool.dependsOn?.join(', ') || '无'})`);

            const result = await this.executeSingleTool(
                { name: preparedTool.name, params: mergedParams },
                routerParams,
                message,
                history
            );

            allResults.push(result);

            // 存储结果供后续步骤引用
            if (tool.id) {
                results.set(tool.id, result);
            }

            // 如果失败且有后续依赖，记录警告
            if (!result.success && tools.some(t => t.dependsOn?.includes(tool.id || ''))) {
                log.warn(`⚠️ 步骤 ${tool.id} 失败，可能影响后续依赖步骤`);
            }
        }

        const summary = this.summarizeToolResults(allResults);

        return {
            tool: tools[0].name,
            toolNames: tools.map(t => t.name),
            success: summary.success,
            text: summary.text,
            segments: allResults.flatMap(r => r.segments || []),
            files: allResults.flatMap(r => r.files || []),
            data: allResults.reduce((acc: Record<string, unknown>, r) => {
                const rData = (r.data as Record<string, unknown>) || {};
                for (const [key, value] of Object.entries(rData)) {
                    if (Array.isArray(value) && Array.isArray(acc[key])) {
                        acc[key] = [...(acc[key] as unknown[]), ...value];
                    } else {
                        acc[key] = value;
                    }
                }
                return acc;
            }, {}),
            params: allResults.reduce((acc, r) => ({ ...acc, ...(r.params || {}) }), {}),
            toolParams: tools.map((t, i) => ({
                name: t.name,
                params: { ...t.params, ...(allResults[i]?.data as Record<string, unknown> || {}) },
            })),
        };
    }

    /**
     * 解析参数中的模板引用
     * 
     * 支持:
     * - ${stepN.text} - 获取步骤 N 的文本输出
     * - ${stepN.data.fieldName} - 获取步骤 N 数据中的字段
     */
    private resolveTemplateParams(
        params: Record<string, unknown>,
        results: Map<string, ToolResult>
    ): Record<string, unknown> {
        const resolved: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(params)) {
            if (typeof value === 'string' && value.includes('${')) {
                resolved[key] = value.replace(/\$\{([^}]+)\}/g, (match: string, rawPath: string) => {
                    const parts = rawPath.split('.');
                    const stepId = parts[0];
                    const field = parts[1] || 'text';
                    const dataKey = parts[2];

                    const stepResult = results.get(stepId);
                    if (!stepResult) {
                        log.warn(`⚠️ 找不到步骤结果: ${stepId}`);
                        return match;
                    }

                    if (field === 'text') {
                        return stepResult.text || '';
                    } else if (field === 'data' && dataKey) {
                        const data = stepResult.data as Record<string, unknown> | undefined;
                        return stringifyForDisplay(data?.[dataKey] ?? '');
                    }

                    return match;
                });
            } else {
                resolved[key] = value;
            }
        }

        return resolved;
    }

    /**
     * 使用 LLM 解析依赖步骤的参数
     * 
     * ReAct 模式：观察前序工具的输出，智能填充当前工具的参数
     */
    private async resolveParamsWithLLM(
        tool: ToolStep,
        depsResults: ToolResult[],
        userText: string
    ): Promise<Record<string, unknown>> {
        // 获取工具 schema
        const toolInfo = toolRegistry.findByName(tool.name);
        if (!toolInfo) {
            return {};
        }

        const systemPrompt = buildTechResolveParamsSystemPrompt({
            userText,
            depsResults: depsResults.map(result => ({
                tool: result.tool,
                text: result.text,
                data: result.data,
            })),
            toolName: tool.name,
            toolDescription: toolInfo.module.description || '',
            toolParameters: toolInfo.module.schema?.parameters || {},
            currentParams: tool.params,
        });

        try {
            const response = await techLlm.ask(TECH_RESOLVE_PARAMS_USER_PROMPT, systemPrompt, 'tech_resolve_params');
            const rawParsed = safeParseLLMJson<unknown>(response);
            const parsed = toolParamsSchema.safeParse(rawParsed);

            if (parsed.success) {
                log.debug(`🧠 ReAct 解析结果: ${JSON.stringify(parsed.data)}`);
                return parsed.data;
            }

            if (rawParsed) {
                log.debug(`🧠 ReAct schema 校验失败: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
            }
        } catch (err) {
            log.warn(`🧠 ReAct LLM 解析失败:`, err);
        }

        return {};
    }
}

// 全局单例
export const tech = new TechAgent();

/**
 * 编排服务
 * 
 * 封装多工具编排的检测和执行逻辑
 * Tech Agent 通过此服务执行多工具任务，无需直接依赖 orchestrator 内部实现
 */

import { randomUUID } from 'crypto';
import { log } from '../logger.js';
import { planner, executor } from '../agents/orchestrator/index.js';
import type { ExecutionMode, ExecutionPlan, OrchestrationDetection } from '../agents/orchestrator/types.js';
import type { ToolContext } from '../tools/types.js';
import { buildToolContext } from '../tools/index.js';
import type { FormattedMessage } from '../types.js';
import { toolRegistry } from './tool_registry.js';

/** 多工具执行请求 */
export interface MultiToolRequest {
    /** Router/TaskPlan 提供的目标描述或原始输入 */
    input: string;
    /** 工具列表（来自 Router 规划） */
    tools: Array<{
        id?: string;
        name: string;
        params: Record<string, unknown>;
        dependsOn?: string[];
    }>;
    /** 消息上下文（用于提取媒体等） */
    message: FormattedMessage;
}

/** 多工具执行结果 */
export interface MultiToolResult {
    /** 是否执行成功 */
    success: boolean;
    /** 合并后的文本输出 */
    text: string;
    /** 合并后的数据 */
    data?: unknown;
    /** 合并后的消息段（音乐卡片等） */
    segments?: import('../utils/message.js').MessageSegment[];
    /** 合并后的本地文件附件 */
    files?: import('../utils/file_attachment.js').FileAttachment[];
    /** 执行耗时 */
    duration: number;
    /** 使用的编排模式 */
    mode: 'sequential' | 'parallel' | 'mixed' | 'direct';
}

/**
 * 编排服务
 */
class OrchestrationService {
    /**
     * 检测是否需要多工具编排
     */
    detectOrchestration(text: string): OrchestrationDetection {
        const availableTools = toolRegistry.getEnabledToolNames();
        return planner.detectOrchestration(text, availableTools);
    }

    /**
     * 执行多工具任务
     * 
     * 直接消费 Router/TaskPlan 给出的工具步骤：
     * - 多工具时：根据 dependsOn 推导执行模式并执行
     * - 单工具时：返回 null，调用方回退到直接执行
     */
    async execute(request: MultiToolRequest): Promise<MultiToolResult | null> {
        const { input, tools, message } = request;
        if (tools.length <= 1) {
            return null;
        }

        const mode = this.resolveMode(tools);
        const plan = this.buildExecutionPlan(input, tools, mode);

        log.info(`🔗 编排服务: 执行计划 [${tools.map(t => t.name).join(' → ')}] (${mode})`);

        // 构建工具上下文
        const toolCtx = this.buildContext(message);

        // 执行计划
        const startTime = Date.now();
        const result = await executor.execute(plan, toolCtx);
        const duration = Date.now() - startTime;

        return {
            success: result.success,
            text: result.finalText,
            data: result.finalData,
            segments: result.finalSegments,
            files: result.finalFiles,
            duration,
            mode,
        };
    }

    /**
     * 从 Router 规划的依赖关系推导执行模式
     */
    private resolveMode(tools: MultiToolRequest['tools']): ExecutionMode {
        const hasDependencies = tools.some(t => (t.dependsOn?.length || 0) > 0);
        if (!hasDependencies) {
            return 'parallel';
        }

        // 当前 executor 对有依赖的 DAG 统一按拓扑顺序执行；
        // 在真正实现 mixed 调度前，先保持语义与实际执行一致。
        return 'sequential';
    }

    /**
     * 基于 Router 已规划的步骤构造执行计划
     */
    private buildExecutionPlan(
        input: string,
        tools: MultiToolRequest['tools'],
        mode: ExecutionMode
    ): ExecutionPlan {
        return {
            id: randomUUID().slice(0, 8),
            input: input.trim() || tools.map(t => t.name).join(' -> '),
            nodes: tools.map((tool, index) => ({
                id: tool.id || `step${index + 1}`,
                toolName: tool.name,
                params: tool.params,
                dependsOn: tool.dependsOn || [],
            })),
            mode,
            createdAt: Date.now(),
        };
    }

    /**
     * 从消息构建工具上下文
     */
    private buildContext(message: FormattedMessage): ToolContext {
        const currentImages = (message.images?.map(i =>
            typeof i === 'string' ? i : (i.url || i.file || i.path || '')
        ) || []).filter(Boolean);
        const replyImages = (message.reply?.media?.images?.map(i =>
            i.url || i.file || i.path || ''
        ) || []).filter(Boolean);
        const currentVideos = (message.videos?.map(v =>
            typeof v === 'string' ? v : (v.path || v.file || v.url || '')
        ) || []).filter(Boolean);
        const replyVideos = (message.reply?.media?.videos?.map(v =>
            v.path || v.file || v.url || ''
        ) || []).filter(Boolean);
        const currentAudios = (message.records?.map(r =>
            typeof r === 'string' ? r : (r.path || r.file || r.url || '')
        ) || []).filter(Boolean);
        const replyAudios = (message.reply?.media?.records?.map(r =>
            r.path || r.file || r.url || ''
        ) || []).filter(Boolean);
        const currentFiles = (message.files?.map(f =>
            typeof f === 'string' ? f : (f.path || f.file || f.url || '')
        ) || []).filter(Boolean);
        const replyFiles = (message.reply?.media?.files?.map(f =>
            (f as { path?: string; file?: string; url?: string }).path
            || (f as { path?: string; file?: string; url?: string }).file
            || (f as { path?: string; file?: string; url?: string }).url
            || ''
        ) || []).filter(Boolean);

        return buildToolContext({
            senderId: message.sender_id,
            groupId: message.group_id,
            atUsers: message.at_users,
            imageUrls: [...currentImages, ...replyImages],
            videoPaths: [...currentVideos, ...replyVideos],
            audioPaths: [...currentAudios, ...replyAudios],
            filePaths: [...currentFiles, ...replyFiles],
            senderRole: message.sender_role,
        });
    }
}

// 全局单例
export const orchestrationService = new OrchestrationService();

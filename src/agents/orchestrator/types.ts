/**
 * 多工具编排 - 类型定义
 */

/** 执行模式 */
export type ExecutionMode = 'sequential' | 'parallel' | 'mixed';

/** 工具调用节点 */
export interface ToolNode {
    /** 节点ID */
    id: string;
    /** 工具名 */
    toolName: string;
    /** 参数（可包含占位符如 ${step1.output}） */
    params: Record<string, unknown>;
    /** 依赖的前置节点ID */
    dependsOn: string[];
    /** 条件表达式（可选，用于条件执行） */
    condition?: string;
}

/** 执行计划 */
export interface ExecutionPlan {
    /** 计划ID */
    id: string;
    /** 用户原始输入 */
    input: string;
    /** 节点列表 */
    nodes: ToolNode[];
    /** 执行模式 */
    mode: ExecutionMode;
    /** 创建时间 */
    createdAt: number;
}

/** 节点执行结果 */
export interface NodeResult {
    /** 节点ID */
    nodeId: string;
    /** 工具名 */
    toolName: string;
    /** 是否成功 */
    success: boolean;
    /** 输出文本 */
    text: string;
    /** 输出数据 */
    data?: unknown;
    /** 消息段（音乐卡片、图片等） */
    segments?: import('../../utils/message.js').MessageSegment[];
    /** 本地文件附件 */
    files?: import('../../utils/file_attachment.js').FileAttachment[];
    /** 错误信息 */
    error?: string;
    /** 执行时长（毫秒） */
    duration: number;
}

/** 计划执行结果 */
export interface PlanResult {
    /** 计划ID */
    planId: string;
    /** 是否成功（至少一个节点成功） */
    success: boolean;
    /** 各节点执行结果 */
    nodeResults: NodeResult[];
    /** 合并后的最终输出 */
    finalText: string;
    /** 合并后的数据 */
    finalData?: unknown;
    /** 合并后的消息段（音乐卡片、图片等） */
    finalSegments?: import('../../utils/message.js').MessageSegment[];
    /** 合并后的本地文件附件 */
    finalFiles?: import('../../utils/file_attachment.js').FileAttachment[];
    /** 总执行时长（毫秒） */
    totalDuration: number;
}

/** 编排检测结果 */
export interface OrchestrationDetection {
    /** 是否需要编排 */
    needed: boolean;
    /** 检测到的模式 */
    pattern?: string;
    /** 检测到的关键词 */
    keywords: string[];
    /** 推荐的执行模式 */
    mode: ExecutionMode;
}

import type { FormattedMessage, TaskExecutionMode, TaskPlan, TaskStep } from '../types.js';

export interface TaskExecutionAssessment {
    executionMode: TaskExecutionMode;
    complexity: {
        score: number;
        reasons: string[];
    };
}

const REACT_SCORE_THRESHOLD = 3;
const OPEN_ENDED_REQUEST_PATTERN = /(?:你(?:自己看着|看着办|来定|来安排|决定|安排|处理|发挥)|自行判断|帮我(?:处理|安排|搞)|看着办)/u;
const SCHEDULING_REQUEST_PATTERN = /(?:定时|cron|schedule|稍后|晚点|到点|每(?:天|周|月|年)|提醒|几分钟后|几小时后|明天|后天)/iu;
const MULTIMODAL_TOOL_SET = new Set(['vision', 'read_video', 'read_audio', 'read_file', 'draw', 'banana_draw']);
const PARAM_REQUIRED_BY_TOOL: Record<string, string[]> = {
    weather: ['location'],
    draw: ['prompt'],
    vision: ['imagePath'],
    read_video: ['path'],
    read_audio: ['path'],
    read_file: ['path'],
    search_web: ['query'],
    web_research: ['query'],
    cron_scheduler: ['action'],
    blog_article: ['action'],
};

function hasUsefulValue(value: unknown): boolean {
    if (typeof value === 'string') {
        return value.trim().length > 0;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return true;
    }

    if (Array.isArray(value)) {
        return value.length > 0;
    }

    return value !== undefined && value !== null;
}

function countAttachedMedia(message: FormattedMessage): number {
    return (message.images?.length || 0)
        + (message.videos?.length || 0)
        + (message.records?.length || 0)
        + (message.files?.length || 0)
        + (message.reply ? 1 : 0);
}

function hasMissingCriticalParams(step: TaskStep): boolean {
    if (!step.tool) return false;

    const requiredKeys = PARAM_REQUIRED_BY_TOOL[step.tool] || [];
    if (requiredKeys.length === 0) return false;

    const params = step.params || {};
    return requiredKeys.some((key) => !hasUsefulValue(params[key]));
}

function isOpenEndedRequest(text: string): boolean {
    return OPEN_ENDED_REQUEST_PATTERN.test(text);
}

function isSchedulingRequest(text: string, steps: TaskStep[]): boolean {
    return SCHEDULING_REQUEST_PATTERN.test(text)
        || steps.some((step) => step.tool === 'cron_scheduler');
}

export function assessTaskExecution(
    plan: TaskPlan,
    message: FormattedMessage,
    history: FormattedMessage[] = [],
): TaskExecutionAssessment {
    const text = message.text?.trim() || '';
    const toolSteps = plan.steps.filter((step) => step.tool);
    const uniqueTools = new Set(toolSteps.map((step) => step.tool).filter(Boolean));
    const reasons: string[] = [];
    let score = 0;

    if (!plan.needsTool || toolSteps.length === 0) {
        return {
            executionMode: 'fast',
            complexity: {
                score: 0,
                reasons: ['无工具需求，走快速闲聊链路'],
            },
        };
    }

    if (uniqueTools.size >= 2) {
        score += 2;
        reasons.push(`涉及 ${uniqueTools.size} 个工具`);
    }

    const dependentStepCount = toolSteps.filter((step) => (step.dependsOn?.length || 0) > 0).length;
    if (dependentStepCount > 0) {
        score += 3;
        reasons.push(`存在 ${dependentStepCount} 个依赖步骤`);
    }

    const missingParamCount = toolSteps.filter(hasMissingCriticalParams).length;
    if (missingParamCount > 0) {
        score += 2;
        reasons.push(`有 ${missingParamCount} 个步骤缺关键参数`);
    }

    if (isOpenEndedRequest(text)) {
        score += 2;
        reasons.push('用户要求机器人自主决定执行方式');
    }

    if (isSchedulingRequest(text, toolSteps)) {
        score += 2;
        reasons.push('涉及定时或稍后执行');
    }

    const mediaCount = countAttachedMedia(message);
    if (mediaCount > 0 && toolSteps.some((step) => step.tool && MULTIMODAL_TOOL_SET.has(step.tool))) {
        score += 1;
        reasons.push('多模态输入需要结合媒体理解');
    }

    if (history.length >= 6) {
        score += 1;
        reasons.push('需要较多历史上下文');
    }

    if (plan.confidence < 0.65) {
        score += 1;
        reasons.push(`路由置信度偏低 (${plan.confidence.toFixed(2)})`);
    }

    const executionMode: TaskExecutionMode = score >= REACT_SCORE_THRESHOLD ? 'react' : 'fast';

    if (reasons.length === 0) {
        reasons.push('单工具且参数明确，走快速工具链路');
    }

    return {
        executionMode,
        complexity: {
            score,
            reasons,
        },
    };
}

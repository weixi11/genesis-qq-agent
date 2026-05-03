/**
 * Plan Router Agent (任务规划器)
 * 
 * 职责：
 * - 接收哨兵通过的消息
 * - 使用 LLM 生成结构化任务计划 (TaskPlan)
 * - 规划执行步骤和工具选择
 * 
 * 输出：
 * - TaskPlan: 包含 goal, steps, needsTool, speakStyle 等
 */

import { log } from '../logger.js';
import { config } from '../config.js';
import { routerLlm } from '../llm.js';
import { buildRouterSystemPrompt, buildRouterUserPrompt } from '../prompts/router.js';
import type { FormattedMessage, TaskPlan, TaskStep } from '../types.js';
import type { EmotionResult } from '../emotion.js';
import { safeParseLLMJson } from '../utils/json.js';
import { getPersonaAppearance, getPersonaDisplayName, isSelfReferenceDrawRequest } from '../utils/personaLoader.js';
import {
    extractAudios,
    extractFiles,
    extractHistoryAudios,
    extractHistoryImages,
    extractHistoryVideos,
    extractImages,
    extractVideos,
} from '../utils/media.js';
import { toolRegistry } from '../services/tool_registry.js';
import { mediaTracker } from '../services/media_tracker.js';
import { assessTaskExecution } from '../services/execution_mode.js';
import { markImagePromptForResolution } from '../services/image_prompt_resolver.js';
import { config as bananaDrawConfig } from '../tools/banana_draw/config.js';
import { z } from 'zod';

/** Plan 结果 */
export interface PlanResult {
    /** 生成的任务计划 */
    plan: TaskPlan;
    /** 分发目标 Agent（向后兼容） */
    target: 'persona' | 'tech';
    /** LLM 原始输出（调试用） */
    rawOutput?: string;
}

/** 上下文信息 */
export interface RouterContext {
    message: FormattedMessage;
    history: FormattedMessage[];
    emotion?: EmotionResult | null;
}

const routerPlanStepSchema = z.object({
    id: z.string().optional(),
    action: z.string().min(1),
    tool: z.string().optional(),
    params: z.record(z.unknown()).optional(),
    dependsOn: z.array(z.string()).optional(),
});

const routerPlanResponseSchema = z.object({
    goal: z.string().optional(),
    needsTool: z.boolean().optional(),
    steps: z.array(routerPlanStepSchema).optional(),
    speakStyle: z.string().optional(),
    confidence: z.number().optional(),
    reasoning: z.string().optional(),
});

/**
 * Plan Router Agent
 */
export class PlanRouter {
    private isExplicitBananaKeyword(text: string): boolean {
        return /(?:^|\s)(?:banana|banana_draw)(?:\s|$)|香蕉画图|用banana|拿banana|banana来|banana画|banana生成/iu.test(text);
    }

    private isDrawIntent(text: string): boolean {
        return /画|绘制|生成.*图|做个图|来张图|出一张图/u.test(text);
    }

    private shouldPreferRulePlan(rulePlan: PlanResult): boolean {
        const { plan } = rulePlan;
        if (plan.reasoning?.includes('头像参考绘图')) {
            return plan.executionMode === 'fast' && plan.confidence >= 0.7 && plan.steps.length <= 3;
        }
        return plan.executionMode === 'fast'
            && plan.confidence >= 0.66
            && plan.steps.length <= 1;
    }

    private getTargetAvatarDrawUserId(message: FormattedMessage, text: string): number | null {
        if (isSelfReferenceDrawRequest(text)) {
            return null;
        }

        const botIds = new Set([
            Number(message.self_id || 0),
            Number(config.botQQ || 0),
        ].filter(id => Number.isFinite(id) && id > 0));

        const validAtUsers = (message.at_users || [])
            .map(id => Number(id))
            .filter(id => Number.isFinite(id) && id > 0 && !botIds.has(id));

        if (validAtUsers.length === 0) {
            return null;
        }

        return validAtUsers[0];
    }

    private createTargetAvatarDrawPlan(ctx: RouterContext, targetId: number, userText: string): PlanResult {
        return this.createToolPlan(
            ctx,
            '参考被@用户头像生成图片',
            [
                {
                    id: 'step1',
                    action: '获取被@用户头像链接',
                    tool: 'avatar',
                    params: { targetId: String(targetId), action: 'describe' },
                },
                {
                    id: 'step2',
                    action: '分析头像内容类型',
                    tool: 'vision',
                    params: {
                        imageUrl: '${step1.data.avatarUrl}',
                        question: '客观描述这个头像的可见主体、场景、风格、颜色和构图。只描述可见内容；如果不是人物或明确角色，请说明它更适合作为场景、背景、物品或风格参考。',
                    },
                    dependsOn: ['step1'],
                },
                {
                    id: 'step3',
                    action: '根据头像参考生成图片',
                    tool: 'banana_draw',
                    params: markImagePromptForResolution({
                        imageUrl: '${step1.data.avatarUrl}',
                        prompt: `${userText}\n头像识别结果: \${step2.text}\nUse the avatar as a visual reference. If it clearly contains a person or character, preserve the visible appearance cues. If it is scenery, object, logo, abstract image, or unclear, use it only as background/theme/style inspiration and do not invent it as the user's face.`,
                        preserveIdentity: false,
                    }),
                    dependsOn: ['step1', 'step2'],
                },
            ],
            0.74,
            '规则匹配: 头像参考绘图',
        );
    }

    private finalizePlanResult(plan: TaskPlan, ctx: RouterContext, rawOutput?: string): PlanResult {
        const assessment = assessTaskExecution(plan, ctx.message, ctx.history);
        const executionMode = plan.reasoning?.includes('头像参考绘图') ? 'fast' : assessment.executionMode;
        const enrichedPlan: TaskPlan = {
            ...plan,
            executionMode,
            complexity: assessment.complexity,
        };
        const target = enrichedPlan.needsTool && enrichedPlan.steps.some(s => s.tool) ? 'tech' : 'persona';

        log.info(
            `📋 Plan: ${enrichedPlan.goal} [${(enrichedPlan.confidence * 100).toFixed(0)}%] `
            + `${enrichedPlan.reasoning || ''} mode=${executionMode} score=${assessment.complexity.score}`,
        );
        if (enrichedPlan.steps.length > 0) {
            log.debug(`   Steps: ${enrichedPlan.steps.map(s => s.tool || s.action).join(' → ')}`);
        }
        if (assessment.complexity.reasons.length > 0) {
            log.debug(`   Complexity: ${assessment.complexity.reasons.join(' | ')}`);
        }

        return { plan: enrichedPlan, target, rawOutput };
    }

    private detectMemeScene(text: string): string | undefined {
        if (/主人|护主|别欺负主人/.test(text)) return 'owner';
        if (/生气|警告|不许|别惹|炸毛/.test(text)) return 'angry';
        if (/疑问|问号|懵|迷惑|震惊/.test(text)) return 'question';
        if (/安慰|抱抱|摸摸|哄哄|别难过/.test(text)) return 'comfort';
        if (/日常|可爱/.test(text)) return 'daily';
        return undefined;
    }

    private detectBananaMode(text: string): 'figurine' | 'comic' | 'selfie' | 'auto' {
        if (/手办化|手办/u.test(text)) return 'figurine';
        if (/四格漫画|四格|漫画/u.test(text)) return 'comic';
        if (/自拍化|自拍|真人自拍/u.test(text)) return 'selfie';
        return 'auto';
    }

    private extractWeatherLocation(text: string): string | null {
        const explicitMatch = text.match(/(?:今天|明天|后天)?([A-Za-z\u4e00-\u9fa5]{2,20}?)(?:的)?天气/);
        if (explicitMatch?.[1]) {
            const location = explicitMatch[1].trim();
            if (location.length >= 2 && !['查询', '查看', '一下', '现在'].includes(location)) {
                return location;
            }
        }

        return null;
    }

    private createRuleBasedPlan(ctx: RouterContext): PlanResult | null {
        const { message, history } = ctx;
        const text = message.text?.trim() || '';
        if (!text) {
            return null;
        }

        const hasWeatherIntent = /天气|气温|下雨|下雪|晴天|阴天/.test(text);
        if (hasWeatherIntent && toolRegistry.isToolEnabled('weather')) {
            const location = this.extractWeatherLocation(text);
            if (location) {
                return this.createToolPlan(
                    ctx,
                    `查询${location}天气`,
                    [{ id: 'step1', action: `查询${location}天气`, tool: 'weather', params: { location } }],
                    0.72,
                    '规则匹配: 天气查询',
                );
            }
        }

        const imagePath = extractImages(message)[0] || extractHistoryImages(history);
        const bananaMode = this.detectBananaMode(text);
        const explicitBanana = this.isExplicitBananaKeyword(text);
        const hasDrawIntent = this.isDrawIntent(text);
        const bananaEnabled = toolRegistry.isToolEnabled('banana_draw');
        const drawEnabled = toolRegistry.isToolEnabled('draw');
        const shouldUseBanana = bananaEnabled && (
            bananaMode !== 'auto'
            || (explicitBanana && (hasDrawIntent || Boolean(imagePath)))
            || (bananaDrawConfig.preferForTextToImage && hasDrawIntent)
            || (hasDrawIntent && !drawEnabled)
        );

        const targetAvatarUserId = this.getTargetAvatarDrawUserId(message, text);
        if (
            hasDrawIntent
            && targetAvatarUserId
            && bananaEnabled
            && toolRegistry.isToolEnabled('avatar')
            && toolRegistry.isToolEnabled('vision')
        ) {
            return this.createTargetAvatarDrawPlan(ctx, targetAvatarUserId, text);
        }

        if (shouldUseBanana) {
            const selfReference = isSelfReferenceDrawRequest(text);
            const reason = bananaMode !== 'auto'
                ? `规则匹配: Banana ${bananaMode} 请求`
                : explicitBanana
                    ? '规则匹配: 显式指定 Banana 绘图'
                    : drawEnabled
                        ? '规则匹配: Banana 普通文生图优先'
                        : '规则匹配: draw 已关闭，使用 Banana 绘图兜底';
            return this.createToolPlan(
                ctx,
                imagePath ? '使用 Banana 工具处理参考图' : '使用 Banana 工具生成图片',
                [{
                    id: 'step1',
                    action: imagePath ? '使用 Banana 工具改图' : '使用 Banana 工具绘图',
                    tool: 'banana_draw',
                    params: markImagePromptForResolution(
                        {
                            ...(bananaMode === 'auto' ? { prompt: text } : { prompt: text, mode: bananaMode }),
                            ...(selfReference ? { selfReference: true } : {}),
                        },
                    ),
                }],
                0.72,
                selfReference ? `${reason}；自引用绘图请求` : reason,
            );
        }

        if (hasDrawIntent && drawEnabled) {
            const selfReference = isSelfReferenceDrawRequest(text);
            return this.createToolPlan(
                ctx,
                '根据用户描述进行绘图',
                [{
                    id: 'step1',
                    action: selfReference ? '生成机器人自画像' : '生成图片',
                    tool: 'draw',
                    params: selfReference
                        ? { prompt: text, selfReference: true }
                        : markImagePromptForResolution({ prompt: text }),
                }],
                0.66,
                selfReference ? '规则匹配: 自引用绘图请求' : '规则匹配: 绘图请求',
            );
        }

        const hasMemeIntent = /(表情包|斗图|表情)/.test(text) && /(发|来|整|回|给我|丢|甩)/.test(text);
        if (hasMemeIntent && toolRegistry.isToolEnabled('meme_send')) {
            const scene = this.detectMemeScene(text);
            return this.createToolPlan(
                ctx,
                '发送合适的表情包',
                [{
                    id: 'step1',
                    action: '发送表情包',
                    tool: 'meme_send',
                    params: scene ? { query: text, scene } : { query: text },
                }],
                0.72,
                scene ? `规则匹配: 表情包请求 (${scene})` : '规则匹配: 表情包请求',
            );
        }

        const videoPath = extractVideos(message)[0] || extractHistoryVideos(history);
        const audioPath = extractAudios(message)[0] || extractHistoryAudios(history);
        const filePath = extractFiles(message)[0];

        const hasImageIntent = /(图|图片|照片|截图|pdf)/i.test(text) && /(看|分析|识别|描述|内容|是什么|啥)/.test(text);
        if (hasImageIntent && imagePath && toolRegistry.isToolEnabled('vision')) {
            return this.createToolPlan(
                ctx,
                '分析图片或 PDF 内容',
                [{ id: 'step1', action: '识别图片内容', tool: 'vision', params: { imagePath, question: text } }],
                0.7,
                '规则匹配: 图片/PDF 分析',
            );
        }

        const hasVideoIntent = /(视频|录像)/.test(text) && /(看|分析|识别|内容|是什么|啥)/.test(text);
        if (hasVideoIntent && videoPath && toolRegistry.isToolEnabled('read_video')) {
            return this.createToolPlan(
                ctx,
                '分析视频内容',
                [{ id: 'step1', action: '读取视频内容', tool: 'read_video', params: { path: videoPath, question: text } }],
                0.7,
                '规则匹配: 视频分析',
            );
        }

        const hasAudioIntent = /(语音|音频|录音)/.test(text) && /(听|分析|识别|内容|说了啥|说了什么|是什么)/.test(text);
        if (hasAudioIntent && audioPath && toolRegistry.isToolEnabled('read_audio')) {
            return this.createToolPlan(
                ctx,
                '分析音频内容',
                [{ id: 'step1', action: '读取音频内容', tool: 'read_audio', params: { path: audioPath, question: text } }],
                0.7,
                '规则匹配: 音频分析',
            );
        }

        const hasFileIntent = /(文件|文档|表格|代码|txt|md|doc|docx|xls|xlsx|json|csv)/i.test(text)
            && /(看|分析|读取|总结|内容|是什么|啥)/.test(text);
        if (hasFileIntent && filePath && toolRegistry.isToolEnabled('read_file')) {
            return this.createToolPlan(
                ctx,
                '分析文档内容',
                [{ id: 'step1', action: '读取文件内容', tool: 'read_file', params: { path: filePath, question: text } }],
                0.68,
                '规则匹配: 文件分析',
            );
        }

        return null;
    }

    /**
     * 生成 LLM 规划系统提示
     */
    private getPlanPrompt(): string {
        const briefs = toolRegistry.getBriefs();
        const disabledTools = toolRegistry.getDisabledNames();
        const toolList = briefs.map(b => `- ${b.name}: ${b.description}`).join('\n');
        return buildRouterSystemPrompt({ toolList, disabledTools });
    }

    /**
     * 生成任务计划
     */
    async plan(ctx: RouterContext): Promise<PlanResult> {
        const { message, history } = ctx;
        const text = message.text?.trim() || '';

        // 空消息或纯媒体消息 -> 默认闲聊计划
        if (!text && (message.images?.length > 0)) {
            return this.createChatPlan(ctx, '用户发送了图片', '纯图片消息', 0.7);
        }
        if (!text) {
            return this.createChatPlan(ctx, '空消息', '空消息', 0.5);
        }

        const rulePlan = config.agents.routerRuleMatchEnabled
            ? this.createRuleBasedPlan(ctx)
            : null;

        if (rulePlan && this.shouldPreferRulePlan(rulePlan)) {
            log.info(
                `📋 Plan: ${rulePlan.plan.goal} [${(rulePlan.plan.confidence * 100).toFixed(0)}%] `
                + `${rulePlan.plan.reasoning || ''} (规则高置信直通，跳过 Router LLM)`,
            );
            return rulePlan;
        }

        if (config.agents.routerLlmEnabled) {
            try {
                const userPrompt = await this.buildUserPrompt(message, history);
                const response = await routerLlm.ask(userPrompt, this.getPlanPrompt(), 'router');
                const llmPlan = this.parseResponse(response, text, ctx);

                if (llmPlan) {
                    return llmPlan;
                }

                if (rulePlan) {
                    log.info(`📋 Plan: ${rulePlan.plan.goal} [${(rulePlan.plan.confidence * 100).toFixed(0)}%] ${rulePlan.plan.reasoning || ''} (LLM 解析失败后规则兜底)`);
                    return rulePlan;
                }

                log.info('📋 Plan: 默认闲聊 [50%] (LLM 解析失败且无规则命中)');
                return this.createChatPlan(ctx, '理解用户意图', 'LLM parse failed and no rule matched', 0.5, response);
            } catch (err) {
                if (rulePlan) {
                    log.warn('Plan Router LLM 调用失败，使用规则兜底:', err);
                    log.info(`📋 Plan: ${rulePlan.plan.goal} [${(rulePlan.plan.confidence * 100).toFixed(0)}%] ${rulePlan.plan.reasoning || ''} (LLM 调用失败后规则兜底)`);
                    return rulePlan;
                }

                log.warn('Plan Router LLM 调用失败，使用默认计划:', err);
                return this.createChatPlan(ctx, '理解用户意图', 'LLM failed and no rule matched', 0.5);
            }
        }

        if (rulePlan) {
            log.info(`📋 Plan: ${rulePlan.plan.goal} [${(rulePlan.plan.confidence * 100).toFixed(0)}%] ${rulePlan.plan.reasoning || ''} (LLM 已禁用，规则命中)`);
            return rulePlan;
        }

        log.info('📋 Plan: 默认闲聊 [40%] (Router LLM 已禁用且无规则命中)');
        return this.createChatPlan(ctx, '理解用户意图', 'Router LLM disabled and no rule matched', 0.4);
    }

    /**
     * 构建 LLM 用户提示
     */
    private async buildUserPrompt(msg: FormattedMessage, history: FormattedMessage[]): Promise<string> {
        const atIds = msg.at_users || [];
        const messageText = msg.text?.trim() || '';
        const isSelfDraw = isSelfReferenceDrawRequest(messageText);

        // 获取会话key
        const sessionKey = msg.type === 'group' && msg.group_id
            ? `group:${msg.group_id}`
            : `private:${msg.sender_id}`;

        // 获取媒体上下文（最近20条媒体记录）
        const mediaContext = mediaTracker.formatForPrompt(sessionKey, 20);

        let historyText: string | undefined;
        if (history.length > 0) {
            const { memory } = await import('../memory.js');
            const formattedHistory = memory.formatMessages(history);
            historyText = formattedHistory && formattedHistory !== '(空)' ? formattedHistory : undefined;
        }

        return buildRouterUserPrompt({
            messageText: msg.text,
            senderId: msg.sender_id,
            senderName: msg.sender_name,
            atIds,
            mediaContext: mediaContext || undefined,
            historyText,
            selfDrawContext: isSelfDraw
                ? {
                    botName: getPersonaDisplayName(),
                    appearance: getPersonaAppearance(),
                }
                : undefined,
        });
    }

    /**
     * 解析 LLM 响应
     */
    private parseResponse(response: string, originalText: string, ctx: RouterContext): PlanResult | null {
        try {
            const rawData = safeParseLLMJson<unknown>(response);
            const parsed = routerPlanResponseSchema.safeParse(rawData);

            if (parsed.success) {
                const data = parsed.data;
                // 标准化 steps
                const steps: TaskStep[] = (data.steps || []).map((s, i) => ({
                    id: s.id || `step${i + 1}`,
                    action: s.action,
                    tool: s.tool,
                    params: s.params,
                    dependsOn: s.dependsOn,
                }));

                const plan: TaskPlan = {
                    goal: data.goal || originalText,
                    needsTool: data.needsTool ?? false,
                    steps,
                    speakStyle: data.speakStyle,
                    confidence: Math.min(1, Math.max(0, data.confidence || 0.7)),
                    reasoning: data.reasoning,
                };

                return this.finalizePlanResult(plan, ctx, response);
            }

            if (rawData) {
                log.debug(`Plan Router schema 校验失败: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
            }
        } catch (err) {
            log.debug('Plan Router 解析响应失败:', err);
        }

        return null;
    }

    /**
     * 创建闲聊计划
     */
    private createChatPlan(
        ctx: RouterContext,
        goal: string,
        reasoning: string,
        confidence: number,
        rawOutput?: string,
    ): PlanResult {
        return this.finalizePlanResult({
            goal,
            needsTool: false,
            steps: [],
            confidence,
            reasoning,
        }, ctx, rawOutput);
    }

    /**
     * 创建工具计划
     */
    private createToolPlan(
        ctx: RouterContext,
        goal: string,
        steps: TaskStep[],
        confidence: number,
        reasoning: string,
        speakStyle?: string
    ): PlanResult {
        return this.finalizePlanResult({
            goal,
            needsTool: true,
            steps,
            speakStyle,
            confidence,
            reasoning,
        }, ctx);
    }
}

// 全局单例
export const router = new PlanRouter();

import { config } from '../config.js';
import { log } from '../logger.js';
import { reactLlm } from '../llm.js';
import type { FormattedMessage } from '../types.js';
import type { EmotionResult } from '../emotion.js';
import type { ChatMessage } from '../llm.js';
import { toolRegistry } from '../services/tool_registry.js';
import { executeModule, buildModuleContext } from '../tools/index.js';
import type { ToolResult } from './tech.js';
import { extractVideos, extractAudios, extractFiles } from '../utils/media.js';
import { toolStats } from '../web/store/tool_stats.js';
import type { MessageSegment } from '../utils/message.js';
import type { FileAttachment } from '../utils/file_attachment.js';
import { mediaTracker } from '../services/media_tracker.js';
import { getProfileAsync } from '../profiler/store.js';
import { getCachedPersona, getPersonaAppearance, getPersonaDisplayName } from '../utils/personaLoader.js';
import { isInternalSelfReferenceDrawKey, normalizeSelfReferenceDrawParams } from '../utils/selfReferenceDraw.js';
import { memory } from '../memory.js';
import { taskManager } from '../task/index.js';
import { buildTaskCacheScope } from '../task/cache-scope.js';
import { maybeSendPendingReplyForTools } from '../services/pending_reply.js';

const MAX_SCHEDULING_RETRIES = 2;
const SCHEDULING_KEYWORD_PATTERN = /(?:定时|cron|schedule|稍后|晚点|到点|每(?:天|周|月|年)|提醒)/iu;
const SCHEDULING_TIME_PATTERN = /(?:(?:\d+|[零一二两三四五六七八九十百千万半几数]+)\s*(?:秒钟?|分钟|小时|天|周|个月|年)后|明天|后天|今晚|今夜|明早|明晚|下午|晚上|凌晨|中午|下周|下个月)/u;
const SCHEDULING_ACTION_PATTERN = /(?:发布|发文|发博客|发一篇博客|发送|推送|执行|安排|创建任务|自动|提醒我|提醒一下)/u;
const SELF_DRAW_PROMPT_SYSTEM_PROMPT = `You write final image-generation prompts for the bot's self portrait.

Rules:
1. Output a single final English prompt only.
2. Use concise English tags and short English phrases that are friendly to anime image models.
3. Preserve the bot's visual identity anchors from the persona appearance reference.
4. Merge the user's requested scene, action, framing, mood, clothing, and style into the final prompt.
5. Use the persona reference as guidance; do not copy it verbatim or include non-visual lore, account IDs, ownership, or group identity.
6. Do not explain. Do not output JSON. Do not output Chinese.`;

function extractIntentText(message: FormattedMessage): string {
    return [message.text, message.summary]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n');
}

function buildSchedulingContextText(message: FormattedMessage, history: FormattedMessage[]): string {
    const botQQ = config.botQQ;
    const recentSameSenderText = history
        .filter((item) => item.sender_id === message.sender_id && item.sender_id !== botQQ)
        .slice(-3)
        .map((item) => extractIntentText(item))
        .filter((value) => value.length > 0);

    const currentText = extractIntentText(message);
    return [...recentSameSenderText, currentText].join('\n').replace(/\s+/g, '');
}

function isSchedulingIntent(text: string): boolean {
    if (!text) return false;
    if (SCHEDULING_KEYWORD_PATTERN.test(text)) return true;
    return SCHEDULING_TIME_PATTERN.test(text) && SCHEDULING_ACTION_PATTERN.test(text);
}

function buildSchedulingRetryPrompt(): string {
    return [
        '检测到当前请求属于“定时/稍后执行”的真实操作。',
        '你刚才没有调用任何工具，所以任务实际上还没有创建。',
        '禁止在未实际调用工具前声称“已设置”“已创建”“已就绪”“会自动发布”。',
        '请二选一：',
        '1. 如果信息足够，必须调用 cron_scheduler 创建任务；如需补齐博客分类/标签等参数，可先调用 blog_category / blog_tag，再安排 blog_article。',
        '2. 如果信息不足，只能明确说明“尚未创建任务”，并指出缺少哪些字段。',
    ].join('\n');
}

interface SchedulingGuardOutcome {
    kind: 'pass' | 'continue' | 'return';
    retryCount?: number;
    followUps?: ChatMessage[];
    result?: ToolResult;
}

function handleSchedulingTextGuard(params: {
    requiresSchedulingTool: boolean;
    toolNames: string[];
    retryCount: number;
    text: string;
    finalSegments: MessageSegment[];
    finalFiles: FileAttachment[];
    finalData: Record<string, unknown>;
    finalParams: Record<string, unknown>;
    toolParamsList: Array<{ name: string; params: Record<string, unknown> }>;
}): SchedulingGuardOutcome {
    if (!params.requiresSchedulingTool || params.toolNames.length > 0) {
        return { kind: 'pass' };
    }

    if (params.retryCount < MAX_SCHEDULING_RETRIES) {
        const nextRetryCount = params.retryCount + 1;
        log.warn(`🧠 ReAct: 检测到定时意图但未调用工具，要求模型重试 (${nextRetryCount}/${MAX_SCHEDULING_RETRIES})`);
        return {
            kind: 'continue',
            retryCount: nextRetryCount,
            followUps: [
                {
                    role: 'assistant',
                    content: params.text,
                },
                {
                    role: 'system',
                    content: buildSchedulingRetryPrompt(),
                },
            ],
        };
    }

    return {
        kind: 'return',
        result: {
            tool: 'none',
            toolNames: params.toolNames,
            success: true,
            text: '意图：检测到这是一个需要定时执行的真实操作，但当前尚未成功调用 cron_scheduler，因此任务实际上还没有创建。必须明确告诉用户任务未创建成功，并说明需要重新尝试或补充必要信息。',
            segments: params.finalSegments.length > 0 ? params.finalSegments : undefined,
            files: params.finalFiles.length > 0 ? params.finalFiles : undefined,
            data: params.finalData,
            params: params.finalParams,
            toolParams: params.toolParamsList,
        },
    };
}

export class ReActAgent {
    private async resolveSelfReferenceDrawParams(
        params: Record<string, unknown>,
        userText: string,
    ): Promise<Record<string, unknown>> {
        return normalizeSelfReferenceDrawParams({
            params,
            userText,
            stage: '🧠 ReAct',
            appearance: typeof params.botAppearance === 'string' ? params.botAppearance : getPersonaAppearance(),
            personaName: getPersonaDisplayName(),
            composePrompt: async ({ appearance, personaName, originalPrompt, missingAnchors, retry }) => reactLlm.chat([
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
            }, 'react_self_draw_prompt'),
        });
    }

    async handle(
        message: FormattedMessage,
        history: FormattedMessage[],
        emotion: EmotionResult | null
    ): Promise<ToolResult> {
        log.info(`🧠 ReAct Agent: 开始处理用户请求`);

        // 1. 获取所有可用的工具 Schema
        const schemas = toolRegistry.getSchemas();
        if (schemas.length === 0) {
            log.warn('⚠️ ReAct: 没有可用的工具');
            return { tool: 'none', success: true, text: '' };
        }

        // 2. 构建初始系统 Prompt 和上下文
        const messages: ChatMessage[] = [];
        messages.push({
            role: 'system',
            content: this.getSystemPrompt()
        });

        // 拼接历史对话
        if (history && history.length > 0) {
            const historyText = memory.formatMessages(history);
            if (historyText && historyText !== '(空)') {
                messages.push({
                    role: 'system',
                    content: `[最近对话上下文]\n${historyText}`
                });
            }
        }

        // 获取会话媒体记录
        const sessionKey = message.type === 'group' && message.group_id
            ? `group:${message.group_id}`
            : `private:${message.sender_id}`;
        const mediaContext = mediaTracker.formatForPrompt(sessionKey, 20);

        let userContent = `用户消息: "${message.text || ''}"\n`;
        userContent += `- SENDER_ID: ${message.sender_id}\n`;
        userContent += `- SENDER_NAME: ${message.sender_name}\n`;

        if (message.sender_id === config.masterQQ) {
            userContent += `- 特殊身份: 主人 (最高优先级，绝对服从)\n`;
        }

        // 加载该用户的画像与好感度，用于更智能的决策
        const profile = getProfileAsync(message.sender_id);
        if (profile) {
            userContent += `\n## 发送者（用户）画像摘要\n`;
            userContent += `- 称呼/昵称: ${profile.nickname}\n`;
            userContent += `- 相对好感度: ${profile.favorability} (影响你决定是否同意某些请求)\n`;
            userContent += `- 兴趣爱好: ${profile.interests.join(',')}\n`;
            userContent += `- 特征/印象: ${profile.traits.join(',')}\n`;
        }

        if (emotion) {
            userContent += `\n## 当前情绪判断\n- ${emotion.sentiment} (Valence: ${emotion.valence.toFixed(2)}, Arousal: ${emotion.arousal.toFixed(2)})\n`;
        }

        if (mediaContext) {
            userContent += `\n## 会话媒体记录\n${mediaContext}`;
        }

        // 方案一：注入当前会话中正在执行的任务，防止 LLM 误判/重复调用
        const runningTasks = taskManager.getRunningTasksForSession(sessionKey, message.sender_id);
        if (runningTasks.length > 0) {
            userContent += `\n## ⚠️ 当前正在执行的后台任务（请勿重复执行）\n`;
            for (const t of runningTasks) {
                const elapsed = Date.now() - (t.startedAt || t.createdAt);
                const paramStr = Object.entries(t.params)
                    .filter(([k]) => !isInternalSelfReferenceDrawKey(k))
                    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 50) : JSON.stringify(v).slice(0, 50)}`)
                    .join(', ');
                userContent += `- 工具: ${t.toolName}(${paramStr}), 状态: ${t.status}, 已耗时: ${Math.round(elapsed / 1000)}s\n`;
            }
            userContent += `注意：以上任务正在后台执行中，不要重复调用相同的工具。如果用户询问相关话题，在意图中告知该任务正在处理中即可。\n`;
        }

        messages.push({
            role: 'user',
            content: userContent
        });

        const SAFETY_MAX_TURNS = 20;
        let turn = 0;

        const finalSegments: MessageSegment[] = [];
        const finalFiles: FileAttachment[] = [];
        let finalData: Record<string, unknown> = {};
        let finalParams: Record<string, unknown> = {};
        const toolNames: string[] = [];
        const toolParamsList: Array<{ name: string; params: Record<string, unknown> }> = [];

        // 工具连续失败计数器：toolName -> 连续失败次数
        const toolFailureCount = new Map<string, number>();
        // 已被禁用的工具集合（连续失败 3 次）
        const disabledTools = new Set<string>();
        const schedulingContextText = buildSchedulingContextText(message, history);
        const requiresSchedulingTool = isSchedulingIntent(schedulingContextText);
        let schedulingRetryCount = 0;

        // 3. 开始 ReAct 循环（无硬性轮次限制，由 LLM 自行决定何时输出文本结束）
        while (turn < SAFETY_MAX_TURNS) {
            turn++;
            log.debug(`🧠 ReAct Turn ${turn} 开始...`);

            // 过滤掉已被禁用的工具
            const availableSchemas = schemas.filter(s => !disabledTools.has(s.name));

            try {
                const result = await reactLlm.chatWithTools(messages, availableSchemas, {}, 'ReActAgent');

                if (result.type === 'text') {
                    const schedulingGuard = handleSchedulingTextGuard({
                        requiresSchedulingTool,
                        toolNames,
                        retryCount: schedulingRetryCount,
                        text: result.content,
                        finalSegments,
                        finalFiles,
                        finalData,
                        finalParams,
                        toolParamsList,
                    });
                    if (schedulingGuard.kind === 'continue') {
                        schedulingRetryCount = schedulingGuard.retryCount ?? schedulingRetryCount;
                        for (const followUp of schedulingGuard.followUps ?? []) {
                            messages.push(followUp);
                        }
                        continue;
                    }
                    if (schedulingGuard.kind === 'return' && schedulingGuard.result) {
                        return schedulingGuard.result;
                    }

                    // LLM 决定直接输出文本（总结思考结果）
                    log.info(`🧠 ReAct 循环结束 (Turn ${turn})，输出文本: ${result.content.slice(0, 50)}...`);
                    return {
                        tool: toolNames[0] || 'none',
                        toolNames,
                        success: true,
                        text: result.content,
                        segments: finalSegments.length > 0 ? finalSegments : undefined,
                        files: finalFiles.length > 0 ? finalFiles : undefined,
                        data: finalData,
                        params: finalParams,
                        toolParams: toolParamsList
                    };
                } else if (result.type === 'tool_calls') {
                    // LLM 决定调用工具
                    const { toolCalls, message: assistantMessage } = result;

                    // 将 LLM 的回复记录到上下文中
                    messages.push(assistantMessage);

                    // 并发执行所有要求的工具
                    const toolPromises = toolCalls.map(async (tc) => {
                        const toolName = tc.name;
                        const args = await this.resolveSelfReferenceDrawParams(tc.arguments, message.text || '');
                        toolNames.push(toolName);
                        toolParamsList.push({ name: toolName, params: args });
                        finalParams = { ...finalParams, ...args };

                        // 执行工具
                        const toolResult = await this.executeToolLocally(toolName, args, message);

                        // 收集段落
                        if (toolResult.segments) {
                            finalSegments.push(...toolResult.segments);
                        }
                        if (toolResult.files) {
                            finalFiles.push(...toolResult.files);
                        }
                        if (toolResult.data && typeof toolResult.data === 'object') {
                            finalData = { ...finalData, ...toolResult.data };
                        }

                        return {
                            id: tc.id,
                            name: toolName,
                            resultText: toolResult.text || (toolResult.success ? 'Success' : 'Failed'),
                            success: toolResult.success
                        };
                    });

                    const executionResults = await Promise.all(toolPromises);

                    // 将工具执行结果作为 observation 追加回 messages
                    for (const res of executionResults) {
                        messages.push({
                            role: 'tool',
                            tool_call_id: res.id,
                            name: res.name,
                            content: res.resultText
                        });

                        // 追踪工具连续失败
                        if (!res.success) {
                            const count = (toolFailureCount.get(res.name) || 0) + 1;
                            toolFailureCount.set(res.name, count);

                            if (count >= 3 && !disabledTools.has(res.name)) {
                                disabledTools.add(res.name);
                                log.warn(`🧠 ReAct: 工具 ${res.name} 连续失败 ${count} 次，已禁用该工具`);
                                // 注入反思消息，告知 LLM 该工具不可用
                                messages.push({
                                    role: 'system',
                                    content: `⚠️ 工具 "${res.name}" 已连续失败 ${count} 次，判定为不可用，已从可用工具列表中移除。请不要再尝试调用该工具。请反思：1) 是否有替代工具可以完成同样的任务；2) 如果没有替代方案，请在最终输出中如实报告该工具执行失败的情况，并尽可能利用已有的其他工具结果来完成任务。`
                                });
                            }
                        } else {
                            // 成功则重置该工具的连续失败计数
                            toolFailureCount.set(res.name, 0);
                        }
                    }

                    // 如果所有可用工具都被禁用了，注入提示让 LLM 输出最终结果
                    if (disabledTools.size > 0 && disabledTools.size >= schemas.length) {
                        log.warn('🧠 ReAct: 所有工具均已被禁用，强制要求 LLM 输出总结');
                        messages.push({
                            role: 'system',
                            content: '所有工具均已因多次失败而被禁用。请立即根据已有的执行结果输出最终分析报告，并如实说明哪些工具出现了错误。'
                        });
                    }
                }
            } catch (err) {
                log.error(`🧠 ReAct 发生异常:`, err);
                return {
                    tool: toolNames[0] || 'none',
                    toolNames,
                    success: false,
                    text: `思考过程中发生错误: ${String(err)}`
                };
            }
        }

        // 安全兜底：达到安全上限时，让 LLM 做最终总结
        log.warn(`🧠 ReAct: 达到安全上限 ${SAFETY_MAX_TURNS} 轮，强制总结`);
        messages.push({
            role: 'system',
            content: '你已达到最大思考轮次，无法再调用任何工具。请立即根据已有的所有工具执行结果和观察，输出一份完整的最终分析报告/意图指示。如有工具执行失败，请如实报告。'
        });

        try {
            const summary = await reactLlm.chat(messages, {}, 'ReActAgent-FinalSummary');
            return {
                tool: toolNames[0] || 'none',
                toolNames,
                success: true,
                text: summary || '思考轮次已耗尽，未能生成总结。',
                segments: finalSegments.length > 0 ? finalSegments : undefined,
                files: finalFiles.length > 0 ? finalFiles : undefined,
                data: finalData,
                params: finalParams,
                toolParams: toolParamsList
            };
        } catch {
            return {
                tool: toolNames[0] || 'none',
                toolNames,
                success: true,
                text: '思考轮次已耗尽，总结时发生错误。',
                segments: finalSegments.length > 0 ? finalSegments : undefined,
                files: finalFiles.length > 0 ? finalFiles : undefined,
                data: finalData,
                params: finalParams,
                toolParams: toolParamsList
            };
        }
    }

    private getSystemPrompt(): string {
        const personaName = getPersonaDisplayName();
        const personaData = getCachedPersona();

        let personaContext = '';
        if (personaData) {
            personaContext += `\n【前端发声引擎详细人设】\n`;
            personaContext += `了解发声引擎 (${personaName}) 的设定和喜好，可以帮助你决定何时无需调用功能（例如纯闲聊时）、何时需要直接拒绝（例如用户要求做讨厌的事）：\n`;
            if (personaData.species) personaContext += `- 种族/类型: ${personaData.species}\n`;
            if (personaData.age) personaContext += `- 年龄: ${personaData.age}\n`;
            if (personaData.appearance) personaContext += `- 外貌锚点: ${personaData.appearance}\n`;
            if (personaData.clothing) personaContext += `- 服装锚点: ${personaData.clothing}\n`;
            if (personaData.features) personaContext += `- 额外外观特征: ${personaData.features}\n`;
            if (personaData.personality) personaContext += `- 性格: ${personaData.personality}\n`;
            if (personaData.likes && personaData.likes.length > 0) personaContext += `- 喜欢: ${personaData.likes.join('、')}\n`;
            if (personaData.dislikes && personaData.dislikes.length > 0) personaContext += `- 讨厌: ${personaData.dislikes.join('、')}\n`;
            if (personaData.attributes && Object.keys(personaData.attributes).length > 0) {
                personaContext += `- 其他设定:\n`;
                for (const [k, v] of Object.entries(personaData.attributes)) {
                    personaContext += `  * ${k}: ${v}\n`;
                }
            }
        }

        return `你是一个极致冷漠、纯凭逻辑驱动的智能体核心大脑 (Logical ReAct Engine)。
现在的会话对象正在与你的前端发声引擎" ${personaName} "对话。
你的任务是通过多轮 Function Calling 组合调用工具来解决用户的问题。
你需要结合【用户画像、群聊信息、你们之间的好感度以及历史媒体文件】来**判断是否应该调用工具、调用什么工具**。
${personaContext}
【极其重要的输出要求】
1. **纯粹的内部状态报告**：你的输出不是给用户的，而是给发声引擎(${personaName})的指令（Internal Intent）。
2. **绝对不要角色扮演**：禁止使用任何语气词（如"喵"、"哼"、"主人"）、禁止模拟对话、禁止使用颜文字或情感化表达。
3. **输出格式**：你的最终文本输出必须是包含**完整详细信息**的分析报告或动作指示，切忌只输出一句干瘪的摘要。
   举例说明：
   - [不好的输出]: "哼，真麻烦，让你们看一下今天的天气吧喵~" (太拟人化了，不要带语气词)
   - [绝佳的输出]: "意图：查询天气工具。当前洛阳天气晴，气温25°C，非常适宜出行，提醒用户注意防晒。" (实质内容完整汇报)
   - [不好的输出]: "意图：执行了点赞和查天气工具并准备汇报列表。" (内容空洞，发声引擎无法凭空捏造具体数据)
   - [绝佳的输出]: "意图：向主人汇报已执行了10次点赞、戳一戳，并查了北京天气(晴，-2°C)。当前所有工具技能完整列表为：1. draw(AI绘图) 2. weather(天气预报) 3. like(点赞)..." (必须把所有具体的信息、数据和列表直接且完整地写在意图里)
4. **禁止输出任何图片链接或URL**：在汇报结果时，不要把图片链接、本地文件路径或 URL 直接写在文本中发出来，直接提取或概括关键内容即可。
5. **真实副作用必须先执行再汇报**：凡是会改变外部状态的请求（如定时任务、发布博客、发送/删除/修改、群管理等），在没有实际调用工具并拿到结果前，禁止声称“已完成”“已设置”“已就绪”。
6. **定时请求必须优先考虑 cron_scheduler**：遇到“几分钟后/稍后/明天/定时/周期执行”这类未来执行请求时，如果信息足够，优先调用 cron_scheduler 创建任务；如果信息不足，只能说明“尚未创建任务”，不能假装已经安排好了。
7. **自画像绘图规则**：如果用户要“画你自己/画落落/自画像”，调用 draw 时必须让 params.prompt 直接成为最终英文绘图提示词，保留 selfReference: true，并设置 personaPromptResolved: true。不要只把中文原话直接塞进 prompt。

【核心原则】
1. 决策要符合上下文情绪：基于用户的好感度和身份决定工具的使用策略，如果遇到低好感度的恶意骚扰，可以决定不仅不使用工具，还在意图中指示发声引擎拒绝对方。
2. 传达实质内容：如果你需要向发声引擎传递特定信息（如说明你有什么工具技能、报告查询结果等），**必须**在输出的“意图”中将这些信息的具体细节完整写出来列出。发声引擎是一个没有任何后端的纯文本包装器，它只能根据你提供的内容进行润色。
3. 遇到媒体请求时，请参考前序上报的"会话媒体记录"里的本地路径直接调用相关识别工具，不要啰嗦。`;
    }

    private async executeToolLocally(
        toolName: string,
        params: Record<string, unknown>,
        message: FormattedMessage
    ): Promise<{ success: boolean; text: string; segments?: MessageSegment[]; files?: FileAttachment[]; data?: unknown }> {
        log.info(`🔧 ReAct: 调用工具 -> ${toolName}`);

        const currentImages = (message.images?.map(i => typeof i === 'string' ? i : (i.url || i.file || '')).filter(Boolean)) || [];
        const replyImages = (message.reply?.media?.images?.map(i => i.url || i.file || i.path || '').filter(Boolean)) || [];
        const currentVideos = extractVideos(message);
        const currentAudios = extractAudios(message);
        const currentFiles = extractFiles(message);
        const cacheScope = buildTaskCacheScope({
            sessionKey: message.type === 'group' && message.group_id
                ? `group:${message.group_id}`
                : `private:${message.sender_id}`,
            replyMessageId: message.reply?.message_id || null,
            atUsers: message.at_users,
            imageUrls: [...currentImages, ...replyImages],
            videoPaths: currentVideos,
            audioPaths: currentAudios,
            filePaths: currentFiles,
        });

        const matchedModule = toolRegistry.findByName(toolName);
        if (!matchedModule) {
            return { success: false, text: `Tool ${toolName} not found` };
        }

        // ==================== 工具级去重 ====================
        // 检查是否有相同任务正在执行或刚完成（防止并发 ReAct 循环重复调用）
        const cachedTask = taskManager.checkCache(message.sender_id, toolName, params, cacheScope);
        if (cachedTask) {
            if (cachedTask.status === 'pending' || cachedTask.status === 'running') {
                // 相同任务正在执行中，跳过
                log.info(`🔧 ReAct: 跳过重复工具调用 ${toolName} (${cachedTask.id.slice(0, 8)}) - 正在执行中`);
                return {
                    success: true,
                    text: `[${toolName} 已在执行中，无需重复调用，任务ID: ${cachedTask.id.slice(0, 8)}]`,
                };
            }
            if (cachedTask.status === 'success' && cachedTask.result) {
                // 相同任务刚完成且有缓存结果，直接返回
                log.info(`🔧 ReAct: 命中缓存 ${toolName} (${cachedTask.id.slice(0, 8)}) - 直接返回结果`);
                return {
                    success: cachedTask.result.success,
                    text: cachedTask.result.text,
                    data: cachedTask.result.data,
                };
            }
        }

        await maybeSendPendingReplyForTools(message, [toolName]);

        const task = taskManager.createTask(message.sender_id, message.group_id, toolName, params, cacheScope);
        taskManager.startTask(task.id);
        const startTime = Date.now();

        // 方案二：立即写入占位消息到 memory，让后续消息处理能感知到正在执行的工具
        const paramHint = Object.entries(params)
            .filter(([k]) => !isInternalSelfReferenceDrawKey(k))
            .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 30) : JSON.stringify(v).slice(0, 30)}`)
            .join(', ');
        const placeholderMsg: FormattedMessage = {
            message_id: -(Date.now() % 1000000),  // 负数 ID 标识为占位消息
            time: Math.floor(Date.now() / 1000),
            time_str: new Date().toLocaleTimeString('zh-CN'),
            type: message.type,
            self_id: config.botQQ || 0,
            summary: `[正在执行 ${toolName}...]`,
            sender_id: config.botQQ || 0,
            sender_name: getPersonaDisplayName(),
            group_id: message.group_id,
            text: `[正在执行 ${toolName}(${paramHint})，请稍候...]`,
            images: [],
            videos: [],
            records: [],
            at_users: [],
            at_all: false,
            files: [],
            cards: [],
            mface_urls: [],
            toolCall: {
                tool: toolName,
                params,
                result: '执行中...',
            },
        };
        memory.push(placeholderMsg);

        try {
            const moduleCtx = buildModuleContext({
                senderId: message.sender_id,
                groupId: message.group_id,
                imageUrls: [...currentImages, ...replyImages],
                videoPaths: currentVideos,
                audioPaths: currentAudios,
                filePaths: currentFiles,
                atUsers: message.at_users,
                senderRole: message.sender_role,
            });

            const moduleResult = await executeModule(toolName, params, moduleCtx);
            const duration = Date.now() - startTime;

            // 更新占位消息为实际结果
            placeholderMsg.text = moduleResult.text || (moduleResult.success ? `[${toolName} 执行成功]` : `[${toolName} 执行失败]`);
            placeholderMsg.toolCall!.result = moduleResult.text || (moduleResult.success ? '成功' : '失败');

            toolStats.add({
                name: toolName,
                params,
                result: moduleResult.text || (moduleResult.success ? '成功' : '失败'),
                success: moduleResult.success,
                duration,
                time: Date.now(),
                user: { id: message.sender_id, name: message.sender_name },
                taskId: task.id,
            });

            taskManager.completeTask(task.id, moduleResult.success, moduleResult.text, moduleResult.data);

            return moduleResult;
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            // 更新占位消息为失败状态
            placeholderMsg.text = `[${toolName} 执行出错: ${errorMsg.slice(0, 50)}]`;
            placeholderMsg.toolCall!.result = `失败: ${errorMsg}`;
            taskManager.completeTask(task.id, false, errorMsg, undefined, errorMsg);
            return { success: false, text: errorMsg };
        }
    }
}

export const reactAgent = new ReActAgent();

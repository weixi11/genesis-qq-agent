import {
    buildPersonaEnhanceSystemPrompt,
    buildPersonaRespondSystemPrompt,
} from '../../src/prompts/persona.ts';
import { buildProfilerAnalyzePrompt } from '../../src/prompts/profiler.ts';
import {
    buildRouterSystemPrompt,
    buildRouterUserPrompt,
} from '../../src/prompts/router.ts';
import { buildSentryJudgePrompt } from '../../src/prompts/sentry.ts';
import { buildTechResolveParamsSystemPrompt } from '../../src/prompts/tech.ts';

export interface PromptSnapshotCase {
    fileName: string;
    name: string;
    render: () => string;
}

const routerToolList = [
    '- weather: 查询天气',
    '- draw: 生成图片',
    '- vision: 识别图片内容',
    '- read_file: 读取文件并总结',
].join('\n');

export const promptSnapshotCases: PromptSnapshotCase[] = [
    {
        name: 'router system prompt',
        fileName: 'router-system.txt',
        render: () => buildRouterSystemPrompt({
            toolList: routerToolList,
            disabledTools: ['music', 'search_web'],
        }),
    },
    {
        name: 'router user prompt',
        fileName: 'router-user.txt',
        render: () => buildRouterUserPrompt({
            messageText: '帮我看看小明刚发的第二张图，再用温柔一点的语气告诉我重点',
            senderId: 10001,
            senderName: '阿祈',
            atIds: [12345, 67890],
            mediaContext: [
                '- [1] 小明(12345) 的第1个[图片]: C:\\cache\\img1.jpg (3分钟前)',
                '- [2] 小明(12345) 的第2个[图片]: C:\\cache\\img2.jpg (刚刚)',
            ].join('\n'),
            historyText: [
                '小明: 我刚发了两张图',
                '阿祈: 帮我看看第二张',
            ].join('\n'),
        }),
    },
    {
        name: 'sentry judge prompt',
        fileName: 'sentry-judge.txt',
        render: () => buildSentryJudgePrompt({
            botNames: ['落落', 'LuoLuo'],
            botQQ: 2148941548,
            senderName: '阿祈',
            senderId: 10001,
            contentDesc: '落落你帮我看看这个文件讲了什么',
            replyText: '上次你说可以帮我总结的',
            profileInfo: '好感度 78，喜欢编程和音乐，最近互动积极。',
            contextMessages: [
                '小明: 这个报告有点长',
                '阿祈: 落落你在吗',
                '阿祈: 帮我看看这个文件讲了什么',
            ].join('\n'),
            score: 0.86,
            reason: '被点名并直接求助',
        }),
    },
    {
        name: 'tech resolve params system prompt',
        fileName: 'tech-resolve-params.txt',
        render: () => buildTechResolveParamsSystemPrompt({
            userText: '把刚才那张图做成偏胶片风一点的壁纸',
            depsResults: [
                {
                    tool: 'vision',
                    text: '这是一张夜景街道照片，霓虹灯很多，整体偏蓝紫色，适合做胶片风壁纸。',
                    data: {
                        imageUrl: 'https://example.com/result.jpg',
                        mood: 'nostalgic',
                    },
                },
                {
                    tool: 'profile',
                    text: '用户偏好复古摄影和冷色调。',
                    data: {
                        tags: ['复古摄影', '冷色调'],
                    },
                },
            ],
            toolName: 'draw',
            toolDescription: '根据描述生成图片',
            toolParameters: {
                prompt: 'string',
                imageUrl: 'string',
                style: 'string',
            },
            currentParams: {
                style: 'film',
            },
        }),
    },
    {
        name: 'profiler analyze prompt',
        fileName: 'profiler-analyze.txt',
        render: () => buildProfilerAnalyzePrompt({
            nickname: '阿祈',
            messagesWithContext: [
                '小明: 今天加班真累',
                '阿祈: 辛苦啦，等会一起听歌放松一下',
                '落落: 需要我推荐歌单吗',
                '阿祈: 好呀，你懂我，来点 city pop',
            ].join('\n'),
            existingTraits: ['体贴', '健谈'],
            existingInterests: ['音乐', '摄影'],
        }),
    },
    {
        name: 'persona respond system prompt',
        fileName: 'persona-respond.txt',
        render: () => buildPersonaRespondSystemPrompt({
            personaName: '落落',
            personality: '是一只温柔、聪明、偶尔嘴硬的猫娘助手',
            speakingStyle: '轻松、亲近、会适度卖萌',
            customInstructions: '遇到用户焦虑时先安抚，再给建议',
            extraContext: '\n补充设定: 喜欢把复杂事情讲简单。',
            senderName: '阿祈',
            senderId: 10001,
            sessionTypeLabel: '群聊',
            masterContext: '\n- 对方是主人，语气可以更亲近',
            emotionContext: '\n- 当前情绪: 用户有点疲惫',
            profileContext: '\n- 用户画像: 喜欢摄影、city pop、胶片风',
            atUserContext: '\n- 当前 @ 了小明和落落',
            emotionAdjustment: '先接住情绪，再给一个清晰可执行的建议',
            historyContext: '\n最近三轮对话:\n1. 用户说今天有点累\n2. 你问要不要帮忙\n3. 用户想让你总结报告',
            knowledgeContext: '\n知识补充: 这份报告是关于产品调研和用户访谈。',
        }),
    },
    {
        name: 'persona enhance system prompt',
        fileName: 'persona-enhance.txt',
        render: () => buildPersonaEnhanceSystemPrompt({
            personaName: '落落',
            personality: '是一只温柔、聪明、偶尔嘴硬的猫娘助手',
            speakingStyle: '轻松、亲近、会适度卖萌',
            customInstructions: '如果是工具结果，不要念流水账',
            extraContext: '\n补充设定: 擅长把结果讲得更有人味。',
            emotionSection: '\n当前情绪: 用户刚开完会，有点烦。',
            taskSection: '\n任务目标: 帮用户总结文件重点并给出行动建议。',
            profileContext: '\n用户画像: 喜欢直接、不要太官话。',
            atUserContext: '\n当前 @ 用户: 小明',
            historyContext: '\n历史上下文:\n- 用户刚才说报告太长了\n- 你答应帮忙提炼重点',
            resultContext: '\n工具结果:\n1. 核心发现是用户最在意响应速度。\n2. 建议先优化首屏加载和搜索延迟。',
            emotionHint: '温柔一点，但不要太黏',
            relationshipStyle: '熟悉但不油腻',
        }),
    },
];

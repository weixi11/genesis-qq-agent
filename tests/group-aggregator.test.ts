import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildGroupBatchComposerMessage, executeGroupBatchPlan, planGroupBatch } from '../src/group_aggregator.ts';
import type { DebouncedMessage } from '../src/debouncer.ts';
import { techLlm } from '../src/llm.ts';
import { config as bananaDrawConfig } from '../src/tools/banana_draw/config.ts';
import type { FormattedMessage } from '../src/types.ts';

function createMessage(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
    return {
        message_id: Math.floor(Math.random() * 100000),
        time: Math.floor(Date.now() / 1000),
        time_str: new Date().toLocaleTimeString('zh-CN'),
        type: 'group',
        self_id: 424242,
        summary: '',
        sender_id: 10001,
        sender_name: '甲',
        sender_role: 'member',
        group_id: 20001,
        group_name: '测试群',
        text: '',
        images: [],
        videos: [],
        records: [],
        at_users: [424242],
        at_all: false,
        files: [],
        cards: [],
        mface_urls: [],
        ...overrides,
    };
}

function createDebounced(messages: FormattedMessage[]): DebouncedMessage {
    const first = messages[0];
    return {
        messages,
        mergedText: messages.map(message => message.text).join('\n'),
        mergedImages: messages.flatMap(message => message.images).map(image => typeof image === 'string' ? image : image.path || image.file || image.url || '').filter(Boolean),
        first,
        last: messages[messages.length - 1],
        mode: 'group_mention_batch',
        windowMs: 1200,
        participants: messages.reduce<NonNullable<DebouncedMessage['participants']>>((list, message) => {
            const existing = list.find(item => item.senderId === message.sender_id);
            if (existing) {
                existing.messageCount += 1;
                existing.mergedText = `${existing.mergedText}\n${message.text}`.trim();
                return list;
            }
            list.push({
                senderId: message.sender_id,
                senderName: message.sender_name,
                messageCount: 1,
                mergedText: message.text,
            });
            return list;
        }, []),
    };
}

test('planGroupBatch merges same-song music requests into one shared task', () => {
    const debounced = createDebounced([
        createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 点歌 稻香 周杰伦' }),
        createMessage({ sender_id: 10002, sender_name: '李四', text: '@落落 来首 稻香 周杰伦' }),
    ]);

    const plan = planGroupBatch(debounced, { enabledTools: ['music'] });

    assert.equal(plan.strategy, 'homogeneous_tool');
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].toolName, 'music');
    assert.equal(plan.tasks[0].participants.length, 2);
    assert.equal(plan.tasks[0].params.keyword, '稻香 周杰伦');
});

test('planGroupBatch semantically merges reordered music keywords into one shared task', () => {
    const debounced = createDebounced([
        createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 点歌 晴天 周杰伦' }),
        createMessage({ sender_id: 10002, sender_name: '李四', text: '@落落 点歌 周杰伦 晴天' }),
    ]);

    const plan = planGroupBatch(debounced, { enabledTools: ['music'] });

    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].participants.length, 2);
});

test('planGroupBatch lets stop intent override conflicting music tasks while keeping unrelated tasks', () => {
    const debounced = createDebounced([
        createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 点歌 晴天 周杰伦' }),
        createMessage({ sender_id: 10002, sender_name: '李四', text: '@落落 北京天气怎么样' }),
        createMessage({ sender_id: 10003, sender_name: '王五', text: '@落落 别播了，先停一下音乐' }),
    ]);

    const plan = planGroupBatch(debounced, { enabledTools: ['music', 'weather'] });

    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].toolName, 'weather');
    assert.match(plan.notes.join('\n'), /终止指令已覆盖/u);
});

test('planGroupBatch lets scoped stop intent suppress only matching heavy tool', () => {
    const debounced = createDebounced([
        createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 画一只站在月球上的猫' }),
        createMessage({ sender_id: 10002, sender_name: '李四', text: '@落落 北京天气怎么样' }),
        createMessage({ sender_id: 10003, sender_name: '王五', text: '@落落 别画了，先别生成图' }),
    ]);

    const plan = planGroupBatch(debounced, { enabledTools: ['draw', 'weather'] });

    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].toolName, 'weather');
    assert.match(plan.notes.join('\n'), /draw/u);
});

test('planGroupBatch dedupes identical draw prompts into one shared task', () => {
    const debounced = createDebounced([
        createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 画一只站在月球上的猫' }),
        createMessage({ sender_id: 10002, sender_name: '李四', text: '@落落 画一只站在月球上的猫' }),
    ]);

    const plan = planGroupBatch(debounced, { enabledTools: ['draw'] });

    assert.equal(plan.strategy, 'homogeneous_tool');
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].toolName, 'draw');
    assert.equal(plan.tasks[0].participants.length, 2);
    assert.equal(plan.tasks[0].params.prompt, '画一只站在月球上的猫');
});

test('planGroupBatch shares identical self portrait draw requests with selfReference marker', () => {
    const debounced = createDebounced([
        createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 画你自己站在街头' }),
        createMessage({ sender_id: 10002, sender_name: '李四', text: '@落落 画你自己站在街头' }),
    ]);

    const plan = planGroupBatch(debounced, { enabledTools: ['draw'] });

    assert.equal(plan.strategy, 'homogeneous_tool');
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].toolName, 'draw');
    assert.equal(plan.tasks[0].participants.length, 2);
    assert.equal(plan.tasks[0].params.selfReference, true);
    assert.equal(plan.tasks[0].params.prompt, '画你自己站在街头');
});

test('planGroupBatch routes explicit banana text-to-image requests to banana_draw', () => {
    const debounced = createDebounced([
        createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 用banana画一只站在月球上的猫' }),
    ]);

    const plan = planGroupBatch(debounced, { enabledTools: ['banana_draw', 'draw'] });

    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].toolName, 'banana_draw');
    assert.equal(plan.tasks[0].params.mode, undefined);
});

test('planGroupBatch can prefer banana_draw for normal text-to-image when configured', () => {
    const previousPrefer = bananaDrawConfig.preferForTextToImage;
    bananaDrawConfig.preferForTextToImage = true;

    try {
        const debounced = createDebounced([
            createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 画一只站在月球上的猫' }),
        ]);

        const plan = planGroupBatch(debounced, { enabledTools: ['banana_draw', 'draw'] });

        assert.equal(plan.tasks.length, 1);
        assert.equal(plan.tasks[0].toolName, 'banana_draw');
    } finally {
        bananaDrawConfig.preferForTextToImage = previousPrefer;
    }
});

test('planGroupBatch falls back to banana_draw when draw is disabled', () => {
    const previousPrefer = bananaDrawConfig.preferForTextToImage;
    bananaDrawConfig.preferForTextToImage = false;

    try {
        const debounced = createDebounced([
            createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 画一只站在月球上的猫' }),
        ]);

        const plan = planGroupBatch(debounced, { enabledTools: ['banana_draw'] });

        assert.equal(plan.tasks.length, 1);
        assert.equal(plan.tasks[0].toolName, 'banana_draw');
        assert.equal(plan.tasks[0].params.prompt, '画一只站在月球上的猫');
        assert.equal(plan.tasks[0].params.promptResolutionMode, 'llm_image_prompt');
    } finally {
        bananaDrawConfig.preferForTextToImage = previousPrefer;
    }
});

test('planGroupBatch marks banana_draw fallback self portraits for persona sharing', () => {
    const previousPrefer = bananaDrawConfig.preferForTextToImage;
    bananaDrawConfig.preferForTextToImage = false;

    try {
        const debounced = createDebounced([
            createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 画你自己站在街头' }),
        ]);

        const plan = planGroupBatch(debounced, { enabledTools: ['banana_draw'] });

        assert.equal(plan.tasks.length, 1);
        assert.equal(plan.tasks[0].toolName, 'banana_draw');
        assert.equal(plan.tasks[0].params.prompt, '画你自己站在街头');
        assert.equal(plan.tasks[0].params.selfReference, true);
        assert.equal(plan.tasks[0].params.promptResolutionMode, undefined);
    } finally {
        bananaDrawConfig.preferForTextToImage = previousPrefer;
    }
});

test('executeGroupBatchPlan rewrites marked draw prompt before execution', async () => {
    const originalChat = techLlm.chat.bind(techLlm);
    let executedParams: Record<string, unknown> | undefined;

    techLlm.chat = (async () => 'anime moon cat poster, full moon, starry sky, cinematic lighting') as typeof techLlm.chat;

    try {
        const debounced = createDebounced([
            createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 画一只站在月球上的猫' }),
        ]);
        const plan = planGroupBatch(debounced, { enabledTools: ['draw'] });

        await executeGroupBatchPlan(plan, {
            executeTool: async (_toolName, params) => {
                executedParams = params;
                return {
                    success: true,
                    text: 'ok',
                    segments: [],
                };
            },
        });

        assert.equal(executedParams?.prompt, 'anime moon cat poster, full moon, starry sky, cinematic lighting');
        assert.equal(executedParams?.promptResolutionMode, 'llm_image_prompt_resolved');
    } finally {
        techLlm.chat = originalChat;
    }
});

test('executeGroupBatchPlan resolves self portrait prompt before shared banana_draw execution', async () => {
    const originalChat = techLlm.chat.bind(techLlm);
    let executedParams: Record<string, unknown> | undefined;
    let capturedCaller = '';

    techLlm.chat = (async (_messages, _options, caller) => {
        capturedCaller = String(caller || '');
        return '1girl, solo, cat_girl, pink_hair, purple_eyes, cat_ears, low_twintails, catmask_on_head, street, cinematic lighting';
    }) as typeof techLlm.chat;

    try {
        const debounced = createDebounced([
            createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 画你自己站在街头' }),
        ]);
        const plan = planGroupBatch(debounced, { enabledTools: ['banana_draw'] });

        await executeGroupBatchPlan(plan, {
            executeTool: async (_toolName, params) => {
                executedParams = params;
                return {
                    success: true,
                    text: 'ok',
                    segments: [],
                };
            },
        });

        assert.equal(capturedCaller, 'group_batch_self_draw_prompt');
        assert.equal(executedParams?.selfReference, true);
        assert.equal(executedParams?.personaPromptResolved, true);
        assert.match(String(executedParams?.prompt || ''), /pink_hair/u);
        assert.match(String(executedParams?.prompt || ''), /purple_eyes/u);
    } finally {
        techLlm.chat = originalChat;
    }
});

test('executeGroupBatchPlan aggregates multi-tool results into one text and deduped segments', async () => {
    const debounced = createDebounced([
        createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 点歌 晴天 周杰伦' }),
        createMessage({ sender_id: 10002, sender_name: '李四', text: '@落落 北京天气怎么样' }),
        createMessage({ sender_id: 10003, sender_name: '王五', text: '@落落 在吗' }),
    ]);
    const plan = planGroupBatch(debounced, { enabledTools: ['music', 'weather'] });

    const result = await executeGroupBatchPlan(plan, {
        executeTool: async (toolName, params) => {
            if (toolName === 'music') {
                return {
                    success: true,
                    text: '已为您点歌: 🎵 晴天 - 周杰伦',
                    segments: [{ type: 'music', data: { type: '163', id: '123' } }],
                    data: { message: '已为您点歌: 🎵 晴天 - 周杰伦' },
                };
            }
            if (toolName === 'weather') {
                return {
                    success: true,
                    text: '📍 北京 天气\n晴 26°C',
                    segments: [{ type: 'music', data: { type: '163', id: '123' } }],
                    data: {},
                };
            }
            throw new Error(`unexpected tool: ${toolName} ${JSON.stringify(params)}`);
        },
    });

    assert.match(result.text || '', /张三：/u);
    assert.match(result.text || '', /李四：/u);
    assert.match(result.text || '', /王五：我在/u);
    assert.equal(result.segments.length, 1);
    assert.equal(result.toolCall?.tool, 'group_batch_aggregate');
    assert.equal(result.toolCall?.tools?.length, 2);
});

test('buildGroupBatchComposerMessage keeps participant and outcome context for persona polish', () => {
    const debounced = createDebounced([
        createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 点歌 晴天 周杰伦' }),
        createMessage({ sender_id: 10002, sender_name: '李四', text: '@落落 北京天气怎么样' }),
    ]);
    const plan = planGroupBatch(debounced, { enabledTools: ['music', 'weather'] });
    const message = buildGroupBatchComposerMessage(debounced.first, plan, [
        '张三：这波一起处理了，晴天 - 周杰伦',
        '李四：北京晴 26°C',
    ]);

    assert.equal(message.objective, 'group_batch_composer');
    assert.match(message.text, /参与者/u);
    assert.match(message.text, /张三/u);
    assert.match(message.text, /李四/u);
    assert.match(message.text, /原始执行结果/u);
});

test('executeGroupBatchPlan prioritizes shared high-coverage tasks when maxTasks is limited', async () => {
    const debounced = createDebounced([
        createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 北京天气怎么样' }),
        createMessage({ sender_id: 10002, sender_name: '李四', text: '@落落 北京天气怎么样' }),
        createMessage({ sender_id: 10003, sender_name: '王五', text: '@落落 点歌 晴天 周杰伦' }),
        createMessage({ sender_id: 10004, sender_name: '赵六', text: '@落落 搜一下 今天科技新闻' }),
        createMessage({ sender_id: 10005, sender_name: '钱七', text: '@落落 画一只站在月球上的猫' }),
    ]);
    const plan = planGroupBatch(debounced, { enabledTools: ['weather', 'music', 'search_web', 'draw'] });

    const result = await executeGroupBatchPlan(plan, {
        maxTasks: 2,
        executeTool: async (toolName) => ({
            success: true,
            text: `${toolName} done`,
            data: { message: `${toolName} done` },
        }),
    });

    assert.equal(plan.tasks[0].toolName, 'weather');
    assert.equal(result.toolCall?.tools?.length, 2);
    assert.equal(result.toolCall?.tools?.[0]?.name, 'weather');
    assert.match(result.text || '', /先处理最明确的 2 个/u);
});

test('executeGroupBatchPlan skips over-budget heavy tasks while keeping lighter shared tasks', async () => {
    const debounced = createDebounced([
        createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 北京天气怎么样' }),
        createMessage({ sender_id: 10002, sender_name: '李四', text: '@落落 北京天气怎么样' }),
        createMessage({ sender_id: 10003, sender_name: '王五', text: '@落落 搜一下 今天科技新闻' }),
        createMessage({ sender_id: 10004, sender_name: '赵六', text: '@落落 画一只站在月球上的猫' }),
    ]);
    const plan = planGroupBatch(debounced, { enabledTools: ['weather', 'search_web', 'draw'] });

    const result = await executeGroupBatchPlan(plan, {
        maxTasks: 4,
        maxCost: 3,
        executeTool: async (toolName) => ({
            success: true,
            text: `${toolName} done`,
            data: { message: `${toolName} done` },
        }),
    });

    assert.equal(result.toolCall?.tools?.length, 2);
    assert.deepEqual(result.toolCall?.tools?.map(tool => tool.name), ['weather', 'search_web']);
    assert.match(result.text || '', /比较重的请求我先缓一缓/u);
});

test('planGroupBatch prefers web_research over search_web for search intents when enabled', () => {
    const debounced = createDebounced([
        createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 搜一下 今天科技新闻' }),
    ]);

    const plan = planGroupBatch(debounced, { enabledTools: ['web_research', 'search_web'] });

    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].toolName, 'web_research');
    assert.deepEqual(plan.tasks[0].params, { mode: 'research', query: '今天科技新闻' });
});

test('executeGroupBatchPlan runs tasks with bounded concurrency', async () => {
    const debounced = createDebounced([
        createMessage({ sender_id: 10001, sender_name: '张三', text: '@落落 北京天气怎么样' }),
        createMessage({ sender_id: 10002, sender_name: '李四', text: '@落落 上海天气怎么样' }),
        createMessage({ sender_id: 10003, sender_name: '王五', text: '@落落 广州天气怎么样' }),
    ]);
    const plan = planGroupBatch(debounced, { enabledTools: ['weather'] });

    let running = 0;
    let maxRunning = 0;
    await executeGroupBatchPlan(plan, {
        maxConcurrency: 2,
        executeTool: async (toolName) => {
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            await new Promise(resolve => setTimeout(resolve, 20));
            running -= 1;
            return {
                success: true,
                text: `${toolName} done`,
                data: { message: `${toolName} done` },
            };
        },
    });

    assert.equal(maxRunning, 2);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assessTaskExecution } from '../../src/services/execution_mode.ts';
import type { FormattedMessage, TaskPlan } from '../../src/types.ts';

function createMessage(text: string, overrides: Partial<FormattedMessage> = {}): FormattedMessage {
    return {
        message_id: 1,
        time: Math.floor(Date.now() / 1000),
        time_str: new Date().toLocaleTimeString('zh-CN'),
        type: 'group',
        self_id: 424242,
        summary: text,
        sender_id: 10001,
        sender_name: '测试',
        sender_role: 'member',
        group_id: 20001,
        group_name: '测试群',
        text,
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

test('single explicit tool plan uses fast execution mode', () => {
    const plan: TaskPlan = {
        goal: '查询北京天气',
        needsTool: true,
        steps: [
            { id: 'step1', action: '查询天气', tool: 'weather', params: { location: '北京' } },
        ],
        confidence: 0.88,
        reasoning: '明确天气请求',
    };

    const assessment = assessTaskExecution(plan, createMessage('查下北京天气'));

    assert.equal(assessment.executionMode, 'fast');
    assert.equal(assessment.complexity.score, 0);
    assert.match(assessment.complexity.reasons[0] || '', /快速工具链路/u);
});

test('dependent multi-tool plan uses react execution mode', () => {
    const plan: TaskPlan = {
        goal: '先识图再搜索同款',
        needsTool: true,
        steps: [
            { id: 'step1', action: '分析图片', tool: 'vision', params: { imagePath: '/tmp/demo.png', question: '这是什么' } },
            { id: 'step2', action: '搜索同款', tool: 'search_web', params: { query: '${step1.text}' }, dependsOn: ['step1'] },
        ],
        confidence: 0.58,
        reasoning: '第二步依赖第一步结果',
    };

    const assessment = assessTaskExecution(
        plan,
        createMessage('你自己看着办，先看看图里是什么再搜同款', {
            images: [{ path: '/tmp/demo.png' }],
        }),
        [
            createMessage('上一轮也提过这个图'),
            createMessage('你得结合图片看'),
            createMessage('不是直接搜关键词'),
            createMessage('要先识别'),
            createMessage('然后再查'),
            createMessage('别搞错了'),
        ],
    );

    assert.equal(assessment.executionMode, 'react');
    assert.ok(assessment.complexity.score >= 3);
    assert.ok(assessment.complexity.reasons.some(reason => /依赖步骤/u.test(reason)));
    assert.ok(assessment.complexity.reasons.some(reason => /自主决定/u.test(reason)));
});

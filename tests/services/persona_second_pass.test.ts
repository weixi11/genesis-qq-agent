import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { config } from '../../src/config.ts';
import { shouldUsePersonaSecondPass } from '../../src/services/persona_second_pass.ts';
import type { FormattedMessage } from '../../src/types.ts';

const originalToolEnhanceResponse = config.toolEnhanceResponse;

afterEach(() => {
    config.toolEnhanceResponse = originalToolEnhanceResponse;
});

function createMessage(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
    return {
        message_id: 1,
        time: Math.floor(Date.now() / 1000),
        time_str: new Date().toLocaleTimeString('zh-CN'),
        type: 'group',
        self_id: 424242,
        summary: '',
        sender_id: 10001,
        sender_name: '测试',
        sender_role: 'member',
        group_id: 20001,
        group_name: '测试群',
        text: '测试消息',
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

test('internal react intent still uses persona second pass', () => {
    config.toolEnhanceResponse = true;

    const decision = shouldUsePersonaSecondPass({
        source: 'react',
        message: createMessage(),
        toolName: 'none',
        text: '意图：检测到这是一个需要安抚的场景。',
        success: true,
    });

    assert.equal(decision.shouldUse, true);
});

test('plain weather result still uses persona second pass for tool replies', () => {
    config.toolEnhanceResponse = true;

    const decision = shouldUsePersonaSecondPass({
        source: 'tool',
        message: createMessage(),
        toolName: 'weather',
        text: '北京今天晴，18 到 26 度，东北风 3 级。',
        success: true,
    });

    assert.equal(decision.shouldUse, true);
    assert.match(decision.reason, /人格化/u);
});

test('tool failure still uses persona second pass', () => {
    config.toolEnhanceResponse = true;

    const decision = shouldUsePersonaSecondPass({
        source: 'tool',
        message: createMessage(),
        toolName: 'search_web',
        text: '工具 search_web 执行出错: timeout',
        success: false,
    });

    assert.equal(decision.shouldUse, true);
});

test('tool media output still uses persona second pass', () => {
    config.toolEnhanceResponse = true;

    const decision = shouldUsePersonaSecondPass({
        source: 'tool',
        message: createMessage(),
        toolName: 'draw',
        text: '帮你画好了',
        success: true,
        hasSegments: true,
    });

    assert.equal(decision.shouldUse, true);
    assert.match(decision.reason, /媒体已单独发送/u);
});

test('react media output still skips persona second pass', () => {
    config.toolEnhanceResponse = true;

    const decision = shouldUsePersonaSecondPass({
        source: 'react',
        message: createMessage(),
        toolName: 'draw',
        text: '帮你画好了',
        success: true,
        hasSegments: true,
    });

    assert.equal(decision.shouldUse, false);
    assert.match(decision.reason, /已有媒体输出/u);
});

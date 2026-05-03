import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MessageDebouncer, type DebouncedMessage } from '../src/debouncer.ts';
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
        at_users: [],
        at_all: false,
        files: [],
        cards: [],
        mface_urls: [],
        ...overrides,
    };
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test('debouncer batches simultaneous group mentions into one merged reply window', async () => {
    const debouncer = new MessageDebouncer(10);
    const received: DebouncedMessage[] = [];
    debouncer.onDebounced((msg) => received.push(msg));

    debouncer.push(createMessage({
        sender_id: 10001,
        sender_name: '张三',
        text: '@落落 明天天气怎么样',
        at_users: [424242],
    }));
    debouncer.push(createMessage({
        sender_id: 10002,
        sender_name: '李四',
        text: '@落落 帮我看看这张图',
        at_users: [424242],
    }));

    await wait(40);

    assert.equal(received.length, 1);
    assert.equal(received[0].mode, 'group_mention_batch');
    assert.equal(received[0].participants?.length, 2);
    assert.match(received[0].mergedText, /张三/u);
    assert.match(received[0].mergedText, /李四/u);
});

test('debouncer lets follow-up messages from the same sender join an active mention batch', async () => {
    const debouncer = new MessageDebouncer(10);
    const received: DebouncedMessage[] = [];
    debouncer.onDebounced((msg) => received.push(msg));

    debouncer.push(createMessage({
        sender_id: 10001,
        sender_name: '张三',
        text: '@落落 先看这个',
        at_users: [424242],
    }));
    debouncer.push(createMessage({
        sender_id: 10001,
        sender_name: '张三',
        text: '还有上一条截图',
        at_users: [],
    }));
    debouncer.push(createMessage({
        sender_id: 10002,
        sender_name: '李四',
        text: '@落落 我也问一下',
        at_users: [424242],
    }));

    await wait(40);

    assert.equal(received.length, 1);
    assert.equal(received[0].mode, 'group_mention_batch');
    const participant = received[0].participants?.find(item => item.senderId === 10001);
    assert.equal(participant?.messageCount, 2);
    assert.match(participant?.mergedText || '', /还有上一条截图/u);
});

test('debouncer extends mention batch window when more participants join', async () => {
    const debouncer = new MessageDebouncer(30);
    const received: DebouncedMessage[] = [];
    debouncer.onDebounced((msg) => received.push(msg));

    debouncer.push(createMessage({
        sender_id: 10001,
        sender_name: '张三',
        text: '@落落 先看我这个',
        at_users: [424242],
    }));

    await wait(20);
    debouncer.push(createMessage({
        sender_id: 10002,
        sender_name: '李四',
        text: '@落落 我也补一个',
        at_users: [424242],
    }));

    await wait(20);
    assert.equal(received.length, 0);

    await wait(40);
    assert.equal(received.length, 1);
    assert.equal(received[0].mode, 'group_mention_batch');
    assert.ok(received[0].windowMs >= 40);
});

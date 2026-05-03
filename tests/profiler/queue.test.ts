import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type { AnalysisMessage, FormattedMessage } from '../../src/types.ts';

const originalCwd = process.cwd();
let tempCwd = '';
let closeProfilesDb: (() => void) | undefined;

before(async () => {
    tempCwd = await mkdtemp(path.join(os.tmpdir(), 'genesis-profiler-queue-'));
    process.chdir(tempCwd);

    const profilesModule = await import('../../src/storage/profiles-sqlite.ts');
    await profilesModule.initProfilesDb();
    closeProfilesDb = profilesModule.closeDb;
});

after(() => {
    closeProfilesDb?.();
    process.chdir(originalCwd);
});

function createMessage(overrides: Partial<FormattedMessage>): FormattedMessage {
    return {
        message_id: 1,
        time: Math.floor(Date.now() / 1000),
        time_str: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        type: 'group',
        summary: '',
        sender_id: 2148941548,
        sender_name: '踟蹰',
        group_id: 1042574135,
        text: '',
        images: [],
        videos: [],
        records: [],
        files: [],
        cards: [],
        mface_urls: [],
        at_users: [],
        at_all: false,
        ...overrides,
    };
}

function cloneBatch(messages: Map<number, AnalysisMessage[]>): Map<number, AnalysisMessage[]> {
    return new Map(
        Array.from(messages.entries(), ([userId, items]) => [
            userId,
            items.map(item => ({
                ...item,
                emotion: item.emotion ? { ...item.emotion } : undefined,
                context: item.context?.map(entry => ({ ...entry })),
            })),
        ]),
    );
}

test('Profiler enqueue uses merged text and keeps context for media-only follow-ups', async () => {
    const queueModule = await import('../../src/profiler/queue.ts');
    const batches: Map<number, AnalysisMessage[]>[] = [];

    queueModule.setAnalyzeCallback(async (messages) => {
        batches.push(cloneBatch(messages));
    });

    queueModule.enqueue(
        createMessage({ text: '第一段', time: 100 }),
        { text: '第一段\n第二段' },
    );
    queueModule.enqueue(
        createMessage({
            message_id: 2,
            text: '',
            time: 101,
            images: [{ path: 'C:/tmp/example.jpg' }],
        }),
        { text: '[图]' },
    );

    await queueModule.forceAnalysis();

    assert.equal(batches.length, 1);
    const userMessages = batches[0].get(2148941548);
    assert.ok(userMessages);
    assert.equal(userMessages.length, 2);
    assert.equal(userMessages[0].text, '第一段\n第二段');
    assert.equal(userMessages[1].text, '[图]');
    assert.deepEqual(userMessages[1].context, [
        { sender: '踟蹰', text: '第一段\n第二段' },
    ]);
});

test('Profiler requeues messages when analyze callback fails', async () => {
    const queueModule = await import('../../src/profiler/queue.ts');

    queueModule.setAnalyzeCallback(async () => {
        throw new Error('temporary failure');
    });

    queueModule.enqueue(
        createMessage({ message_id: 3, text: '这条消息不能丢' }),
        { text: '这条消息不能丢' },
    );

    await queueModule.forceAnalysis();

    assert.deepEqual(queueModule.getQueueStatus(), {
        totalMessages: 1,
        userCount: 1,
    });
});

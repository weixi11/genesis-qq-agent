import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FormattedMessage } from '../../src/types.ts';
import { orchestrationService } from '../../src/services/orchestration_service.ts';

function createMessage(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
    return {
        message_id: 1,
        time: Math.floor(Date.now() / 1000),
        type: 'group',
        sender_id: 123456,
        sender_name: 'tester',
        sender_role: 'member',
        group_id: 654321,
        text: '测试消息',
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

test('orchestration service keeps reply media in tool context', () => {
    const service = orchestrationService as unknown as {
        buildContext: (message: FormattedMessage) => {
            imageUrls: string[];
            videoPaths: string[];
            audioPaths: string[];
            filePaths: string[];
            senderRole?: string;
        };
    };

    const ctx = service.buildContext(createMessage({
        images: [{ url: '/tmp/current-image.jpg' }],
        videos: [{ path: '/tmp/current-video.mp4' }],
        records: [{ path: '/tmp/current-audio.wav' }],
        files: [{ path: '/tmp/current-file.pdf' }],
        reply: {
            message_id: 2,
            sender_id: 999,
            media: {
                images: [{ path: '/tmp/reply-image.jpg' }],
                videos: [{ path: '/tmp/reply-video.mp4' }],
                records: [{ path: '/tmp/reply-audio.wav' }],
                files: [{ file: '/tmp/reply-file.docx' }],
            },
        },
    }));

    assert.deepEqual(ctx.imageUrls, ['/tmp/current-image.jpg', '/tmp/reply-image.jpg']);
    assert.deepEqual(ctx.videoPaths, ['/tmp/current-video.mp4', '/tmp/reply-video.mp4']);
    assert.deepEqual(ctx.audioPaths, ['/tmp/current-audio.wav', '/tmp/reply-audio.wav']);
    assert.deepEqual(ctx.filePaths, ['/tmp/current-file.pdf', '/tmp/reply-file.docx']);
    assert.equal(ctx.senderRole, 'member');
});

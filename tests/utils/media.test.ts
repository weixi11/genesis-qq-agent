import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FormattedMessage } from '../../src/types.ts';
import { extractFiles } from '../../src/utils/media.ts';

function createMessage(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
    return {
        message_id: 1,
        time: Math.floor(Date.now() / 1000),
        type: 'private',
        sender_id: 123456,
        sender_name: 'tester',
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

test('extractFiles prefers real file locations and ignores name-only placeholders', () => {
    const fromUrl = extractFiles(createMessage({
        files: [{ type: 'file', name: 'report.docx', url: 'https://example.com/report.docx' }],
    }));
    assert.deepEqual(fromUrl, ['https://example.com/report.docx']);

    const nameOnly = extractFiles(createMessage({
        files: [{ type: 'file', name: 'report.docx' }],
    }));
    assert.deepEqual(nameOnly, []);
});

test('extractFiles reads reply file locations without falling back to file names', () => {
    const files = extractFiles(createMessage({
        reply: {
            message_id: 2,
            sender_id: 999,
            media: {
                files: [{ name: 'reply.docx', path: '/tmp/reply.docx' }],
            },
        },
    }));

    assert.deepEqual(files, ['/tmp/reply.docx']);
});

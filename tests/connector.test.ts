import assert from 'node:assert/strict';
import { test } from 'node:test';

test('connector uses longer timeout for media send actions', async () => {
    const connectorModule = await import('../src/connector.ts');

    assert.equal(
        connectorModule.resolveApiTimeoutMs('send_group_msg', {
            group_id: 123456,
            message: [{ type: 'image', data: { file: '/tmp/demo.png' } }],
        }),
        30000,
    );

    assert.equal(
        connectorModule.resolveApiTimeoutMs('upload_group_file', {
            group_id: 123456,
            file: '/tmp/report.docx',
            name: 'report.docx',
        }),
        120000,
    );

    assert.equal(
        connectorModule.resolveApiTimeoutMs('send_group_msg', {
            group_id: 123456,
            message: [{ type: 'text', data: { text: 'hello' } }],
        }),
        10000,
    );
});

test('connector.sendFile routes group files through upload_group_file', async () => {
    const connectorModule = await import('../src/connector.ts');
    const originalCallData = connectorModule.connector.callData.bind(connectorModule.connector);

    const requests: Array<{ action: string; params: Record<string, unknown> }> = [];
    const patchedConnector = connectorModule.connector as unknown as {
        callData: typeof connectorModule.connector.callData;
    };

    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        requests.push({ action, params });
        return undefined;
    };

    try {
        await connectorModule.connector.sendFile(
            { type: 'group', groupId: 123456 },
            { path: '/tmp/report.docx', name: 'report.docx' },
        );

        assert.deepEqual(requests, [{
            action: 'upload_group_file',
            params: {
                group_id: 123456,
                file: '/tmp/report.docx',
                name: 'report.docx',
            },
        }]);
    } finally {
        patchedConnector.callData = originalCallData;
    }
});

test('connector.sendFile routes private files through upload_private_file', async () => {
    const connectorModule = await import('../src/connector.ts');
    const originalCallData = connectorModule.connector.callData.bind(connectorModule.connector);

    const requests: Array<{ action: string; params: Record<string, unknown> }> = [];
    const patchedConnector = connectorModule.connector as unknown as {
        callData: typeof connectorModule.connector.callData;
    };

    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        requests.push({ action, params });
        return undefined;
    };

    try {
        await connectorModule.connector.sendFile(
            { type: 'private', userId: 654321 },
            '/tmp/script.py',
        );

        assert.deepEqual(requests, [{
            action: 'upload_private_file',
            params: {
                user_id: 654321,
                file: '/tmp/script.py',
                name: 'script.py',
            },
        }]);
    } finally {
        patchedConnector.callData = originalCallData;
    }
});

test('connector.send routes group segments through send_group_msg', async () => {
    const connectorModule = await import('../src/connector.ts');
    const originalCallData = connectorModule.connector.callData.bind(connectorModule.connector);

    const requests: Array<{ action: string; params: Record<string, unknown> }> = [];
    const patchedConnector = connectorModule.connector as unknown as {
        callData: typeof connectorModule.connector.callData;
    };

    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        requests.push({ action, params });
        return undefined;
    };

    try {
        await connectorModule.connector.send(
            { type: 'group', groupId: 123456 },
            [{ type: 'music', data: { type: '163', id: '42' } }],
        );

        assert.deepEqual(requests, [{
            action: 'send_group_msg',
            params: {
                group_id: 123456,
                message: [{ type: 'music', data: { type: '163', id: '42' } }],
            },
        }]);
    } finally {
        patchedConnector.callData = originalCallData;
    }
});

test('connector.send routes private segments through send_private_msg', async () => {
    const connectorModule = await import('../src/connector.ts');
    const originalCallData = connectorModule.connector.callData.bind(connectorModule.connector);

    const requests: Array<{ action: string; params: Record<string, unknown> }> = [];
    const patchedConnector = connectorModule.connector as unknown as {
        callData: typeof connectorModule.connector.callData;
    };

    patchedConnector.callData = async (action: string, params: Record<string, unknown>) => {
        requests.push({ action, params });
        return undefined;
    };

    try {
        await connectorModule.connector.send(
            { type: 'private', userId: 654321 },
            [{ type: 'image', data: { file: 'https://example.com/demo.png' } }],
        );

        assert.deepEqual(requests, [{
            action: 'send_private_msg',
            params: {
                user_id: 654321,
                message: [{ type: 'image', data: { file: 'https://example.com/demo.png' } }],
            },
        }]);
    } finally {
        patchedConnector.callData = originalCallData;
    }
});

test('connector ignores malformed bot events without invoking handlers', async () => {
    const connectorModule = await import('../src/connector.ts');
    const received: string[] = [];
    const connector = connectorModule.connector as unknown as {
        onMessage: (handler: (msg: { text: string }) => void) => void;
        handleMessage: (raw: string) => void;
    };

    connector.onMessage((msg) => {
        received.push(msg.text);
    });

    connector.handleMessage('{broken');
    connector.handleMessage(JSON.stringify({ type: 'message', data: { text: 'missing required fields' } }));
    connector.handleMessage(JSON.stringify({
        type: 'message',
        data: {
            type: 'private',
            message_id: 1,
            sender_id: 42,
            sender_name: 'tester',
            text: 'ok',
            images: [],
            videos: [],
            records: [],
            at_users: [],
            at_all: false,
            files: [],
            cards: [],
            mface_urls: [],
        },
    }));

    assert.deepEqual(received, ['ok']);
});

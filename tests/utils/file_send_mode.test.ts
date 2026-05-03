import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    getGlobalFileSendMode,
    normalizeFileSendMode,
    normalizeImageToolSendMode,
    resolveImageToolSendMode,
} from '../../src/utils/file_send_mode.ts';

test('normalize file send modes accepts known values only', () => {
    assert.equal(normalizeFileSendMode('local'), 'local');
    assert.equal(normalizeFileSendMode('BASE64'), 'base64');
    assert.equal(normalizeFileSendMode('auto'), 'auto');
    assert.equal(normalizeFileSendMode('url'), null);
});

test('normalize image tool send modes accepts known values only', () => {
    assert.equal(normalizeImageToolSendMode('local'), 'local');
    assert.equal(normalizeImageToolSendMode('base64'), 'base64');
    assert.equal(normalizeImageToolSendMode('url'), 'url');
    assert.equal(normalizeImageToolSendMode('auto'), null);
});

test('global file send mode falls back to auto', () => {
    assert.equal(getGlobalFileSendMode(undefined), 'auto');
    assert.equal(getGlobalFileSendMode('local'), 'local');
});

test('image tools can inherit global file send mode', () => {
    assert.equal(resolveImageToolSendMode(undefined, 'local'), 'local');
    assert.equal(resolveImageToolSendMode(undefined, 'base64'), 'local');
    assert.equal(resolveImageToolSendMode(undefined, 'auto'), 'local');
    assert.equal(resolveImageToolSendMode(undefined, undefined), 'url');
});

test('image tool explicit override wins over global mode', () => {
    assert.equal(resolveImageToolSendMode('url', 'local'), 'url');
    assert.equal(resolveImageToolSendMode('base64', 'local'), 'base64');
    assert.equal(resolveImageToolSendMode('local', 'base64'), 'local');
});

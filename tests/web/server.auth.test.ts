import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const SESSION_REVOCATION_FILE = path.join(process.cwd(), 'data', 'web-session-revocations.json');

async function loadWebServerTestUtils(password?: string) {
    if (password === undefined) {
        delete process.env.WEB_PASSWORD;
    } else {
        process.env.WEB_PASSWORD = password;
    }

    const mod = await import(`../../src/web/server.ts?test=${Date.now()}-${Math.random()}`);

    return mod.__webServerTestUtils as {
        isTrustedLoopbackRequest: (address: string, headers: Record<string, string>) => boolean;
        createAuthorizedSession: () => string;
        hasAuthorizedSession: (cookieHeader: string | undefined) => boolean;
        revokeAuthorizedSession: (cookieHeader: string | undefined) => void;
    };
}

function cleanupRevocations(): void {
    try {
        fs.rmSync(SESSION_REVOCATION_FILE, { force: true });
    } catch {
        // ignore cleanup failures in tests
    }
}

test('trusted loopback request rejects forwarded proxy headers and external hosts', async () => {
    const previousPassword = process.env.WEB_PASSWORD;
    cleanupRevocations();
    const utils = await loadWebServerTestUtils();

    assert.equal(
        utils.isTrustedLoopbackRequest('127.0.0.1', {
            host: 'localhost:7300',
        }),
        true,
    );

    assert.equal(
        utils.isTrustedLoopbackRequest('127.0.0.1', {
            host: 'genesis.example.com',
        }),
        false,
    );

    assert.equal(
        utils.isTrustedLoopbackRequest('127.0.0.1', {
            host: 'localhost:7300',
            'x-forwarded-for': '1.2.3.4',
        }),
        false,
    );

    if (previousPassword === undefined) {
        delete process.env.WEB_PASSWORD;
    } else {
        process.env.WEB_PASSWORD = previousPassword;
    }
    cleanupRevocations();
});

test('web sessions are random and can be revoked individually', async () => {
    const previousPassword = process.env.WEB_PASSWORD;
    cleanupRevocations();
    const utils = await loadWebServerTestUtils('secret-password');

    const sessionA = utils.createAuthorizedSession();
    const sessionB = utils.createAuthorizedSession();

    assert.notEqual(sessionA, '');
    assert.notEqual(sessionB, '');
    assert.notEqual(sessionA, sessionB);
    assert.equal(utils.hasAuthorizedSession(`genesis_web_session=${encodeURIComponent(sessionA)}`), true);
    assert.equal(utils.hasAuthorizedSession(`genesis_web_session=${encodeURIComponent(sessionB)}`), true);

    utils.revokeAuthorizedSession(`genesis_web_session=${encodeURIComponent(sessionA)}`);

    assert.equal(utils.hasAuthorizedSession(`genesis_web_session=${encodeURIComponent(sessionA)}`), false);
    assert.equal(utils.hasAuthorizedSession(`genesis_web_session=${encodeURIComponent(sessionB)}`), true);

    if (previousPassword === undefined) {
        delete process.env.WEB_PASSWORD;
    } else {
        process.env.WEB_PASSWORD = previousPassword;
    }
    cleanupRevocations();
});

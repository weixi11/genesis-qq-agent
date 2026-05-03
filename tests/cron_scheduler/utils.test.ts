import assert from 'node:assert/strict';
import test from 'node:test';

import { computeNextCronRun, parseCron } from '../../src/tools/cron_scheduler/utils.ts';

const timezone = 'Asia/Shanghai';

function createUtcDate(isoText: string): Date {
    return new Date(isoText);
}

test('cron treats day-of-month and weekday as OR when both are restricted', () => {
    const cron = parseCron('0 9 1 * 1');
    assert.equal(cron.ok, true);
    if (!cron.ok) return;

    assert.equal(cron.match(createUtcDate('2026-03-01T01:00:00.000Z'), timezone), true);
    assert.equal(cron.match(createUtcDate('2026-03-02T01:00:00.000Z'), timezone), true);
    assert.equal(cron.match(createUtcDate('2026-03-03T01:00:00.000Z'), timezone), false);
});

test('cron keeps weekday-only schedules strict when day-of-month is wildcard', () => {
    const cron = parseCron('0 9 * * 1');
    assert.equal(cron.ok, true);
    if (!cron.ok) return;

    assert.equal(cron.match(createUtcDate('2026-03-02T01:00:00.000Z'), timezone), true);
    assert.equal(cron.match(createUtcDate('2026-03-01T01:00:00.000Z'), timezone), false);
});

test('cron keeps day-of-month-only schedules strict when weekday is wildcard', () => {
    const cron = parseCron('0 9 1 * *');
    assert.equal(cron.ok, true);
    if (!cron.ok) return;

    assert.equal(cron.match(createUtcDate('2026-03-01T01:00:00.000Z'), timezone), true);
    assert.equal(cron.match(createUtcDate('2026-03-02T01:00:00.000Z'), timezone), false);
});

test('computeNextCronRun finds the next Monday-or-first trigger with standard semantics', () => {
    const fromDate = createUtcDate('2026-03-03T01:00:00.000Z');
    const nextRun = computeNextCronRun('0 9 1 * 1', timezone, fromDate);

    assert.notEqual(nextRun, null);
    assert.equal(nextRun?.toISOString(), '2026-03-09T01:00:00.000Z');
});

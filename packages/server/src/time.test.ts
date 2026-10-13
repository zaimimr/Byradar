import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osloMidnightUtcMs, secondsIntoServiceDay } from './time.js';

test('osloMidnightUtcMs: winter date (CET, UTC+1)', () => {
  // 2026-01-15 00:00 Oslo time is 2026-01-14 23:00 UTC.
  const ms = osloMidnightUtcMs('20260115');
  assert.equal(new Date(ms).toISOString(), '2026-01-14T23:00:00.000Z');
});

test('osloMidnightUtcMs: summer date (CEST, UTC+2)', () => {
  // 2026-07-15 00:00 Oslo time is 2026-07-14 22:00 UTC.
  const ms = osloMidnightUtcMs('20260715');
  assert.equal(new Date(ms).toISOString(), '2026-07-14T22:00:00.000Z');
});

test('osloMidnightUtcMs: day of spring-forward DST transition', () => {
  // DST in 2026 starts 2026-03-29 at 02:00 CET -> 03:00 CEST, so midnight
  // that day is still CET (UTC+1).
  const ms = osloMidnightUtcMs('20260329');
  assert.equal(new Date(ms).toISOString(), '2026-03-28T23:00:00.000Z');
});

test('osloMidnightUtcMs: day after autumn DST transition', () => {
  // DST in 2026 ends 2026-10-25, so 2026-10-26 midnight Oslo is CET (UTC+1).
  const ms = osloMidnightUtcMs('20261026');
  assert.equal(new Date(ms).toISOString(), '2026-10-25T23:00:00.000Z');
});

test('secondsIntoServiceDay: a few hours after midnight', () => {
  const midnight = osloMidnightUtcMs('20260115');
  const now = midnight + 3 * 3600_000 + 30 * 60_000; // 03:30 into the service day
  assert.equal(secondsIntoServiceDay('20260115', now), 3 * 3600 + 30 * 60);
});

test('secondsIntoServiceDay: night service past midnight belongs to the previous service day', () => {
  // 00:45 on 2026-01-16 Oslo time is still service day 2026-01-15, ~24h45m in.
  const midnight = osloMidnightUtcMs('20260115');
  const now = midnight + 24 * 3600_000 + 45 * 60_000;
  assert.equal(secondsIntoServiceDay('20260115', now), 24 * 3600 + 45 * 60);
});

test('secondsIntoServiceDay: defaults to Date.now() when no timestamp given', () => {
  const before = Date.now();
  const result = secondsIntoServiceDay('20260115');
  const after = Date.now();
  const midnight = osloMidnightUtcMs('20260115');
  assert.ok(result >= (before - midnight) / 1000);
  assert.ok(result <= (after - midnight) / 1000);
});

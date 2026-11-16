import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCompanyDateAndHour,
  isSalesFollowUpDigestWindowOpen,
  salesFollowUpDigestTitle,
} from '../src/sales-follow-up-notification-utils.js';

test('uses the configured company timezone for the daily digest date and hour', () => {
  assert.deepEqual(
    getCompanyDateAndHour(new Date('2026-11-17T03:29:00.000Z'), 'Asia/Kolkata'),
    { date: '2026-11-17', hour: 8 },
  );
  assert.deepEqual(
    getCompanyDateAndHour(new Date('2026-11-17T03:30:00.000Z'), 'Asia/Kolkata'),
    { date: '2026-11-17', hour: 9 },
  );
  assert.equal(isSalesFollowUpDigestWindowOpen(8), false);
  assert.equal(isSalesFollowUpDigestWindowOpen(9), true);
});

test('builds a concise digest title for due and overdue follow-ups', () => {
  assert.equal(salesFollowUpDigestTitle(2, 1), 'Sales follow-ups: 2 overdue, 1 due today');
  assert.equal(salesFollowUpDigestTitle(1, 0), 'Sales follow-ups: 1 overdue');
  assert.equal(salesFollowUpDigestTitle(0, 0), 'Sales follow-ups: No outstanding items');
});

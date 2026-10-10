import test from 'node:test';
import assert from 'node:assert/strict';
import { duration, entryCellPayload, entryPayload, formatDuration, groupEntriesByDate, localFields, totalTrackedSeconds } from './time.js';

test('optional end time remains null', () => {
  const payload = entryPayload({ category: 'Research', description: 'Read', date: '2026-01-05', startTime: '09:00', endTime: '' });
  assert.equal(payload.ended_at, null);
  assert.equal(new Date(payload.started_at).getHours(), 9);
});

test('overnight time gets the next calendar date', () => {
  const payload = entryPayload({ date: '2026-01-05', startTime: '23:00', endTime: '01:00' });
  assert.equal(duration(payload), 2 * 3600);
  assert.equal(localFields(payload.ended_at).date, '2026-01-06');
});

test('inline time edits keep start date and infer only same-day or next-day ends', () => {
  const entry = { started_at: new Date('2026-08-08T23:00:00').toISOString(), ended_at: new Date('2026-08-10T01:00:00').toISOString() };
  const overnight = entryCellPayload(entry, 'endTime', '01:00');
  assert.equal(localFields(overnight.started_at).date, '2026-08-08');
  assert.equal(localFields(overnight.ended_at).date, '2026-08-09');
  const sameDay = entryCellPayload(entry, 'startTime', '00:30');
  assert.equal(localFields(sameDay.ended_at).date, '2026-08-08');
  assert.equal(duration(sameDay), 30 * 60);
});

test('duration supports more than a day and live entries', () => {
  assert.equal(formatDuration(51 * 3600 + 12 * 60), '51h 12m');
  assert.equal(formatDuration(59), '0m');
  assert.equal(duration({ started_at: '2026-01-01T00:00:00Z', ended_at: null }, Date.parse('2026-01-01T00:30:00Z')), 1800);
});

test('durations omit zero hours, zero minutes, and padding', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(60), '1m');
  assert.equal(formatDuration(59 * 60), '59m');
  assert.equal(formatDuration(3600), '1h');
  assert.equal(formatDuration(3660), '1h 1m');
});

test('entries group by local start date, with newest dates and entries first', () => {
  const timestamp = value => new Date(value).toISOString();
  const entries = [
    { id: 1, started_at: timestamp('2026-01-05T09:00:00') },
    { id: 2, started_at: timestamp('2026-01-06T09:00:00') },
    { id: 3, started_at: timestamp('2026-01-05T23:00:00'), ended_at: timestamp('2026-01-06T01:00:00') },
    { id: 4, started_at: timestamp('2026-01-06T14:00:00') },
  ];
  const groups = groupEntriesByDate(entries);
  assert.deepEqual(groups.map(group => group.date), ['2026-01-06', '2026-01-05']);
  assert.deepEqual(groups.map(group => group.entries.map(entry => entry.id)), [[4, 2], [3, 1]]);
  assert.deepEqual(entries.map(entry => entry.id), [1, 2, 3, 4]);
  assert.deepEqual(groupEntriesByDate([]), []);
});

test('daily totals sum submitted entries on their local start date, including overnight tasks', () => {
  const timestamp = value => new Date(value).toISOString();
  const entries = [
    { id: 1, started_at: timestamp('2026-01-05T09:00:00'), ended_at: timestamp('2026-01-05T09:30:00'), is_submitted: true },
    { id: 2, started_at: timestamp('2026-01-05T23:00:00'), ended_at: timestamp('2026-01-06T01:00:00'), is_submitted: true },
    { id: 3, started_at: timestamp('2026-01-06T09:00:00'), ended_at: timestamp('2026-01-06T10:00:00'), is_submitted: true },
    { id: 4, started_at: timestamp('2026-01-06T11:00:00'), ended_at: null, is_submitted: false },
    { id: 5, started_at: timestamp('2026-01-06T12:00:00'), ended_at: timestamp('2026-01-06T13:00:00'), is_submitted: false },
  ];
  const groups = groupEntriesByDate(entries);
  assert.deepEqual(groups.map(group => [group.date, formatDuration(group.totalSeconds)]), [['2026-01-06', '1h'], ['2026-01-05', '2h 30m']]);
  assert.equal(groups.reduce((sum, group) => sum + group.totalSeconds, 0), totalTrackedSeconds(entries));
  assert.equal(totalTrackedSeconds([]), 0);

  entries[0].ended_at = timestamp('2026-01-05T10:00:00');
  assert.equal(groupEntriesByDate(entries)[1].totalSeconds, 3 * 3600);
  const remaining = entries.filter(entry => entry.id !== 2);
  assert.equal(groupEntriesByDate(remaining)[1].totalSeconds, 3600);
});

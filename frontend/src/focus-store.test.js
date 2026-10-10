import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusStore } from './focus-store.js';

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('custom focus duration starts, pauses, resumes, and resets', () => {
  const state = new FocusStore(memoryStorage(), 1000);
  state.setMinutes('10');
  state.start(1000);
  state.tick(61_000);
  assert.equal(state.timeLabel, '09:00');
  state.pause(61_000);
  state.tick(121_000);
  assert.equal(state.timeLabel, '09:00');
  assert.equal(state.running, false);
  state.start(121_000);
  state.tick(181_000);
  assert.equal(state.timeLabel, '08:00');
  state.reset();
  assert.equal(state.timeLabel, '10:00');
  assert.equal(state.running, false);
});

test('timer catches up after an inactive tab and stops at zero', () => {
  const state = new FocusStore(memoryStorage(), 1000);
  state.setMinutes('1');
  state.start(1000);
  state.tick(500_000);
  assert.equal(state.timeLabel, '00:00');
  assert.equal(state.running, false);
  assert.equal(state.completed, true);
  assert.equal(state.progress, 1);
  state.start(500_000);
  assert.equal(state.timeLabel, '01:00');
  assert.equal(state.completed, false);
});

test('timer and goal restore across refresh, including elapsed focus time', () => {
  const storage = memoryStorage();
  const original = new FocusStore(storage, 1000);
  original.setGoal('Validate the network protocol');
  original.setGoalCompleted(true);
  original.start(1000);
  const restored = new FocusStore(storage, 121_000);
  assert.equal(restored.goal, 'Validate the network protocol');
  assert.equal(restored.goalCompleted, true);
  assert.equal(restored.timeLabel, '23:00');
  assert.equal(restored.running, true);
  const expired = new FocusStore(storage, 2_000_000);
  assert.equal(expired.completed, true);
  assert.equal(expired.running, false);
});

test('invalid timer durations do not start and blank goals cannot be complete', () => {
  const state = new FocusStore(memoryStorage(), 1000);
  for (const value of ['', '0', '181', '1.5', 'oops']) {
    state.setMinutes(value);
    state.start(1000);
    assert.equal(state.running, false);
    assert.equal(state.timerError, 'Choose 1 to 180 minutes.');
  }
  state.setGoalCompleted(true);
  assert.equal(state.goalCompleted, false);
  state.setGoal('Finish validation');
  state.setGoalCompleted(true);
  state.setGoal('Write the results');
  assert.equal(state.goalCompleted, false);
});

test('unavailable or corrupted storage does not break the panels', () => {
  const unavailable = { getItem: () => { throw new Error('Unavailable'); }, setItem: () => { throw new Error('Unavailable'); } };
  const state = new FocusStore(unavailable, 1000);
  assert.doesNotThrow(() => { state.start(1000); state.setGoal('Keep working'); });
  const corrupted = new FocusStore({ getItem: () => '{', setItem: () => {} }, 1000);
  assert.equal(corrupted.timeLabel, '25:00');
});

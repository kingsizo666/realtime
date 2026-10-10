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
  original.startGoal();
  original.completeGoal();
  original.start(1000);
  const restored = new FocusStore(storage, 121_000);
  assert.equal(restored.goal, 'Validate the network protocol');
  assert.equal(restored.goalCompleted, true);
  assert.equal(restored.goalActive, false);
  assert.equal(restored.timeLabel, '23:00');
  assert.equal(restored.running, true);
  const expired = new FocusStore(storage, 2_000_000);
  assert.equal(expired.completed, true);
  assert.equal(expired.running, false);
});

test('invalid timer durations do not start', () => {
  const state = new FocusStore(memoryStorage(), 1000);
  for (const value of ['', '0', '181', '1.5', 'oops']) {
    state.setMinutes(value);
    state.start(1000);
    assert.equal(state.running, false);
    assert.equal(state.timerError, 'Choose 1 to 180 minutes.');
  }
});

test('goals must be explicitly set before completion and edits need setting again', () => {
  const state = new FocusStore(memoryStorage(), 1000);
  state.setGoal('  ');
  state.startGoal();
  state.completeGoal();
  assert.equal(state.goalStarted, false);
  assert.equal(state.goalCompleted, false);
  assert.equal(state.canSetGoal, false);

  state.setGoal('  Finish validation  ');
  state.completeGoal();
  assert.equal(state.goalCompleted, false);
  assert.equal(state.canSetGoal, true);
  state.startGoal();
  assert.equal(state.goal, 'Finish validation');
  assert.equal(state.goalActive, true);
  assert.equal(state.canSetGoal, false);
  state.setGoal(state.goal);
  assert.equal(state.goalActive, true);

  state.setGoal('Write the results');
  assert.equal(state.goalStarted, false);
  state.completeGoal();
  assert.equal(state.goalCompleted, false);
  state.startGoal();
  state.completeGoal();
  assert.equal(state.goalActive, false);
  assert.equal(state.goalCompleted, true);
  state.startGoal();
  assert.equal(state.goalCompleted, false);
  assert.equal(state.goalActive, true);
});

test('active goals and drafts retain their state across refreshes', () => {
  const storage = memoryStorage();
  const original = new FocusStore(storage, 1000);
  original.setGoal('Research scheduling');
  assert.equal(new FocusStore(storage, 1000).goalStarted, false);
  original.startGoal();
  const active = new FocusStore(storage, 1000);
  assert.equal(active.goalActive, true);
  assert.equal(active.goal, 'Research scheduling');
  active.setGoal('Research scheduling and validation');
  const draft = new FocusStore(storage, 1000);
  assert.equal(draft.goalActive, false);
  assert.equal(draft.canSetGoal, true);
});

test('existing saved goals survive the upgrade without starting unfinished drafts', () => {
  const storage = memoryStorage();
  storage.setItem('realtime-focus', JSON.stringify({ goal: 'Previous goal', goalCompleted: true }));
  const completed = new FocusStore(storage, 1000);
  assert.equal(completed.goalCompleted, true);
  assert.equal(completed.goalStarted, true);
  storage.setItem('realtime-focus', JSON.stringify({ goal: 'Previous draft', goalCompleted: false }));
  const draft = new FocusStore(storage, 1000);
  assert.equal(draft.goal, 'Previous draft');
  assert.equal(draft.goalStarted, false);
  storage.setItem('realtime-focus', JSON.stringify({ goal: ' ', goalStarted: true, goalCompleted: true }));
  const blank = new FocusStore(storage, 1000);
  assert.equal(blank.goalStarted, false);
  assert.equal(blank.goalCompleted, false);
});

test('unavailable or corrupted storage does not break the panels', () => {
  const unavailable = { getItem: () => { throw new Error('Unavailable'); }, setItem: () => { throw new Error('Unavailable'); } };
  const state = new FocusStore(unavailable, 1000);
  assert.doesNotThrow(() => { state.start(1000); state.setGoal('Keep working'); state.setNotes('Some notes'); state.clearNotes(); });
  const corrupted = new FocusStore({ getItem: () => '{', setItem: () => {} }, 1000);
  assert.equal(corrupted.timeLabel, '25:00');
});

test('notes retain multiline text across refresh and clearing preserves the goal and timer', () => {
  const storage = memoryStorage();
  const original = new FocusStore(storage, 1000);
  original.setGoal('Validate the protocol');
  original.startGoal();
  original.start(1000);
  const notes = 'First finding\n\n  Next steps: review timing. ✓';
  original.setNotes(notes);
  const restored = new FocusStore(storage, 61_000);
  assert.equal(restored.notes, notes);
  restored.pause(61_000);
  assert.equal(new FocusStore(storage, 61_000).notes, notes);
  restored.clearNotes();
  const cleared = new FocusStore(storage, 61_000);
  assert.equal(cleared.notes, '');
  assert.equal(cleared.goal, 'Validate the protocol');
  assert.equal(cleared.goalActive, true);
  assert.equal(cleared.timeLabel, '24:00');
  assert.equal(cleared.running, false);
});

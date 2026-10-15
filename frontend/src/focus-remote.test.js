import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusStore } from './focus-store.js';

function state(extra = {}) {
  return { exists: true, focus: { minutes: 25, remaining_ms: 1500000, deadline: null, completed: false, block_enabled: false, revision: 1, ...extra },
    apps: [], blocker: { available: true, running_apps: [], message: '' } };
}
const storage = () => ({ getItem: () => null, setItem() {} });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('remote focus imports a legacy browser timer once and preserves the goal', async () => {
  const focus = new FocusStore(storage(), 1000);
  focus.setGoal('Keep my goal');
  focus.setMinutes('10');
  focus.start(1000);
  const calls = [];
  await focus.connect(async (url, options) => {
    calls.push({ url, options });
    return options ? state({ minutes: 10, remaining_ms: 600000, deadline: new Date(601000).toISOString() }) : { exists: false };
  });
  const restore = JSON.parse(calls[1].options.body);
  assert.equal(restore.action, 'restore');
  assert.equal(restore.deadline, 601000);
  assert.equal(restore.remaining_ms, 600000);
  assert.equal(focus.goal, 'Keep my goal');
  assert.equal(focus.connected, true);
});

test('a paused duration draft survives reload unless another window changed the timer', async () => {
  let saved = null;
  const memory = { getItem: () => saved, setItem: (key, value) => { saved = value; } };
  const original = new FocusStore(memory);
  await original.connect(async () => state());
  original.setMinutes('10');
  const restored = new FocusStore(memory);
  await restored.connect(async () => state());
  assert.equal(restored.minutes, '10');
  assert.equal(restored.remainingMs, 600000);
  const newer = new FocusStore(memory);
  await newer.connect(async () => state({ minutes: 3, revision: 2, remaining_ms: 180000 }));
  assert.equal(newer.minutes, '3');
});

test('server state supersedes a stale browser timer and all timer actions use its revision', async () => {
  const focus = new FocusStore(storage());
  focus.start();
  const calls = [];
  await focus.connect(async (url, options) => {
    calls.push(options && JSON.parse(options.body));
    return state(options ? { minutes: 5, remaining_ms: 300000, block_enabled: true, revision: 9 } : { revision: 8 });
  });
  assert.equal(calls.length, 1);
  assert.equal(focus.running, false);
  focus.setMinutes('5');
  await focus.command('start');
  assert.deepEqual(calls[1], { action: 'start', revision: 8, minutes: 5 });
  assert.equal(focus.blockEnabled, true);
  assert.equal(focus.minutes, '5');
});

test('a late poll cannot overwrite a newer command and a paused duration draft survives polls', async () => {
  const focus = new FocusStore(storage());
  const poll = deferred();
  let gets = 0;
  await focus.connect(async (url, options) => options ? state({ revision: 2, remaining_ms: 300000, minutes: 5 }) : ++gets === 1 ? state() : poll.promise);
  focus.setMinutes('5');
  const refresh = focus.refresh();
  await focus.command('reset');
  poll.resolve(state());
  await refresh;
  assert.equal(focus.revision, 2);
  focus.setMinutes('3');
  focus.applyRemote(state({ revision: 2, minutes: 5, remaining_ms: 300000 }));
  assert.equal(focus.minutes, '3');
  assert.equal(focus.remainingMs, 180000);
});

test('failed commands preserve shared state and recover using the current server revision', async () => {
  const focus = new FocusStore(storage());
  await focus.connect(async (url, options) => {
    if (options) throw new Error('Focus changed in another window. Try again.');
    return state({ revision: 7, deadline: new Date(Date.now() + 60000).toISOString() });
  });
  assert.equal(await focus.command('pause'), false);
  assert.equal(focus.running, true);
  assert.equal(focus.revision, 7);
  assert.match(focus.timerError, /another window/);
  assert.equal(focus.busy, false);
});

test('connection failure can be retried and unavailable native helper still allows timer commands', async () => {
  const focus = new FocusStore(storage());
  await focus.connect(async () => { throw new Error('Offline'); });
  assert.equal(focus.connected, false);
  assert.equal(focus.timerError, 'Offline');
  await focus.connect(async () => ({ ...state(), blocker: { available: false, running_apps: [], message: 'Open Realtime.exe' } }));
  assert.equal(focus.connected, true);
  assert.equal(await focus.command('start'), true);
  assert.equal(focus.timerError, '');
});

test('adding and removing apps use backend identities and failed saves retain the list', async () => {
  const focus = new FocusStore(storage());
  const app = { id: 4, path: 'c:\\apps\\example.exe', name: 'Example' };
  const calls = [];
  let fail = false;
  await focus.connect(async (url, options) => {
    if (!options) return state();
    calls.push([url, options]);
    if (fail) throw new Error('Cannot save');
    return { apps: options.method === 'DELETE' ? [] : [app], blocker: state().blocker };
  });
  await focus.changeApp(app);
  assert.equal(focus.apps[0].id, 4);
  assert.deepEqual(JSON.parse(calls[0][1].body), { path: app.path });
  fail = true;
  await focus.changeApp(app, true);
  assert.equal(focus.apps.length, 1);
  assert.equal(focus.appError, 'Cannot save');
  fail = false;
  await focus.changeApp(app, true);
  assert.equal(calls.at(-1)[0], '/api/blocked-apps/4/');
  assert.equal(focus.apps.length, 0);
});

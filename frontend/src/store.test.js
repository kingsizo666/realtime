import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeStore } from './store.js';

const pending = { id: 1, category: 'Research', description: 'Read protocol', started_at: '2026-01-01T09:00:23.123456Z', ended_at: null, is_submitted: false };
const completed = { ...pending, ended_at: '2026-01-01T10:00:23.123456Z', is_submitted: true };

test('add, reload, modify, and submit resets the next entry to the current local date and time', async (t) => {
  let currentTime = new Date(2026, 9, 10, 23, 59).getTime();
  t.mock.method(Date, 'now', () => currentTime);
  const state = new TimeStore();
  state.request = async () => ({ entries: [], categories: ['Research'] });
  await state.load();
  state.form = { category: 'Research', description: 'Read protocol', date: '2026-01-01', startTime: '09:00', endTime: '' };
  state.request = async () => ({ entry: pending });
  await state.save();
  assert.equal(state.activeEntry.id, 1);
  const reloaded = new TimeStore();
  reloaded.request = async () => ({ entries: [pending], categories: ['Research'] });
  await reloaded.load();
  assert.match(reloaded.form.startTime, /^\d{2}:\d{2}$/);
  reloaded.updateField('description', 'Updated before submitting');
  reloaded.updateField('startTime', '08:30');
  reloaded.request = async (url, options) => {
    assert.equal(url, '/api/entries/1/finish/');
    const payload = JSON.parse(options.body);
    assert.equal(payload.description, 'Updated before submitting');
    assert.equal(new Date(payload.started_at).getMinutes(), 30);
    assert.equal(new Date(payload.started_at).getSeconds(), 0);
    currentTime = new Date(2026, 9, 11, 0, 2).getTime();
    return { entry: completed };
  };
  await reloaded.save();
  assert.equal(reloaded.activeEntry, undefined);
  assert.equal(reloaded.totalSeconds, 3600);
  assert.deepEqual({ ...reloaded.form }, { category: '', description: '', date: '2026-10-11', startTime: '00:02', endTime: '' });
});

test('description blur save patches only the description', async () => {
  const state = new TimeStore();
  state.entries = [completed];
  state.request = async (url, options) => {
    assert.equal(url, '/api/entries/1/');
    assert.equal(options.method, 'PATCH');
    assert.deepEqual(JSON.parse(options.body), { description: 'Corrected' });
    return { entry: { ...completed, description: 'Corrected' } };
  };
  assert.equal(await state.saveCell(1, 'description', 'Corrected'), true);
  assert.equal(state.entries[0].description, 'Corrected');
  assert.equal(state.entries[0].started_at, completed.started_at);
});

test('an entry can be added and submitted without a description', async () => {
  const state = new TimeStore();
  state.loading = false;
  state.form = { category: 'Research', description: '', date: '2026-01-01', startTime: '09:00', endTime: '' };
  state.request = async (url, options) => {
    assert.equal(JSON.parse(options.body).description, '');
    return { entry: { ...pending, description: '', ...(url.endsWith('/finish/') ? { ended_at: completed.ended_at, is_submitted: true } : {}) } };
  };
  await state.save();
  assert.equal(state.activeEntry.description, '');
  await state.save();
  assert.equal(state.activeEntry, undefined);
  assert.equal(state.entries[0].description, '');
  assert.equal(state.error, '');
});

test('description blur save can clear an existing description', async () => {
  const state = new TimeStore();
  state.entries = [completed];
  state.request = async (url, options) => {
    assert.deepEqual(JSON.parse(options.body), { description: '' });
    return { entry: { ...completed, description: '' } };
  };
  assert.equal(await state.saveCell(1, 'description', ''), true);
  assert.equal(state.entries[0].description, '');
  assert.equal(state.entries[0].ended_at, completed.ended_at);
});

test('submit sends the selected end time and clears the form on success', async () => {
  const state = new TimeStore();
  state.loading = false;
  state.entries = [pending];
  state.resumeEntry(pending);
  state.updateField('endTime', '11:30');
  state.request = async (url, options) => {
    assert.equal(url, '/api/entries/1/finish/');
    const payload = JSON.parse(options.body);
    assert.equal(new Date(payload.ended_at).getHours(), 11);
    assert.equal(new Date(payload.ended_at).getMinutes(), 30);
    return { entry: { ...pending, ended_at: payload.ended_at, is_submitted: true } };
  };
  await state.save();
  assert.equal(new Date(state.entries[0].ended_at).getMinutes(), 30);
  assert.equal(state.activeEntry, undefined);
  assert.equal(state.form.endTime, '');
});

test('queued blur saves use the latest row and do not drop rapid edits', async () => {
  const state = new TimeStore();
  state.entries = [completed];
  let calls = 0;
  state.request = async (url, options) => {
    const body = JSON.parse(options.body);
    calls++;
    if (calls === 1) return { entry: { ...completed, description: body.description } };
    assert.equal(state.entries[0].description, 'Changed');
    assert.equal(new Date(body.ended_at).getHours(), 11);
    return { entry: { ...state.entries[0], ...body } };
  };
  const first = state.saveCell(1, 'description', 'Changed');
  const second = state.saveCell(1, 'endTime', '11:00');
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(calls, 2);
  assert.equal(state.entries[0].description, 'Changed');
});

test('pending description save preserves other current form changes', async () => {
  const state = new TimeStore();
  state.entries = [pending];
  state.resumeEntry(pending);
  state.updateField('category', 'Automated Reasoning');
  state.request = async () => ({ entry: { ...pending, description: 'Changed' } });
  await state.saveCell(1, 'description', 'Changed');
  assert.equal(state.form.description, 'Changed');
  assert.equal(state.form.category, 'Automated Reasoning');
});

test('failed blur save preserves saved entry and permits retry', async () => {
  const state = new TimeStore();
  state.entries = [completed];
  state.request = async () => { throw new Error('Offline'); };
  assert.equal(await state.saveCell(1, 'description', 'Retry me'), false);
  assert.equal(state.entries[0].description, completed.description);
  assert.equal(state.entryError, 'Offline');
  state.request = async () => ({ entry: { ...completed, description: 'Retry me' } });
  assert.equal(await state.saveCell(1, 'description', 'Retry me'), true);
  assert.equal(state.entryError, '');
});

test('delete waits for pending blur save then clears unfinished form', async () => {
  const state = new TimeStore();
  state.entries = [pending];
  state.resumeEntry(pending);
  const methods = [];
  state.request = async (url, options) => {
    methods.push(options.method);
    return options.method === 'PATCH' ? { entry: { ...pending, description: 'Changed' } } : { deleted_id: 1 };
  };
  const editing = state.saveCell(1, 'description', 'Changed');
  await state.deleteEntry(pending);
  await editing;
  assert.deepEqual(methods, ['PATCH', 'DELETE']);
  assert.equal(state.entries.length, 0);
  assert.equal(state.form.description, '');
});

test('save and delete failures preserve data', async () => {
  const state = new TimeStore();
  state.loading = false;
  state.form = { category: 'Research', description: 'Keep me', date: '2026-01-01', startTime: '09:00', endTime: '' };
  state.request = async () => { throw new Error('Offline'); };
  await state.save();
  assert.equal(state.form.description, 'Keep me');
  state.entries = [pending];
  await state.deleteEntry(pending);
  assert.equal(state.entries.length, 1);
  assert.equal(state.saving, false);
});

test('stop waits for inline saves and preserves unfinished entries', async () => {
  const state = new TimeStore();
  state.loading = false;
  state.canShutdown = true;
  state.entries = [pending];
  state.resumeEntry(pending);
  const methods = [];
  state.request = async (url, options) => {
    methods.push(url);
    if (options.method === 'PATCH') return { entry: { ...pending, description: 'Saved before stopping' } };
    assert.equal(options.method, 'POST');
    return { stopping: true };
  };
  const editing = state.saveCell(1, 'description', 'Saved before stopping');
  await state.stopApp();
  await editing;
  assert.deepEqual(methods, ['/api/entries/1/', '/api/shutdown/']);
  assert.equal(state.stopped, true);
  assert.equal(state.activeEntry.description, 'Saved before stopping');
  assert.equal(state.activeEntry.is_submitted, false);
});

test('canceling stop keeps unsaved form edits and sends no shutdown request', async () => {
  const state = new TimeStore();
  state.loading = false;
  state.canShutdown = true;
  state.entries = [pending];
  state.resumeEntry(pending);
  state.updateField('description', 'Unsaved draft');
  const previousWindow = globalThis.window;
  globalThis.window = { confirm: () => false };
  state.request = async () => assert.fail('Should not stop after cancel');
  try {
    await state.stopApp();
    assert.equal(state.stopped, false);
    assert.equal(state.stopping, false);
    assert.equal(state.form.description, 'Unsaved draft');
  } finally { globalThis.window = previousWindow; }
});

test('failed shutdown keeps the app usable and reports the error', async () => {
  const state = new TimeStore();
  state.loading = false;
  state.canShutdown = true;
  state.request = async () => { throw new Error('Could not stop'); };
  await state.stopApp();
  assert.equal(state.stopped, false);
  assert.equal(state.stopping, false);
  assert.equal(state.shutdownError, 'Could not stop');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { NotesStore } from './notes-store.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

function server(initial = null) {
  let saved = initial;
  const request = async (_, options = {}) => {
    if (options.method === 'PUT') saved = JSON.parse(options.body).notes;
    return { notes: saved ?? '', exists: saved !== null };
  };
  return { request, read: () => saved };
}

test('latest multiline notes restore from the backend in a fresh browser', async () => {
  const backend = server();
  const original = new NotesStore(storage());
  await original.load(backend.request);
  original.setNotes('First draft');
  original.setNotes('Latest findings\n\n  Next steps ✓');
  await original.flush();
  const freshBrowser = new NotesStore(storage());
  await freshBrowser.load(backend.request);
  assert.equal(freshBrowser.notes, 'Latest findings\n\n  Next steps ✓');
  assert.equal(freshBrowser.dirty, false);
});

test('existing browser notes migrate once and a saved clear does not restore stale notes', async () => {
  const cache = storage();
  cache.setItem('realtime-focus', JSON.stringify({ notes: 'Existing notes', goal: 'My goal' }));
  const backend = server();
  const original = new NotesStore(cache);
  await original.load(backend.request);
  assert.equal(backend.read(), 'Existing notes');
  await original.clearNotes();
  const oldBrowser = storage();
  oldBrowser.setItem('realtime-focus', JSON.stringify({ notes: 'Existing notes' }));
  const restored = new NotesStore(oldBrowser);
  await restored.load(backend.request);
  assert.equal(restored.notes, '');
  assert.equal(backend.read(), '');
  assert.equal(JSON.parse(cache.getItem('realtime-focus')).goal, 'My goal');
});

test('typing before startup finishes is preserved and saved', async () => {
  const state = new NotesStore(storage());
  let finishLoading;
  let saved;
  const loading = state.load((_, options) => options?.method === 'PUT'
    ? Promise.resolve(saved = JSON.parse(options.body).notes)
    : new Promise(resolve => { finishLoading = resolve; }));
  state.setNotes('Typing during startup');
  finishLoading({ notes: 'Old saved notes', exists: true });
  await loading;
  assert.equal(state.notes, 'Typing during startup');
  assert.equal(saved, 'Typing during startup');
});

test('edits and clear during a save are serialized and flush waits for the latest state', async () => {
  const state = new NotesStore(storage());
  const saves = [];
  let finishSave;
  await state.load(async (_, options) => {
    if (!options) return { notes: '', exists: true };
    saves.push(JSON.parse(options.body).notes);
    return new Promise(resolve => { finishSave = resolve; });
  });
  state.setNotes('First version');
  const saving = state.flush();
  state.setNotes('Final version');
  const waiting = state.flush();
  finishSave({});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saves, ['First version', 'Final version']);
  const clearing = state.clearNotes();
  finishSave({});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saves, ['First version', 'Final version', '']);
  finishSave({});
  assert.equal(await saving, true);
  assert.equal(await waiting, true);
  assert.equal(await clearing, true);
  assert.equal(state.notes, '');
  assert.equal(state.dirty, false);
});

test('failed saves retain the latest draft and recover on next startup', async () => {
  const cache = storage();
  const state = new NotesStore(cache);
  await state.load(async () => ({ notes: 'Saved version', exists: true }));
  state.request = async () => { throw new Error('Offline'); };
  state.setNotes('Unsaved latest version');
  assert.equal(await state.flush(), false);
  assert.match(state.error, /Could not save/);
  const backend = server('Saved version');
  const restored = new NotesStore(cache);
  await restored.load(backend.request);
  assert.equal(restored.notes, 'Unsaved latest version');
  assert.equal(backend.read(), 'Unsaved latest version');
});

test('failed startup does not overwrite server notes and can be retried without browser storage', async () => {
  const unavailable = { getItem() { throw new Error('Disabled'); }, setItem() { throw new Error('Disabled'); } };
  const state = new NotesStore(unavailable);
  const backend = server('Saved version');
  let online = false;
  await state.load((...args) => {
    if (!online) throw new Error('Offline');
    return backend.request(...args);
  });
  state.setNotes('My new draft');
  assert.equal(await state.flush(), false);
  assert.equal(backend.read(), 'Saved version');
  online = true;
  await state.retry();
  assert.equal(backend.read(), 'My new draft');
  assert.equal(state.error, '');
});

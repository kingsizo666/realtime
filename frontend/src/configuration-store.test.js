import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurationStore } from './configuration-store.js';

function tracker() {
  return {
    categories: [], entries: [], form: { category: '', description: 'Keep my draft' }, loading: false, saving: false,
    cellQueue: Promise.resolve(), get activeEntry() { return this.entries.find(entry => !entry.is_submitted); },
  };
}

test('loading and adding categories update the tracker without replacing its draft', async () => {
  const state = tracker();
  const configuration = new ConfigurationStore(state);
  state.request = async () => ({ categories: [{ id: 1, name: 'Research' }] });
  await configuration.load();
  assert.deepEqual(state.categories, ['Research']);
  configuration.setNewName('  Documentation  ');
  state.request = async (url, options) => {
    assert.equal(url, '/api/categories/');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { name: 'Documentation' });
    return { categories: [{ id: 1, name: 'Research' }, { id: 2, name: 'Documentation' }] };
  };
  assert.equal(await configuration.add(), true);
  assert.deepEqual(state.categories, ['Research', 'Documentation']);
  assert.equal(configuration.newName, '');
  assert.equal(state.form.description, 'Keep my draft');
});

test('renaming waits for inline edits and updates entry labels and the current selection', async () => {
  const state = tracker();
  state.entries = [{ id: 5, category: 'Research', is_submitted: false }, { id: 6, category: 'Research', is_submitted: true }];
  state.form.category = 'Research';
  const configuration = new ConfigurationStore(state);
  let finishEdit;
  state.cellQueue = new Promise(resolve => { finishEdit = resolve; });
  let calls = 0;
  state.request = async () => { calls++; return { categories: [{ id: 1, name: 'Deep Research' }] }; };
  const renaming = configuration.rename({ id: 1, name: 'Research' }, 'Deep Research');
  assert.equal(calls, 0);
  assert.equal(state.saving, true);
  finishEdit();
  await renaming;
  assert.equal(calls, 1);
  assert.equal(state.form.category, 'Deep Research');
  assert.equal(state.entries.every(entry => entry.category === 'Deep Research'), true);
  assert.equal(state.form.description, 'Keep my draft');
  assert.equal(state.saving, false);
});

test('removing a category preserves a running entry but clears an unavailable new-task selection', async () => {
  const state = tracker();
  const configuration = new ConfigurationStore(state);
  state.request = async () => ({ categories: [] });
  state.form.category = 'Research';
  state.entries = [{ id: 5, category: 'Research', is_submitted: false }];
  await configuration.remove({ id: 1, name: 'Research' });
  assert.equal(state.form.category, 'Research');
  assert.equal(state.entries[0].category, 'Research');
  state.entries[0].is_submitted = true;
  await configuration.remove({ id: 1, name: 'Research' });
  assert.equal(state.form.category, '');
  assert.equal(state.entries.length, 1);
});

test('failed edits keep the category, input, and tracker state available for retry', async () => {
  const state = tracker();
  state.categories = ['Research'];
  const configuration = new ConfigurationStore(state);
  configuration.setNewName('Research');
  state.request = async () => { throw new Error('A category with that name already exists.'); };
  assert.equal(await configuration.add(), false);
  assert.equal(configuration.newName, 'Research');
  assert.deepEqual(state.categories, ['Research']);
  assert.match(configuration.error, /already exists/);
  assert.equal(configuration.busy, false);
  assert.equal(state.saving, false);
});

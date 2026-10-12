import { makeAutoObservable, runInAction } from 'mobx';
import { store } from './store.js';

export class ConfigurationStore {
  categories = [];
  newName = '';
  loading = false;
  busy = false;
  error = '';
  notice = '';
  tracker = null;

  constructor(tracker = store) {
    this.tracker = tracker;
    makeAutoObservable(this, { tracker: false }, { autoBind: true });
  }

  get working() { return this.loading || this.busy || this.tracker.loading || this.tracker.saving; }
  setNewName(value) { this.newName = value; this.error = ''; this.notice = ''; }

  apply(data) {
    this.categories = data.categories;
    this.tracker.categories = data.categories.map(category => category.name);
  }

  async load() {
    if (this.loading || this.busy) return;
    this.loading = true;
    this.error = '';
    try {
      const data = await this.tracker.request('/api/categories/');
      runInAction(() => { this.apply(data); });
    } catch (error) {
      runInAction(() => { this.error = error.message || 'Could not load categories.'; });
    } finally { runInAction(() => { this.loading = false; }); }
  }

  async change(method, category = null, name = '') {
    if (this.working) return false;
    this.busy = true;
    this.tracker.saving = true;
    this.error = '';
    this.notice = '';
    try {
      await this.tracker.cellQueue;
      const data = await this.tracker.request(category ? `/api/categories/${category.id}/` : '/api/categories/', {
        method, ...(method !== 'DELETE' ? { body: JSON.stringify({ name: name.trim() }) } : {}),
      });
      runInAction(() => {
        this.apply(data);
        if (method === 'PATCH') {
          const renamed = data.categories.find(item => item.id === category.id).name;
          this.tracker.entries = this.tracker.entries.map(entry => entry.category === category.name ? { ...entry, category: renamed } : entry);
          if (this.tracker.form.category === category.name) this.tracker.form.category = renamed;
          this.notice = 'Category renamed.';
        } else if (method === 'DELETE') {
          if (this.tracker.form.category === category.name && this.tracker.activeEntry?.category !== category.name) this.tracker.form.category = '';
          this.notice = 'Category removed. Existing entries are kept.';
        } else {
          this.newName = '';
          this.notice = 'Category added.';
        }
      });
      return true;
    } catch (error) {
      runInAction(() => { this.error = error.message || 'Could not save your categories.'; });
      return false;
    } finally { runInAction(() => { this.busy = false; this.tracker.saving = false; }); }
  }

  add() { return this.change('POST', null, this.newName); }
  rename(category, name) { return this.change('PATCH', category, name); }
  remove(category) { return this.change('DELETE', category); }
}

export const configurationStore = new ConfigurationStore();

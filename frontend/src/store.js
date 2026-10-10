import { makeAutoObservable, runInAction } from 'mobx';
import { duration, entryCellPayload, entryPayload, localFields } from './time.js';
import { applyTheme, readTheme, saveTheme } from './theme.js';

const emptyForm = () => ({ category: '', description: '', date: '', startTime: '', endTime: '' });

export class TimeStore {
  entries = [];
  categories = [];
  form = emptyForm();
  loading = true;
  saving = false;
  error = '';
  notice = '';
  now = Date.now();
  cellQueue = Promise.resolve();
  entryError = '';
  theme = readTheme();
  canShutdown = false;
  stopping = false;
  stopped = false;
  shutdownError = '';

  constructor() {
    const initial = localFields();
    this.form.date = initial.date;
    this.form.startTime = initial.time;
    makeAutoObservable(this, { request: false, cellQueue: false }, { autoBind: true });
  }

  get activeEntry() { return this.entries.find(entry => !entry.is_submitted); }
  get totalSeconds() { return this.entries.filter(entry => entry.is_submitted).reduce((sum, entry) => sum + duration(entry), 0); }
  get completedCount() { return this.entries.filter(entry => entry.is_submitted).length; }
  get hasUnsavedForm() {
    if (!this.activeEntry) return Boolean(this.form.category || this.form.description || this.form.endTime);
    const start = localFields(this.activeEntry.started_at);
    const saved = { category: this.activeEntry.category, description: this.activeEntry.description, date: start.date, startTime: start.time, endTime: this.activeEntry.ended_at ? localFields(this.activeEntry.ended_at).time : '' };
    return Object.keys(saved).some(key => saved[key] !== this.form[key]);
  }

  async stopApp() {
    if (!this.canShutdown || this.stopping || this.stopped || this.saving || this.loading) return;
    this.stopping = true;
    this.shutdownError = '';
    try {
      await this.cellQueue;
      if (this.entryError) throw new Error('An entry change could not be saved. Fix it before stopping the app.');
      if (this.hasUnsavedForm && !window.confirm('Your form has unsaved changes. Stop the app and discard those changes? Saved entries will be kept.')) return;
      const data = await this.request('/api/shutdown/', { method: 'POST' });
      if (!data.stopping) throw new Error('Could not stop the app. Please try again.');
      runInAction(() => { this.stopped = true; });
    } catch (error) {
      runInAction(() => { this.shutdownError = error.message || 'Could not stop the app.'; });
    } finally {
      runInAction(() => { this.stopping = false; });
    }
  }

  tick() { this.now = Date.now(); }
  toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    applyTheme(this.theme);
    saveTheme(this.theme);
  }
  updateField(name, value) { this.form[name] = value; this.error = ''; this.notice = ''; }

  resumeEntry(entry) {
    const start = localFields(entry.started_at);
    this.form = { category: entry.category, description: entry.description, date: start.date, startTime: start.time, endTime: entry.ended_at ? localFields(entry.ended_at).time : '' };
  }

  saveCell(entryId, field, value) {
    // Serialize blur saves so moving directly between cells cannot drop an edit.
    const operation = this.cellQueue.then(async () => {
      const entry = this.entries.find(item => item.id === entryId);
      if (!entry) return false;
      runInAction(() => { this.entryError = ''; });
      try {
        const data = await this.request(`/api/entries/${entryId}/`, { method: 'PATCH', body: JSON.stringify(entryCellPayload(entry, field, value)) });
        runInAction(() => {
          this.entries = this.entries.map(item => item.id === entryId ? data.entry : item);
          if (!data.entry.is_submitted) {
            if (field === 'description') this.form.description = data.entry.description;
            else {
              this.form.startTime = localFields(data.entry.started_at).time;
              this.form.endTime = data.entry.ended_at ? localFields(data.entry.ended_at).time : '';
            }
          }
        });
        return true;
      } catch (error) {
        runInAction(() => { this.entryError = error.message || 'Could not update your entry.'; });
        return false;
      }
    });
    this.cellQueue = operation.then(() => undefined);
    return operation;
  }

  async deleteEntry(entry) {
    if (this.saving) return;
    this.saving = true;
    this.entryError = '';
    try {
      await this.cellQueue;
      await this.request(`/api/entries/${entry.id}/`, { method: 'DELETE' });
      runInAction(() => {
        this.entries = this.entries.filter(item => item.id !== entry.id);
        if (!entry.is_submitted) { this.form = emptyForm(); this.error = ''; this.notice = ''; }
      });
    } catch (error) {
      runInAction(() => { this.entryError = error.message || 'Could not delete your entry.'; });
    } finally {
      runInAction(() => { this.saving = false; });
    }
  }

  async request(url, options = {}) {
    const token = document.cookie.split('; ').find(cookie => cookie.startsWith('csrftoken='))?.split('=')[1];
    const response = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-CSRFToken': token } : {}), ...options.headers },
    });
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('The server is unavailable. Please try again.');
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  async load() {
    this.loading = true;
    this.error = '';
    try {
      const data = await this.request('/api/entries/');
      runInAction(() => {
        this.entries = data.entries;
        this.categories = data.categories;
        this.canShutdown = Boolean(data.can_shutdown);
        if (this.activeEntry) {
          this.resumeEntry(this.activeEntry);
        }
      });
    } catch (error) {
      runInAction(() => { this.error = error.message || 'Could not connect to Django. Check that the server is running.'; });
    } finally {
      runInAction(() => { this.loading = false; });
    }
  }

  async save() {
    if (this.saving || this.loading) return;
    this.saving = true;
    this.error = '';
    this.notice = '';
    try {
      await this.cellQueue;
      const active = this.activeEntry;
      const data = await this.request(active ? `/api/entries/${active.id}/finish/` : '/api/entries/', {
        method: 'POST',
        body: JSON.stringify(entryPayload(this.form)),
      });
      runInAction(() => {
        if (active) {
          this.entries = this.entries.map(entry => entry.id === active.id ? data.entry : entry);
          this.form = emptyForm();
          this.notice = 'Entry submitted. You’re ready for your next task.';
        } else {
          this.entries = [data.entry, ...this.entries].sort((a, b) => new Date(b.started_at) - new Date(a.started_at) || b.id - a.id);
          this.notice = 'Entry added. Press Submit when you’re finished.';
        }
      });
    } catch (error) {
      runInAction(() => { this.error = error.message || 'Could not save your entry. Please try again.'; });
    } finally {
      runInAction(() => { this.saving = false; });
    }
  }
}

export const store = new TimeStore();

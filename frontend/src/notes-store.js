import { makeAutoObservable, runInAction } from 'mobx';

const STORAGE_KEY = 'realtime-notes';

export class NotesStore {
  notes = '';
  loaded = false;
  loading = false;
  saving = false;
  dirty = false;
  error = '';
  revision = 0;
  request = null;
  savePromise = null;
  saveTimer = null;
  storage = null;
  browser = null;

  constructor(storage, browser = globalThis.window) {
    this.browser = browser;
    try {
      this.storage = storage ?? globalThis.localStorage ?? null;
      const cached = JSON.parse(this.storage?.getItem(STORAGE_KEY) || 'null');
      const legacy = cached ?? JSON.parse(this.storage?.getItem('realtime-focus') || '{}');
      if (typeof legacy?.notes === 'string') this.notes = legacy.notes;
      this.dirty = cached?.pending === true;
    } catch {}
    makeAutoObservable(this, { storage: false, browser: false, request: false, savePromise: false, saveTimer: false }, { autoBind: true });
  }

  cache() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify({ notes: this.notes, pending: this.dirty })); } catch {}
  }

  async load(request = this.request) {
    if (this.loading || this.loaded || !request) return;
    this.request = request;
    this.loading = true;
    const revision = this.revision;
    try {
      const data = await request('/api/notepad/');
      runInAction(() => {
        // Preserve typing or an unsaved draft from a previous session.
        if (revision === this.revision && !this.dirty && data.exists) this.notes = data.notes;
        if (!data.exists && this.notes) this.dirty = true;
        this.loaded = true;
        this.error = '';
        this.cache();
      });
    } catch {
      runInAction(() => { this.error = 'Could not load saved notes. Your draft is kept in this browser.'; });
    } finally {
      runInAction(() => { this.loading = false; });
    }
    if (this.loaded && this.dirty) await this.flush();
  }

  setNotes(value) {
    this.notes = value;
    this.revision++;
    this.dirty = true;
    this.cache();
    this.browser?.clearTimeout(this.saveTimer);
    if (this.loaded) this.saveTimer = this.browser?.setTimeout(this.flush, 300) ?? null;
  }

  clearNotes() { this.setNotes(''); return this.flush(); }

  async flush() {
    this.browser?.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.loaded) return !this.dirty;
    if (this.savePromise) return this.savePromise;
    this.savePromise = this.save();
    try { return await this.savePromise; }
    finally { this.savePromise = null; }
  }

  async save() {
    this.saving = true;
    try {
      // Serialize saves so an older response cannot replace the latest edit.
      while (this.dirty) {
        const revision = this.revision;
        const body = JSON.stringify({ notes: this.notes });
        await this.request('/api/notepad/', { method: 'PUT', body, keepalive: new TextEncoder().encode(body).byteLength < 60_000 });
        runInAction(() => {
          if (revision === this.revision) this.dirty = false;
          this.error = '';
          this.cache();
        });
      }
      return true;
    } catch {
      runInAction(() => { this.error = 'Could not save notes. Your draft is kept in this browser.'; });
      return false;
    } finally { runInAction(() => { this.saving = false; }); }
  }

  async retry() {
    if (!this.loaded) await this.load();
    else await this.flush();
  }
}

export const notesStore = new NotesStore();

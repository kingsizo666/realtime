import { makeAutoObservable, runInAction } from 'mobx';

const STORAGE_KEY = 'realtime-focus';

export class FocusStore {
  minutes = '25';
  remainingMs = 25 * 60_000;
  deadline = null;
  now = Date.now();
  completed = false;
  timerError = '';
  goal = '';
  goalStarted = false;
  goalCompleted = false;
  notes = '';
  storage = null;
  request = null;
  connected = false;
  busy = false;
  refreshing = false;
  revision = 0;
  blockEnabled = false;
  blocker = { available: false, running_apps: [], message: 'Open Realtime.exe to use app blocking.' };
  apps = [];
  appError = '';
  appBusy = false;

  constructor(storage, now = Date.now()) {
    this.now = now;
    try {
      this.storage = storage ?? globalThis.localStorage ?? null;
      const saved = JSON.parse(this.storage?.getItem(STORAGE_KEY) || '{}');
      if (Number.isInteger(saved.revision) && saved.revision >= 0) this.revision = saved.revision;
      const minutes = Number(saved.minutes);
      if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 180) {
        this.minutes = String(minutes);
        const duration = minutes * 60_000;
        if (Number.isFinite(saved.remainingMs) && saved.remainingMs >= 0 && saved.remainingMs <= duration) this.remainingMs = saved.remainingMs;
        else this.remainingMs = duration;
        if (Number.isFinite(saved.deadline) && saved.deadline > 0) this.deadline = saved.deadline;
        this.completed = saved.completed === true && this.remainingMs === 0;
      }
      if (typeof saved.goal === 'string') this.goal = saved.goal.slice(0, 1000);
      this.goalCompleted = saved.goalCompleted === true && Boolean(this.goal.trim());
      this.goalStarted = Boolean(this.goal.trim()) && (saved.goalStarted === true || this.goalCompleted);
      if (typeof saved.notes === 'string') this.notes = saved.notes;
    } catch {
      // The panels remain usable if browser storage is disabled or corrupted.
    }
    makeAutoObservable(this, { storage: false, request: false }, { autoBind: true });
    this.tick(now);
  }

  get running() { return this.deadline !== null; }
  get validMinutes() { return /^\d+$/.test(this.minutes) && Number(this.minutes) >= 1 && Number(this.minutes) <= 180; }
  get durationMs() { return (this.validMinutes ? Number(this.minutes) : 25) * 60_000; }
  get secondsLeft() { return Math.ceil((this.running ? Math.max(0, this.deadline - this.now) : this.remainingMs) / 1000); }
  get timeLabel() { return `${String(Math.floor(this.secondsLeft / 60)).padStart(2, '0')}:${String(this.secondsLeft % 60).padStart(2, '0')}`; }
  get progress() { return Math.max(0, Math.min(1, 1 - this.secondsLeft * 1000 / this.durationMs)); }
  get timerStatus() { return this.completed ? 'Focus session complete.' : this.running ? 'Time to focus.' : this.remainingMs < this.durationMs ? 'Paused. Resume when ready.' : 'Press start when ready.'; }
  get goalActive() { return this.goalStarted && !this.goalCompleted; }
  get canSetGoal() { return Boolean(this.goal.trim()) && !this.goalActive; }
  get goalStatus() { return this.goalCompleted ? 'Goal complete. Well done.' : this.goalActive ? 'In progress' : 'Set a goal to begin.'; }

  applyRemote(data, forceMinutes = false) {
    if (data.blocker) this.blocker = data.blocker;
    if (data.apps) this.apps = data.apps;
    if (!data.focus) return;
    const focus = data.focus;
    if (!forceMinutes && focus.revision === this.revision && !focus.deadline) return;
    // Keep an unsaved duration draft while paused; another tab's changes still sync.
    if (forceMinutes || focus.revision !== this.revision || focus.deadline) this.minutes = String(focus.minutes);
    this.revision = focus.revision;
    this.remainingMs = focus.remaining_ms;
    this.deadline = focus.deadline ? Date.parse(focus.deadline) : null;
    this.completed = focus.completed;
    this.blockEnabled = focus.block_enabled;
    this.now = Date.now();
    this.persist();
  }

  async connect(request) {
    if (this.busy) return;
    this.request = request;
    this.busy = true;
    try {
      let data = await request('/api/focus/');
      if (!data.exists) data = await request('/api/focus/', { method: 'POST', body: JSON.stringify({
        action: 'restore', minutes: this.validMinutes ? Number(this.minutes) : 25,
        remaining_ms: this.remainingMs, deadline: this.deadline, completed: this.completed,
      }) });
      runInAction(() => {
        const draft = this.validMinutes && !this.running && !data.focus?.deadline && data.focus?.revision === this.revision && String(data.focus.minutes) !== this.minutes ? this.minutes : null;
        this.applyRemote(data, true);
        if (draft !== null) this.setMinutes(draft);
        this.connected = true;
        this.timerError = '';
      });
    } catch (error) { runInAction(() => { this.timerError = error.message || 'Could not load focus timer.'; }); }
    finally { runInAction(() => { this.busy = false; }); }
  }

  async refresh() {
    if (!this.request || this.busy || this.refreshing) return;
    if (!this.connected) return this.connect(this.request);
    this.refreshing = true;
    const revision = this.revision;
    try {
      const data = await this.request('/api/focus/');
      runInAction(() => { if (!this.busy && this.revision === revision) this.applyRemote(data); });
    } catch { runInAction(() => { this.blocker = { ...this.blocker, available: false, message: 'Cannot reach Realtime. App blocking is released.' }; }); }
    finally { runInAction(() => { this.refreshing = false; }); }
  }

  async command(action, extra = {}) {
    if (!this.connected || this.busy) return false;
    if (['start', 'reset'].includes(action) && !this.validMinutes) { this.timerError = 'Choose 1 to 180 minutes.'; return false; }
    this.busy = true;
    this.timerError = '';
    const previousBlocking = this.blockEnabled;
    if (action === 'blocking') this.blockEnabled = extra.enabled;
    try {
      const data = await this.request('/api/focus/', { method: 'POST', body: JSON.stringify({ action, revision: this.revision, minutes: Number(this.minutes), ...extra }) });
      runInAction(() => { this.applyRemote(data, true); });
      return true;
    } catch (error) {
      runInAction(() => { this.blockEnabled = previousBlocking; });
      // Refresh after conflicts so a retry uses the current server revision.
      try { const data = await this.request('/api/focus/'); runInAction(() => { this.applyRemote(data, true); }); } catch {}
      runInAction(() => { this.timerError = error.message || 'Could not update focus timer.'; });
      return false;
    } finally { runInAction(() => { this.busy = false; }); }
  }

  async loadApps() {
    if (!this.request || this.appBusy) return;
    this.appBusy = true;
    this.appError = '';
    try {
      const data = await this.request('/api/blocked-apps/');
      runInAction(() => { this.applyRemote(data); });
    } catch (error) { runInAction(() => { this.appError = error.message || 'Could not load apps.'; }); }
    finally { runInAction(() => { this.appBusy = false; }); }
  }

  async changeApp(app, remove = false) {
    if (!this.request || this.appBusy) return;
    this.appBusy = true;
    this.appError = '';
    try {
      const data = await this.request(remove ? `/api/blocked-apps/${app.id}/` : '/api/blocked-apps/', {
        method: remove ? 'DELETE' : 'POST', ...(remove ? {} : { body: JSON.stringify({ path: app.path }) }),
      });
      runInAction(() => { this.applyRemote(data); });
    } catch (error) { runInAction(() => { this.appError = error.message || 'Could not update apps.'; }); }
    finally { runInAction(() => { this.appBusy = false; }); }
  }

  persist() {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify({
        minutes: this.validMinutes ? this.minutes : '25', remainingMs: this.remainingMs, revision: this.revision,
        deadline: this.deadline, completed: this.completed, goal: this.goal,
        goalStarted: this.goalStarted, goalCompleted: this.goalCompleted,
        notes: this.notes,
      }));
    } catch {}
  }

  tick(now = Date.now()) {
    this.now = now;
    if (this.running && now >= this.deadline) {
      this.deadline = null;
      this.remainingMs = 0;
      this.completed = true;
      this.persist();
    }
  }

  setMinutes(value) {
    if (this.running) return;
    this.minutes = value;
    this.timerError = '';
    if (this.validMinutes) {
      this.remainingMs = this.durationMs;
      this.completed = false;
      this.persist();
    }
  }

  start(now = Date.now()) {
    if (this.running) return;
    if (!this.validMinutes) { this.timerError = 'Choose 1 to 180 minutes.'; return; }
    this.now = now;
    if (this.remainingMs <= 0) this.remainingMs = this.durationMs;
    this.deadline = now + this.remainingMs;
    this.completed = false;
    this.timerError = '';
    this.persist();
  }

  pause(now = Date.now()) {
    if (!this.running) return;
    this.tick(now);
    if (!this.running) return;
    this.remainingMs = Math.max(0, this.deadline - now);
    this.deadline = null;
    this.persist();
  }

  reset() {
    this.deadline = null;
    this.remainingMs = this.durationMs;
    this.completed = false;
    this.timerError = '';
    this.persist();
  }

  setGoal(value) {
    const next = value.slice(0, 1000);
    if (next === this.goal) return;
    this.goal = next;
    this.goalStarted = false;
    this.goalCompleted = false;
    this.persist();
  }

  startGoal() {
    if (!this.canSetGoal) return;
    this.goal = this.goal.trim();
    this.goalStarted = true;
    this.goalCompleted = false;
    this.persist();
  }

  completeGoal() {
    if (!this.goalActive) return;
    this.goalCompleted = true;
    this.persist();
  }

  setNotes(value) {
    this.notes = value;
    this.persist();
  }

  clearNotes() {
    this.setNotes('');
  }
}

export const focusStore = new FocusStore();

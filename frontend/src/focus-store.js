import { makeAutoObservable } from 'mobx';

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
  storage = null;

  constructor(storage, now = Date.now()) {
    this.now = now;
    try {
      this.storage = storage ?? globalThis.localStorage ?? null;
      const saved = JSON.parse(this.storage?.getItem(STORAGE_KEY) || '{}');
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
    } catch {
      // The panels remain usable if browser storage is disabled or corrupted.
    }
    makeAutoObservable(this, { storage: false }, { autoBind: true });
    this.tick(now);
  }

  get running() { return this.deadline !== null; }
  get validMinutes() { return /^\d+$/.test(this.minutes) && Number(this.minutes) >= 1 && Number(this.minutes) <= 180; }
  get durationMs() { return (this.validMinutes ? Number(this.minutes) : 25) * 60_000; }
  get secondsLeft() { return Math.ceil((this.running ? Math.max(0, this.deadline - this.now) : this.remainingMs) / 1000); }
  get timeLabel() { return `${String(Math.floor(this.secondsLeft / 60)).padStart(2, '0')}:${String(this.secondsLeft % 60).padStart(2, '0')}`; }
  get progress() { return Math.max(0, Math.min(1, 1 - this.secondsLeft * 1000 / this.durationMs)); }
  get timerStatus() { return this.completed ? 'Focus session complete.' : this.running ? 'Time to focus.' : this.remainingMs < this.durationMs ? 'Paused. Resume when ready.' : 'Ready when you are.'; }
  get goalActive() { return this.goalStarted && !this.goalCompleted; }
  get canSetGoal() { return Boolean(this.goal.trim()) && !this.goalActive; }
  get goalStatus() { return this.goalCompleted ? 'Goal complete. Well done.' : this.goalActive ? 'In progress' : 'Set a goal to begin.'; }

  persist() {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify({
        minutes: this.validMinutes ? this.minutes : '25', remainingMs: this.remainingMs,
        deadline: this.deadline, completed: this.completed, goal: this.goal,
        goalStarted: this.goalStarted, goalCompleted: this.goalCompleted,
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
}

export const focusStore = new FocusStore();

import { makeAutoObservable, runInAction } from 'mobx';

const CALLBACK_ORIGIN = 'http://127.0.0.1:8000';

export class SpotifyStore {
  configured = false;
  connected = false;
  loaded = false;
  playback = null;
  error = '';
  clientId = '';
  connecting = false;
  busy = false;
  refreshing = false;
  refreshQueued = false;
  retryAt = 0;
  epoch = 0;
  popup = null;
  pollTimer = null;
  popupTimer = null;
  commandTimer = null;
  browser = null;

  constructor(browser = globalThis.window ?? null) {
    this.browser = browser;
    makeAutoObservable(this, { browser: false, request: false, popup: false, pollTimer: false, popupTimer: false, commandTimer: false }, { autoBind: true });
  }

  get playing() { return this.playback?.is_playing === true; }
  get statusText() {
    if (!this.loaded) return 'Loading Spotify…';
    if (this.connecting) return 'Finish signing in to Spotify.';
    if (!this.connected) return 'Connect to control your music.';
    if (!this.playback?.available) return 'Open Spotify and start a song.';
    return this.playback.device || (this.playing ? 'Playing' : 'Paused');
  }

  canControl(action) {
    if (!this.connected || !this.playback?.available || this.busy || this.connecting || Date.now() < this.retryAt) return false;
    const restriction = { play: 'resuming', pause: 'pausing', next: 'skipping_next', previous: 'skipping_prev' }[action];
    return Boolean(restriction) && !this.playback.disallows?.[restriction];
  }

  setClientId(value) { this.clientId = value; this.error = ''; }

  editSetup() {
    if (this.connected || this.connecting || this.busy) return;
    this.configured = false;
    this.clientId = '';
    this.error = '';
  }

  async request(url, options = {}) {
    const token = this.browser?.document.cookie.split('; ').find(cookie => cookie.startsWith('csrftoken='))?.split('=')[1];
    try {
      const response = await fetch(url, {
        ...options, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-CSRFToken': token } : {}) },
      });
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Restart Realtime to enable Spotify, then refresh the page.');
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error || 'Could not connect to Spotify.');
        error.status = response.status;
        error.retryAfter = data.retry_after;
        throw error;
      }
      return data;
    } catch (error) {
      if (error instanceof TypeError) throw new Error('Cannot reach the app. Check that Realtime is running.');
      throw error;
    }
  }

  report(error) {
    this.error = error.message || 'Could not connect to Spotify.';
    if (error.status === 401) { this.connected = false; this.playback = null; }
    if (error.status === 429) this.retryAt = Date.now() + Math.max(1, Number(error.retryAfter) || 30) * 1000;
  }

  async refresh({ queue = false } = {}) {
    if (this.refreshing) {
      if (queue) this.refreshQueued = true;
      return;
    }
    if (this.busy || Date.now() < this.retryAt) return;
    this.refreshing = true;
    const epoch = this.epoch;
    try {
      const data = await this.request('/api/spotify/status/');
      runInAction(() => {
        if (epoch !== this.epoch) return;
        this.configured = data.configured;
        this.connected = data.connected;
        this.playback = data.playback;
        this.loaded = true;
        this.error = '';
        if (data.connected && this.popupTimer !== null) this.finishConnection();
      });
    } catch (error) {
      runInAction(() => { if (epoch === this.epoch) { this.loaded = true; this.report(error); } });
    } finally {
      runInAction(() => { this.refreshing = false; });
      if (this.refreshQueued) {
        runInAction(() => { this.refreshQueued = false; });
        await this.refresh();
      }
    }
  }

  start() {
    if (!this.browser || this.pollTimer !== null) return;
    this.browser.addEventListener('message', this.onMessage);
    this.browser.document.addEventListener('visibilitychange', this.onVisibility);
    this.refresh();
    this.pollTimer = this.browser.setInterval(() => {
      if (this.connected && !this.browser.document.hidden) this.refresh();
    }, 10_000);
  }

  onVisibility() { if (!this.browser.document.hidden && (this.connected || this.popupTimer !== null)) this.refresh(); }

  stop() {
    this.epoch++;
    this.refreshQueued = false;
    if (!this.browser) return;
    this.browser.removeEventListener('message', this.onMessage);
    this.browser.document.removeEventListener('visibilitychange', this.onVisibility);
    this.browser.clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.clearPopupTimer();
    this.browser.clearTimeout(this.commandTimer);
    this.commandTimer = null;
    this.popup?.close();
    this.popup = null;
    this.connecting = false;
  }

  clearPopupTimer() {
    this.browser?.clearInterval(this.popupTimer);
    this.popupTimer = null;
  }

  finishConnection() {
    this.clearPopupTimer();
    if (this.popup && !this.popup.closed) this.popup.close();
    this.popup = null;
    this.connecting = false;
  }

  async connect() {
    if (!this.browser || this.connecting || this.busy) return;
    if (!this.configured && !/^[a-fA-F0-9]{32}$/.test(this.clientId.trim())) {
      this.error = 'Enter the Client ID from your Spotify app.';
      return;
    }
    this.clearPopupTimer();
    this.popup = this.browser.open('about:blank', 'realtime-spotify', 'popup,width=500,height=700');
    if (!this.popup) { this.error = 'Allow pop-ups for Realtime, then connect again.'; return; }
    this.connecting = true;
    this.error = '';
    const epoch = ++this.epoch;
    try {
      const data = await this.request('/api/spotify/connect/', {
        method: 'POST', body: JSON.stringify(this.configured ? {} : { client_id: this.clientId.trim() }),
      });
      if (epoch !== this.epoch || !this.popup || this.popup.closed) throw new Error('Spotify connection canceled.');
      // The authorization URL comes from our local backend; restrict its target.
      const url = new URL(data.url);
      if (url.origin !== 'https://accounts.spotify.com' || url.pathname !== '/authorize') throw new Error('Invalid Spotify sign-in address.');
      this.popup.location.href = url.href;
      runInAction(() => { this.configured = true; this.clientId = ''; });
      const deadline = Date.now() + 10 * 60_000;
      this.popupTimer = this.browser.setInterval(() => {
        if (epoch !== this.epoch) return;
        if (Date.now() >= deadline) {
          this.finishConnection();
          return;
        }
        if (this.popup?.closed) {
          runInAction(() => {
            this.popup = null;
            this.connecting = false;
          });
        }
        // Browsers can sever the popup's opener before consent completes.
        // Keep checking the backend even when its window reference is closed.
        return this.refresh();
      }, 2000);
    } catch (error) {
      runInAction(() => {
        if (epoch !== this.epoch) return;
        this.popup?.close();
        this.popup = null;
        this.connecting = false;
        this.report(error);
      });
    }
  }

  async onMessage(event) {
    if (event.origin !== CALLBACK_ORIGIN || !this.popup || event.source !== this.popup || event.data?.type !== 'realtime-spotify') return;
    this.finishConnection();
    if (!event.data.success) { this.error = event.data.error || 'Spotify connection canceled.'; return; }
    await this.refresh({ queue: true });
  }

  async command(action) {
    if (!this.canControl(action)) return;
    this.busy = true;
    this.error = '';
    const epoch = ++this.epoch;
    try {
      await this.request('/api/spotify/control/', { method: 'POST', body: JSON.stringify({ action }) });
      runInAction(() => {
        if (epoch !== this.epoch) return;
        if (this.playback && (action === 'play' || action === 'pause')) this.playback.is_playing = action === 'play';
        this.browser?.clearTimeout(this.commandTimer);
        // Spotify may take a moment to report the command's new playback state.
        this.commandTimer = this.browser?.setTimeout(this.refresh, 650) ?? null;
      });
    } catch (error) {
      runInAction(() => { if (epoch === this.epoch) this.report(error); });
    } finally {
      runInAction(() => { this.busy = false; });
    }
  }

  async disconnect() {
    if (this.busy || this.connecting) return;
    this.busy = true;
    this.error = '';
    const epoch = ++this.epoch;
    try {
      await this.request('/api/spotify/disconnect/', { method: 'POST', body: '{}' });
      runInAction(() => { if (epoch === this.epoch) { this.connected = false; this.playback = null; } });
    } catch (error) {
      runInAction(() => { if (epoch === this.epoch) this.report(error); });
    } finally {
      runInAction(() => { this.busy = false; });
    }
  }
}

export const spotifyStore = new SpotifyStore();

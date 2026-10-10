import test from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyStore } from './spotify-store.js';

const playback = { name: 'Song', artist: 'Artist', device: 'Computer', is_playing: true, available: true, disallows: {} };
const status = { configured: true, connected: true, playback };

function fakeBrowser() {
  const timers = new Map();
  let next = 0;
  const popup = { closed: false, location: {}, close() { this.closed = true; } };
  return {
    timers, popup,
    open: () => popup,
    document: { cookie: '', hidden: false, addEventListener() {}, removeEventListener() {} },
    addEventListener() {}, removeEventListener() {},
    setInterval(callback) { timers.set(++next, callback); return next; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(callback) { timers.set(++next, callback); return next; },
    clearTimeout(id) { timers.delete(id); },
  };
}

test('disconnected, idle, paused and restricted devices have appropriate controls', async () => {
  const state = new SpotifyStore();
  state.request = async () => ({ configured: false, connected: false, playback: null });
  await state.refresh();
  assert.equal(state.loaded, true);
  assert.equal(state.canControl('play'), false);
  state.connected = true;
  assert.equal(state.statusText, 'Open Spotify and start a song.');
  state.playback = { ...playback, is_playing: false, disallows: { skipping_next: true } };
  assert.equal(state.playing, false);
  assert.equal(state.canControl('play'), true);
  assert.equal(state.canControl('next'), false);
  state.playback.available = false;
  assert.equal(state.canControl('previous'), false);
});

test('login uses a popup and accepts messages only from that popup and the callback origin', async () => {
  const browser = fakeBrowser();
  const state = new SpotifyStore(browser);
  state.clientId = 'a'.repeat(32);
  const calls = [];
  state.request = async (url, options) => {
    calls.push(url);
    if (url.endsWith('/connect/')) {
      assert.deepEqual(JSON.parse(options.body), { client_id: 'a'.repeat(32) });
      return { url: 'https://accounts.spotify.com/authorize?state=example' };
    }
    return status;
  };
  await state.connect();
  assert.equal(state.connecting, true);
  assert.equal(browser.popup.location.href, 'https://accounts.spotify.com/authorize?state=example');
  const message = { origin: 'http://127.0.0.1:8000', source: browser.popup, data: { type: 'realtime-spotify', success: true } };
  await state.onMessage({ ...message, origin: 'https://untrusted.example' });
  await state.onMessage({ ...message, source: {} });
  assert.equal(state.connecting, true);
  assert.equal(calls.length, 1);
  await state.onMessage(message);
  assert.equal(state.connected, true);
  assert.equal(state.playback.name, 'Song');
  assert.equal(state.connecting, false);
  assert.equal(browser.popup.closed, true);
  assert.equal(browser.timers.size, 0);
});

test('invalid setup, blocked popups and denied consent remain recoverable', async () => {
  const browser = fakeBrowser();
  const state = new SpotifyStore(browser);
  let calls = 0;
  state.request = async () => { calls++; return { url: 'https://accounts.spotify.com/authorize' }; };
  await state.connect();
  assert.equal(calls, 0);
  assert.match(state.error, /Client ID/);
  state.configured = true;
  browser.open = () => null;
  await state.connect();
  assert.match(state.error, /pop-ups/);
  browser.open = () => browser.popup;
  await state.connect();
  await state.onMessage({ origin: 'http://127.0.0.1:8000', source: browser.popup, data: { type: 'realtime-spotify', success: false, error: 'Spotify connection canceled.' } });
  assert.equal(state.connected, false);
  assert.equal(state.connecting, false);
  assert.match(state.error, /canceled/);
  state.editSetup();
  assert.equal(state.configured, false);
  assert.equal(state.clientId, '');
});

test('sign-in updates without a popup message even if the opener is severed before consent', async () => {
  const browser = fakeBrowser();
  const state = new SpotifyStore(browser);
  state.configured = true;
  let authorized = false;
  let connections = 0;
  state.request = async url => {
    if (url.endsWith('/connect/')) {
      connections++;
      return { url: 'https://accounts.spotify.com/authorize' };
    }
    return authorized ? status : { configured: true, connected: false, playback: null };
  };
  await state.connect();
  const checkConnection = browser.timers.get(state.popupTimer);
  browser.popup.closed = true;
  await checkConnection();
  assert.equal(state.connected, false);
  assert.equal(state.connecting, false);
  assert.notEqual(state.popupTimer, null);
  authorized = true;
  await checkConnection();
  assert.equal(state.connected, true);
  assert.equal(state.playback.name, 'Song');
  assert.equal(connections, 1);
  assert.equal(browser.timers.size, 0);
});

test('backend confirmation completes sign-in when an open popup cannot notify the app', async () => {
  const browser = fakeBrowser();
  const state = new SpotifyStore(browser);
  state.configured = true;
  state.request = async url => url.endsWith('/connect/')
    ? { url: 'https://accounts.spotify.com/authorize' } : status;
  await state.connect();
  await browser.timers.get(state.popupTimer)();
  assert.equal(state.connected, true);
  assert.equal(state.connecting, false);
  assert.equal(browser.popup.closed, true);
  assert.equal(browser.timers.size, 0);
});

test('callback queues a fresh status check behind a stale request already in progress', async () => {
  const browser = fakeBrowser();
  const state = new SpotifyStore(browser);
  state.configured = true;
  let finishOldPoll;
  let polls = 0;
  state.request = url => {
    if (url.endsWith('/connect/')) return Promise.resolve({ url: 'https://accounts.spotify.com/authorize' });
    polls++;
    return polls === 1 ? new Promise(resolve => { finishOldPoll = resolve; }) : Promise.resolve(status);
  };
  const polling = state.refresh();
  await state.connect();
  await state.onMessage({ origin: 'http://127.0.0.1:8000', source: browser.popup, data: { type: 'realtime-spotify', success: true } });
  finishOldPoll({ configured: true, connected: false, playback: null });
  await polling;
  assert.equal(polls, 2);
  assert.equal(state.connected, true);
  assert.equal(state.playback.name, 'Song');
  assert.equal(browser.timers.size, 0);
});

test('connection checks stop after the sign-in timeout or store cleanup', async () => {
  const browser = fakeBrowser();
  const state = new SpotifyStore(browser);
  state.configured = true;
  state.request = async () => ({ url: 'https://accounts.spotify.com/authorize' });
  let now = 1000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    await state.connect();
    now += 10 * 60_000;
    await browser.timers.get(state.popupTimer)();
    assert.equal(state.connected, false);
    assert.equal(state.connecting, false);
    assert.equal(browser.timers.size, 0);
    browser.popup.closed = false;
    await state.connect();
    state.stop();
    assert.equal(browser.timers.size, 0);
  } finally { Date.now = originalNow; }
});

test('playback commands serialize and update play state after a successful request', async () => {
  const state = new SpotifyStore(fakeBrowser());
  state.connected = true;
  state.playback = { ...playback };
  let finish;
  const sent = [];
  state.request = (url, options) => {
    sent.push(JSON.parse(options.body).action);
    return new Promise(resolve => { finish = resolve; });
  };
  const pausing = state.command('pause');
  await state.command('next');
  assert.deepEqual(sent, ['pause']);
  finish({ sent: true });
  await pausing;
  assert.equal(state.playing, false);
  assert.equal(state.busy, false);
  state.stop();
  assert.equal(state.browser.timers.size, 0);
});

test('a late poll cannot restore a disconnected account', async () => {
  const state = new SpotifyStore();
  state.connected = true;
  state.playback = { ...playback };
  let finish;
  state.request = url => url.endsWith('/status/') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ disconnected: true });
  const polling = state.refresh();
  await state.disconnect();
  finish(status);
  await polling;
  assert.equal(state.connected, false);
  assert.equal(state.playback, null);
});

test('expired access and rate limits stop repeated commands and polling', async () => {
  const state = new SpotifyStore();
  state.connected = true;
  state.playback = { ...playback };
  let calls = 0;
  state.request = async () => { calls++; throw Object.assign(new Error('Wait for Spotify.'), { status: 429, retryAfter: 20 }); };
  await state.command('next');
  await state.refresh();
  await state.command('next');
  assert.equal(calls, 1);
  state.retryAt = 0;
  state.request = async () => { throw Object.assign(new Error('Reconnect Spotify.'), { status: 401 }); };
  await state.refresh();
  assert.equal(state.connected, false);
  assert.equal(state.playback, null);
  assert.equal(state.error, 'Reconnect Spotify.');
});

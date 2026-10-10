const STORAGE_KEY = 'realtime-theme';

export function readTheme() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#15151c' : '#f7f8fb');
}

export function saveTheme(theme) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, theme);
  } catch {
    // The toggle still works when browser storage is unavailable.
  }
}

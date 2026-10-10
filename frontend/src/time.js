const pad = (number) => String(number).padStart(2, '0');

export function localFields(value = new Date()) {
  const date = new Date(value);
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

export function entryPayload(form) {
  const started = new Date(`${form.date}T${form.startTime}`);
  if (Number.isNaN(started.getTime())) throw new Error('Choose a valid date and start time.');
  let ended = null;
  if (form.endTime) {
    ended = new Date(`${form.date}T${form.endTime}`);
    if (Number.isNaN(ended.getTime())) throw new Error('Choose a valid end time.');
    // An earlier clock time belongs to the following day (an overnight session).
    if (ended < started) ended.setDate(ended.getDate() + 1);
  }
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    category: form.category,
    description: form.description,
    started_at: started.toISOString(),
    ended_at: ended?.toISOString() ?? null,
  };
}

export function duration(entry, now = Date.now()) {
  return Math.max(0, (new Date(entry.ended_at || now) - new Date(entry.started_at)) / 1000);
}

export function formatDuration(seconds) {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${minutes}m`;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export function groupEntriesByDate(entries) {
  const groups = new Map();
  const sorted = [...entries].sort((a, b) => new Date(b.started_at) - new Date(a.started_at) || b.id - a.id);
  for (const entry of sorted) {
    const date = localFields(entry.started_at).date;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(entry);
  }
  return [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([date, entries]) => ({ date, entries }));
}

export function formatClock(value) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function entryCellPayload(entry, field, value) {
  if (field === 'description') return { description: value };
  const start = localFields(entry.started_at);
  const payload = entryPayload({
    date: start.date,
    startTime: field === 'startTime' ? value : start.time,
    endTime: field === 'endTime' ? value : (entry.ended_at ? localFields(entry.ended_at).time : ''),
  });
  return { started_at: payload.started_at, ended_at: payload.ended_at, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

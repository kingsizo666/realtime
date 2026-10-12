import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { observer } from 'mobx-react-lite';
import { store } from './store.js';
import { duration, formatClock, formatDuration, groupEntriesByDate, localFields } from './time.js';
import './styles.css';
import { applyTheme } from './theme.js';
import { focusStore } from './focus-store.js';
import { spotifyStore } from './spotify-store.js';
import { notesStore } from './notes-store.js';
import { ConfigurationPage } from './pages/Configuration.jsx';

function Icon({ name = 'clock', size = 20 }) {
  const paths = {
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    list: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
    note: <><path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9" /><path d="m16 3 5 5-9 9-5 1 1-5 8-10Z" /></>,
    music: <><path d="M9 18V5l12-2v13M9 9l12-2" /><ellipse cx="6" cy="18" rx="3" ry="3" /><ellipse cx="18" cy="16" rx="3" ry="3" /></>,
    play: <path d="m9 5 10 7-10 7Z" />,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    previous: <><path d="M5 5v14m14-14-10 7 10 7Z" /></>,
    next: <><path d="M19 5v14M5 5l10 7-10 7Z" /></>,
    power: <><path d="M12 3v9M7 5.5a9 9 0 1 0 10 0" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const EntryForm = observer(function EntryForm() {
  const categoryRef = useRef(null);
  const active = store.activeEntry;
  async function submit(event) {
    event.preventDefault();
    const finishing = Boolean(store.activeEntry);
    await store.save();
    if (finishing && !store.activeEntry) categoryRef.current?.focus();
  }
  return <section className="panel entry-panel" aria-labelledby="entry-heading">
    <div className="panel-heading">
      <div className="heading-with-icon"><span className="soft-icon"><Icon name="plus" size={15} /></span><h2 id="entry-heading">{active ? 'Current entry' : 'New entry'}</h2></div>
      {active && <span className="active-label"><span className="status-dot" />In progress</span>}
    </div>
    <form onSubmit={submit}>
      <fieldset className="entry-fields" disabled={store.saving || store.loading}>
        <div className="form-top">
          <label>Category<select ref={categoryRef} required value={store.form.category} onChange={event => store.updateField('category', event.target.value)}>
            <option value="" disabled>Choose a category</option>
            {store.categories.map(category => <option key={category}>{category}</option>)}
            {active && !store.categories.includes(active.category) && <option value={active.category}>{active.category} (removed)</option>}
          </select></label>
          <label><span>Description <span className="optional">optional</span></span><input type="text" placeholder="What are you working on?" maxLength={1000} value={store.form.description} onChange={event => store.updateField('description', event.target.value)} /></label>
        </div>
        <div className="form-bottom">
          <label>Date<input type="date" required max={localFields().date} value={store.form.date} onChange={event => store.updateField('date', event.target.value)} /></label>
          <label>Start time<input type="time" step="60" required value={store.form.startTime} onChange={event => store.updateField('startTime', event.target.value)} /></label>
          <label><span>End time <span className="optional">optional</span></span><input type="time" step="60" value={store.form.endTime} onChange={event => store.updateField('endTime', event.target.value)} /></label>
        </div>
      </fieldset>
      <div className="form-actions">
        {active && <p><Icon size={15} />{store.form.endTime ? 'Submit saves your changes and keeps the selected end time.' : 'Submit saves your changes and uses the current clock time.'}</p>}
        <button type="submit" className="primary-button" disabled={store.saving || store.loading || (!store.categories.length && !active)}>
          <Icon name={active ? 'check' : 'plus'} size={14} />{store.saving ? 'Saving…' : active ? 'Submit' : 'Add entry'}
        </button>
      </div>
    </form>
    {store.error && <div className="feedback error" role="alert">{store.error}{!store.categories.length && <button type="button" onClick={store.load}>Retry connection</button>}</div>}
    {store.notice && <div className="feedback success" role="status">{store.notice}</div>}
  </section>;
});

const EditableCell = observer(function EditableCell({ entry, field, value, children }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const committing = useRef(false);
  const isTime = field !== 'description';
  const label = field === 'description' ? 'Description' : field === 'startTime' ? 'Start time' : 'End time';
  const entryLabel = entry.description || entry.category;
  async function commit() {
    if (committing.current) return;
    if (draft === value) { setEditing(false); setError(''); return; }
    if (!draft.trim() && (field === 'startTime' || (field === 'endTime' && entry.is_submitted))) {
      setError(`${label} is required.`);
      return;
    }
    committing.current = true;
    setSaving(true);
    const saved = await store.saveCell(entry.id, field, draft);
    setSaving(false);
    committing.current = false;
    if (saved) { setEditing(false); setError(''); }
    else setError('Not saved. Adjust the value and try again.');
  }
  return <span className={`editable-cell ${isTime ? 'editable-time' : 'editable-description'}`}>
    {editing ? <input autoFocus className="cell-input" aria-label={`${label} for ${entryLabel}`} type={isTime ? 'time' : 'text'} step={isTime ? 60 : undefined} maxLength={isTime ? undefined : 1000} value={draft} disabled={saving} onChange={event => { setDraft(event.target.value); setError(''); }} onBlur={commit} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); setDraft(value); setEditing(false); setError(''); }
    }} /> : <button type="button" className="cell-value" disabled={store.saving} aria-label={`Change ${label.toLowerCase()} for ${entryLabel}`} title="Click to edit; click elsewhere to save" onClick={() => { setDraft(value); setEditing(true); }}>{children || value || (isTime ? 'Add end time' : '')}</button>}
    {error && <small className="cell-error" role="alert">{error}</small>}
  </span>;
});

const Entries = observer(function Entries() {
  return <section className="panel table-panel" aria-labelledby="entries-heading">
    <div className="panel-heading table-heading"><div className="heading-with-icon"><h2 id="entries-heading">Your entries</h2><span className="count-badge">{store.entries.length}</span></div><div className="table-total"><span>Total time spent</span><strong>{formatDuration(store.totalSeconds)}</strong></div></div>
    {store.entryError && <div className="feedback error entry-list-error" role="alert">{store.entryError}</div>}
    <div className="table-scroll">
      <table>
        <thead><tr><th scope="col">Category</th><th scope="col">Description</th><th scope="col">Start</th><th scope="col">End</th><th scope="col" className="duration-column">Duration</th><th scope="col" className="actions-column">Actions</th></tr></thead>
        {groupEntriesByDate(store.entries).map(group => <tbody key={group.date}>
          <tr className="date-group"><th scope="rowgroup" colSpan={6}><div className="date-group-heading"><span>{new Date(group.entries[0].started_at).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}</span><span className="daily-total">Total: {formatDuration(group.totalSeconds)}</span></div></th></tr>
          {group.entries.map(entry => {
          const active = !entry.is_submitted;
          const overnight = entry.ended_at && localFields(entry.ended_at).date !== localFields(entry.started_at).date;
          return <tr key={entry.id} className={active ? 'active-row' : ''}>
            <td><span className="category-tag"><span />{entry.category}</span></td>
            <td className="task-description"><EditableCell entry={entry} field="description" value={entry.description} /></td>
            <td className="time-cell"><EditableCell entry={entry} field="startTime" value={localFields(entry.started_at).time}>{formatClock(entry.started_at)}</EditableCell></td>
            <td className="time-cell"><EditableCell entry={entry} field="endTime" value={entry.ended_at ? localFields(entry.ended_at).time : ''}>{entry.ended_at ? formatClock(entry.ended_at) : <span className="running"><span className="status-dot" />Running</span>}</EditableCell>{overnight && <small className="end-date">Next day</small>}{entry.ended_at && active && <small className="end-date">Pending submit</small>}</td>
            <td className="duration-column"><span className={active ? 'live-duration' : ''}>{formatDuration(duration(entry, store.now))}</span>{active && <small className="end-date">In progress</small>}</td>
            <td className="actions-column"><div className="row-actions"><button type="button" className="row-button delete-button" disabled={store.saving} aria-label={`Delete entry: ${entry.description || entry.category}`} onClick={() => store.deleteEntry(entry)}>Delete</button></div></td>
          </tr>;
        })}</tbody>)}
      </table>
    </div>
    {!store.entries.length && <div className="empty-state"><span className="empty-icon"><Icon name="list" size={25} /></span><h3>{store.loading ? 'Loading your entries…' : 'A fresh start.'}</h3><p>{store.loading ? 'Just a moment.' : 'Add your first entry above. Your tracked time will appear here.'}</p></div>}
    <div className="table-footer"><span>{store.completedCount} submitted {store.completedCount === 1 ? 'entry' : 'entries'}</span></div>
  </section>;
});

const FocusTimer = observer(function FocusTimer() {
  return <aside className="panel side-panel focus-panel" aria-labelledby="focus-heading">
    <div className="panel-heading"><div className="heading-with-icon"><span className="soft-icon"><Icon size={14} /></span><h2 id="focus-heading">Focus timer</h2></div></div>
    <form onSubmit={event => { event.preventDefault(); focusStore.running ? focusStore.pause() : focusStore.start(); }}>
      <label>Duration <span className="timer-duration"><input type="number" min="1" max="180" step="1" required disabled={focusStore.running} value={focusStore.minutes} onChange={event => focusStore.setMinutes(event.target.value)} aria-label="Focus duration in minutes" /><span>min</span></span></label>
      <div className={`timer-display ${focusStore.completed ? 'timer-complete' : ''}`} role="timer" aria-label="Focus time remaining">{focusStore.timeLabel}</div>
      <progress className="timer-progress" max="1" value={focusStore.progress} aria-label="Focus session progress" />
      {focusStore.timerStatus && <p className="side-note timer-status" role="status">{focusStore.timerStatus}</p>}
      <div className="timer-actions"><button type="submit" className="primary-button">{focusStore.running ? 'Pause' : focusStore.remainingMs < focusStore.durationMs && !focusStore.completed ? 'Resume' : 'Start'}</button><button type="button" className="row-button" onClick={focusStore.reset}>Reset</button></div>
      {focusStore.timerError && <p className="cell-error" role="alert">{focusStore.timerError}</p>}
    </form>
  </aside>;
});

const GoalPanel = observer(function GoalPanel() {
  return <aside className={`panel side-panel goal-panel ${focusStore.goalCompleted ? 'goal-complete' : focusStore.goalActive ? 'goal-active' : ''}`} aria-labelledby="goal-heading">
    <div className="goal-heading"><span className="goal-icon"><Icon name={focusStore.goalCompleted ? 'check' : 'target'} size={19} /></span><h2 id="goal-heading">Current goal</h2></div>
    <label className="goal-label" htmlFor="current-goal">Your focus</label>
    <textarea id="current-goal" className="goal-input" rows="4" maxLength="1000" placeholder="Define one thing to accomplish…" value={focusStore.goal} onChange={event => focusStore.setGoal(event.target.value)} />
    <div className="goal-actions">
      <button type="button" className="primary-button" disabled={!focusStore.canSetGoal} onClick={focusStore.startGoal}>Set Goal</button>
      <button type="button" className="row-button goal-complete-button" disabled={!focusStore.goalActive} onClick={focusStore.completeGoal}><Icon name="check" size={13} />Complete</button>
    </div>
    <p className={`goal-status ${focusStore.goalCompleted ? 'goal-success' : ''}`} role="status">
      {focusStore.goalActive && <span className="goal-pulse" aria-hidden="true" />}{focusStore.goalStatus}
    </p>
  </aside>;
});

function SpotifyCover({ url, name }) {
  const [failed, setFailed] = useState(false);
  return <div className="spotify-cover">
    {url && !failed
      ? <img src={url} alt={`Cover art for ${name}`} width="56" height="56" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <Icon name="music" size={22} />}
  </div>;
}

const SpotifyPanel = observer(function SpotifyPanel() {
  useEffect(() => { spotifyStore.start(); return spotifyStore.stop; }, []);
  const action = spotifyStore.playing ? 'pause' : 'play';
  return <aside className="panel side-panel spotify-panel" aria-labelledby="spotify-heading">
    <div className="panel-heading"><div className="heading-with-icon"><span className="soft-icon spotify-icon"><Icon name="music" size={14} /></span><h2 id="spotify-heading"><a href="https://open.spotify.com/" target="_blank" rel="noreferrer">Spotify</a></h2></div></div>
    {spotifyStore.connected ? <>
      {spotifyStore.playback?.name && <div className="spotify-track">
        <SpotifyCover key={spotifyStore.playback.image_url || spotifyStore.playback.name} url={spotifyStore.playback.image_url} name={spotifyStore.playback.name} />
        <div className="spotify-track-info"><span className="spotify-track-title" title={spotifyStore.playback.name}>{spotifyStore.playback.name}</span>{spotifyStore.playback.artist && <p title={spotifyStore.playback.artist}>{spotifyStore.playback.artist}</p>}</div>
      </div>}
      {!spotifyStore.playback?.available && <p className="side-note spotify-status" role="status">{spotifyStore.statusText}</p>}
      <div className="spotify-controls">
        <button type="button" className="row-button" aria-label="Previous track" title="Previous track" disabled={!spotifyStore.canControl('previous')} onClick={() => spotifyStore.command('previous')}><Icon name="previous" size={16} /></button>
        <button type="button" className="primary-button" aria-label={spotifyStore.playing ? 'Pause Spotify' : 'Play Spotify'} title={spotifyStore.playing ? 'Pause' : 'Play'} disabled={!spotifyStore.canControl(action)} onClick={() => spotifyStore.command(action)}><Icon name={action} size={18} /></button>
        <button type="button" className="row-button" aria-label="Next track" title="Next track" disabled={!spotifyStore.canControl('next')} onClick={() => spotifyStore.command('next')}><Icon name="next" size={16} /></button>
      </div>
      <div className="spotify-links"><a href="https://open.spotify.com/" target="_blank" rel="noreferrer">Open Spotify</a><button type="button" disabled={spotifyStore.busy} onClick={spotifyStore.disconnect}>Disconnect</button></div>
    </> : <form onSubmit={event => { event.preventDefault(); spotifyStore.connect(); }}>
      {!spotifyStore.configured && spotifyStore.loaded && <label>Spotify app Client ID<input type="text" autoComplete="off" spellCheck="false" required maxLength="32" placeholder="Paste your Client ID" disabled={spotifyStore.connecting} value={spotifyStore.clientId} onChange={event => spotifyStore.setClientId(event.target.value)} /></label>}
      <p className="side-note spotify-status" role="status">{spotifyStore.statusText}</p>
      <button type="submit" className="primary-button spotify-connect" disabled={!spotifyStore.loaded || spotifyStore.connecting}>{spotifyStore.connecting ? 'Connecting…' : 'Connect Spotify'}</button>
      {spotifyStore.configured && !spotifyStore.connecting && <div className="spotify-links spotify-setup-links"><button type="button" onClick={spotifyStore.editSetup}>Change Client ID</button></div>}
    </form>}
    {spotifyStore.error && <div className="spotify-error" role="alert">{spotifyStore.error}<button type="button" disabled={spotifyStore.connecting || spotifyStore.busy || spotifyStore.refreshing} onClick={spotifyStore.refresh}>Retry</button></div>}
  </aside>;
});

const Notepad = observer(function Notepad() {
  const notesRef = useRef(null);
  useEffect(() => {
    notesStore.load(store.request);
    window.addEventListener('pagehide', notesStore.flush);
    return () => window.removeEventListener('pagehide', notesStore.flush);
  }, []);
  return <aside className="panel side-panel notes-panel" aria-labelledby="notes-heading">
    <div className="panel-heading"><div className="heading-with-icon"><span className="soft-icon"><Icon name="note" size={14} /></span><h2 id="notes-heading">Notepad</h2></div></div>
    <textarea ref={notesRef} className="notes-input" rows="8" aria-labelledby="notes-heading" placeholder="Write your notes…" value={notesStore.notes} onChange={event => notesStore.setNotes(event.target.value)} onBlur={notesStore.flush} />
    {notesStore.error && <div className="notes-error" role="alert">{notesStore.error}<button type="button" disabled={notesStore.loading || notesStore.saving} onClick={notesStore.retry}>Retry</button></div>}
    <div className="notes-actions"><button type="button" className="row-button" disabled={!notesStore.notes} onClick={() => { notesStore.clearNotes(); notesRef.current?.focus(); }}>Clear</button></div>
  </aside>;
});

const App = observer(function App() {
  const currentPage = () => /^\/configuration\/?$/.test(window.location.pathname) ? 'configuration' : 'tracker';
  const [page, setPage] = useState(currentPage);
  useEffect(() => {
    const onPopState = () => setPage(currentPage());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  function navigate(event, nextPage) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    document.activeElement?.blur();
    window.history.pushState(null, '', nextPage === 'configuration' ? '/configuration' : '/');
    setPage(nextPage);
  }
  useEffect(() => {
    store.load();
    const timer = window.setInterval(() => { if (!store.stopped) { store.tick(); focusStore.tick(); } }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <>
    <header className="site-header"><div className="header-layout"><div className="header-inner"><a className="brand" href="/" aria-label="Realtime home" onClick={event => navigate(event, 'tracker')}><span className="brand-mark"><Icon size={15} /></span>realtime<span className="brand-dot">.</span></a><div className="header-actions"><nav className="header-nav" aria-label="Main navigation"><a href="/" aria-current={page === 'tracker' ? 'page' : undefined} onClick={event => navigate(event, 'tracker')}>Tracker</a><a href="/configuration" aria-current={page === 'configuration' ? 'page' : undefined} onClick={event => navigate(event, 'configuration')}>Configuration</a></nav><button type="button" className="theme-toggle" aria-label={store.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={store.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-pressed={store.theme === 'dark'} onClick={store.toggleTheme}><Icon name="sun" size={16} /></button></div></div></div></header>
    <main>
      <div className="workspace-layout" hidden={page !== 'tracker' && !store.stopped}>
        {store.stopped ? <section className="panel stopped-panel tracker-column" role="status"><span className="soft-icon"><Icon name="power" size={16} /></span><h1>Realtime is stopped</h1><p>Your saved entries are kept. Open Realtime.exe to start again.</p></section> : <>
        <div className="side-column"><FocusTimer /><SpotifyPanel /></div>
        <div className="tracker-column">
          <div className="page-intro tracker-intro"><h1>Time tracker</h1>{store.canShutdown && <button type="button" className="stop-app-button" onClick={store.stopApp} disabled={store.loading || store.saving || store.stopping}><Icon name="power" size={12} />{store.stopping ? 'Stopping...' : 'Stop app'}</button>}</div>
          {store.shutdownError && <div className="feedback error shutdown-error" role="alert">{store.shutdownError}</div>}
          <EntryForm />
          <Entries />
        </div>
        <div className="side-column"><GoalPanel /><Notepad /></div>
        </>}
      </div>
      <div className="workspace-layout" hidden={page !== 'configuration' || store.stopped}><ConfigurationPage active={page === 'configuration' && !store.stopped} /></div>
    </main>
  </>;
});

applyTheme(store.theme);
createRoot(document.getElementById('root')).render(<App />);

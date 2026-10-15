import React, { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { configurationStore as configuration } from '../configuration-store.js';
import { Icon } from '../components/Icon.jsx';
import { focusStore as focus } from '../focus-store.js';

const BlockedApps = observer(function BlockedApps({ active }) {
  const [selected, setSelected] = useState('');
  useEffect(() => { if (active) focus.loadApps(); }, [active]);
  const available = focus.blocker.running_apps.filter(app => !focus.apps.some(saved => saved.path === app.path));
  return <section className="panel configuration-panel" aria-labelledby="blocked-apps-heading">
    <div className="panel-heading"><div className="heading-with-icon"><span className="soft-icon"><Icon name="target" size={14} /></span><h2 id="blocked-apps-heading">Focus app blocking</h2></div><button type="button" className="row-button" disabled={focus.appBusy} onClick={focus.loadApps}>Refresh</button></div>
    <p className="side-note">Selected apps minimize when you switch to them during focus. Pause or reset the timer to use them again.</p>
    <form className="category-add-form app-add-form" onSubmit={event => { event.preventDefault(); const app = available.find(app => app.path === selected); if (app) { focus.changeApp(app); setSelected(''); } }}>
      <label>Running app<select aria-label="App to block" value={available.some(app => app.path === selected) ? selected : ''} disabled={!focus.blocker.available || focus.appBusy} onChange={event => setSelected(event.target.value)}><option value="">Choose an app</option>{available.map(app => <option key={app.path} value={app.path}>{app.name}</option>)}</select></label>
      <button type="submit" className="primary-button category-icon-button" aria-label="Add blocked app" title="Add blocked app" disabled={focus.appBusy || !focus.blocker.available || !available.some(app => app.path === selected)}><Icon name="plus" size={16} /></button>
    </form>
    <ul className="category-list blocked-app-list" aria-label="Blocked apps">{focus.apps.map(app => <li key={app.id}><span title={app.path}>{app.name}</span><button type="button" className="row-button delete-button category-icon-button" disabled={focus.appBusy} aria-label={`Remove blocked app: ${app.name}`} title="Remove app" onClick={() => focus.changeApp(app, true)}><Icon name="trash" size={15} /></button></li>)}</ul>
    {!focus.apps.length && <p className="side-note">No apps selected. Open an app and refresh to add it.</p>}
    <p className="side-note">Enable “Block selected apps” in the focus timer. Browsers and system tools stay accessible.</p>
    {focus.blocker.message && <p className="side-note" role="status">{focus.blocker.message}</p>}
    {focus.appError && <p className="cell-error" role="alert">{focus.appError}</p>}
  </section>;
});

const CategoryRow = observer(function CategoryRow({ category }) {
  const [name, setName] = useState(category.name);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => setName(category.name), [category.name]);
  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [editing]);
  async function save(event) {
    event.preventDefault();
    if (!editing || configuration.working) return;
    if (name.trim() === category.name) { setName(category.name); setEditing(false); return; }
    if (await configuration.rename(category, name)) setEditing(false);
  }
  return <li>
    <form className="category-row" onSubmit={save}>
      <input ref={inputRef} aria-label={`Category name: ${category.name}`} type="text" required maxLength={40} value={name} disabled={!editing || configuration.working} onChange={event => setName(event.target.value)} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setName(category.name); setEditing(false); }
      }} />
      {editing
        ? <button key="save" type="submit" className="row-button category-icon-button" aria-label={`Save category: ${category.name}`} title="Save category" disabled={configuration.working || !name.trim()}><Icon name="save" size={15} /></button>
        : <button key="edit" type="button" className="row-button category-icon-button" aria-label={`Edit category: ${category.name}`} title="Edit category" disabled={configuration.working} onClick={() => { setName(category.name); setEditing(true); }}><Icon name="edit" size={15} /></button>}
      <button type="button" className="row-button delete-button category-icon-button" aria-label={`Delete category: ${category.name}`} title="Delete category" disabled={configuration.working} onClick={() => configuration.remove(category)}><Icon name="trash" size={15} /></button>
    </form>
  </li>;
});

export const ConfigurationPage = observer(function ConfigurationPage({ active }) {
  useEffect(() => { if (active) configuration.load(); }, [active]);
  return <section className="tracker-column configuration-page" aria-labelledby="configuration-heading">
    <div className="page-intro"><h1 id="configuration-heading">Configuration</h1></div>
    <section className="panel configuration-panel" aria-labelledby="categories-heading">
      <div className="panel-heading"><div className="heading-with-icon"><span className="soft-icon"><Icon name="settings" size={14} /></span><h2 id="categories-heading">Task categories</h2></div></div>
      <form className="category-add-form" onSubmit={event => { event.preventDefault(); configuration.add(); }}>
        <label>New category<input type="text" required maxLength={40} placeholder="Category name" value={configuration.newName} disabled={configuration.working} onChange={event => configuration.setNewName(event.target.value)} /></label>
        <button type="submit" className="primary-button category-icon-button" aria-label="Add category" title="Add category" disabled={configuration.working || !configuration.newName.trim()}><Icon name="plus" size={16} /></button>
      </form>
      <ul className="category-list" aria-label="Task categories">
        {configuration.categories.map(category => <CategoryRow key={category.id} category={category} />)}
      </ul>
      {!configuration.categories.length && <p className="side-note">{configuration.loading ? 'Loading categories…' : 'Add a category to start tracking tasks.'}</p>}
      <p className="side-note">Renaming updates existing entries. Removing a category keeps their history.</p>
      {configuration.error && <div className="feedback error" role="alert">{configuration.error}<button type="button" disabled={configuration.working} onClick={configuration.load}>Refresh list</button></div>}
      {configuration.notice && <div className="feedback success" role="status">{configuration.notice}</div>}
    </section>
    <BlockedApps active={active} />
  </section>;
});

import React, { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { configurationStore as configuration } from '../configuration-store.js';
import { Icon } from '../components/Icon.jsx';

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
  </section>;
});

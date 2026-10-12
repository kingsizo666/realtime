import React, { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { configurationStore as configuration } from '../configuration-store.js';

const CategoryRow = observer(function CategoryRow({ category }) {
  const [name, setName] = useState(category.name);
  useEffect(() => setName(category.name), [category.name]);
  return <li>
    <form className="category-row" onSubmit={event => { event.preventDefault(); configuration.rename(category, name); }}>
      <input aria-label={`Category name: ${category.name}`} type="text" required maxLength={40} value={name} disabled={configuration.working} onChange={event => setName(event.target.value)} />
      <button type="submit" className="row-button" disabled={configuration.working || !name.trim() || name.trim() === category.name}>Save</button>
      <button type="button" className="row-button delete-button" aria-label={`Remove category: ${category.name}`} disabled={configuration.working} onClick={() => configuration.remove(category)}>Remove</button>
    </form>
  </li>;
});

export const ConfigurationPage = observer(function ConfigurationPage({ active }) {
  useEffect(() => { if (active) configuration.load(); }, [active]);
  return <section className="tracker-column configuration-page" aria-labelledby="configuration-heading">
    <div className="page-intro"><h1 id="configuration-heading">Configuration</h1></div>
    <section className="panel configuration-panel" aria-labelledby="categories-heading">
      <div className="panel-heading"><h2 id="categories-heading">Task categories</h2></div>
      <form className="category-add-form" onSubmit={event => { event.preventDefault(); configuration.add(); }}>
        <label>New category<input type="text" required maxLength={40} placeholder="Category name" value={configuration.newName} disabled={configuration.working} onChange={event => configuration.setNewName(event.target.value)} /></label>
        <button type="submit" className="primary-button" disabled={configuration.working || !configuration.newName.trim()}>Add category</button>
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

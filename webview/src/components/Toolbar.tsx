import { useEffect, useRef } from 'react';

interface Option {
  value: string;
  label: string;
}

interface ToolbarProps {
  query: string;
  onQuery(q: string): void;
  source: string;
  sourceOptions: Option[];
  totalCount: number;
  onSource(s: string): void;
  category: string;
  categoryOptions: Option[];
  onCategory(c: string): void;
  view: 'graph' | 'list';
  onView(v: 'graph' | 'list'): void;
  order: 'name' | 'recent' | 'most';
  /** Usage orders need recorded activity. */
  orderEnabled: boolean;
  onOrder(o: 'name' | 'recent' | 'most'): void;
  graphControls: boolean;
  onZoomIn(): void;
  onZoomOut(): void;
  onFit(): void;
  onResetLayout(): void;
  onRescan(): void;
  scanning: boolean;
  disabled: boolean;
}

function IconButton(props: { icon: string; label: string; onClick(): void; pressed?: boolean; disabled?: boolean; spin?: boolean }) {
  return (
    <button
      type="button"
      className={`icon-btn ${props.pressed ? 'is-pressed' : ''}`}
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <i className={`codicon codicon-${props.icon} ${props.spin ? 'codicon-modifier-spin' : ''}`} aria-hidden />
    </button>
  );
}

export function Toolbar(p: ToolbarProps) {
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="toolbar" role="toolbar" aria-label="Skill Tree controls">
      <div className="search">
        <i className="codicon codicon-search" aria-hidden />
        <input
          ref={searchRef}
          type="search"
          placeholder="Search skills"
          aria-label="Search skills by name, description, command or path"
          value={p.query}
          disabled={p.disabled}
          onChange={(e) => p.onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && p.query) {
              e.preventDefault();
              p.onQuery('');
            }
          }}
        />
      </div>
      <select aria-label="Filter by source" value={p.source} onChange={(e) => p.onSource(e.target.value)} disabled={p.disabled}>
        <option value="all">All sources ({p.totalCount})</option>
        {p.sourceOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select aria-label="Filter by category" value={p.category} onChange={(e) => p.onCategory(e.target.value)} disabled={p.disabled}>
        <option value="all">All categories</option>
        {p.categoryOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Order skills within each category"
        title={p.orderEnabled ? 'Order within each category' : 'Ordering by use needs recorded activity (opt-in tracking)'}
        value={p.order}
        onChange={(e) => p.onOrder(e.target.value as 'name' | 'recent' | 'most')}
        disabled={p.disabled}
      >
        <option value="name">Sort: Name</option>
        <option value="recent" disabled={!p.orderEnabled}>
          Sort: Last used
        </option>
        <option value="most" disabled={!p.orderEnabled}>
          Sort: Most used
        </option>
      </select>
      <div className="segmented" role="group" aria-label="View">
        <IconButton icon="type-hierarchy" label="Graph view" pressed={p.view === 'graph'} onClick={() => p.onView('graph')} />
        <IconButton icon="list-flat" label="List view" pressed={p.view === 'list'} onClick={() => p.onView('list')} />
      </div>
      <div className="toolbar-spacer" />
      {p.graphControls && (
        <div className="toolbar-group" role="group" aria-label="Graph navigation">
          <IconButton icon="zoom-out" label="Zoom out" onClick={p.onZoomOut} />
          <IconButton icon="zoom-in" label="Zoom in" onClick={p.onZoomIn} />
          <IconButton icon="screen-full" label="Fit graph to view" onClick={p.onFit} />
          <IconButton icon="discard" label="Reset layout (undo node moves)" onClick={p.onResetLayout} />
        </div>
      )}
      <IconButton icon={p.scanning ? 'loading' : 'refresh'} spin={p.scanning} label="Rescan skill folders" onClick={p.onRescan} />
    </header>
  );
}

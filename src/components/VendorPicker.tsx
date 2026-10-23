import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { addVendor } from '../data/actions';
import { useStore } from '../data/store';
import type { Vendor } from '../types';
import { vendorKey } from '../vendors';
import { ErrorNote, useAction } from './ui';

/**
 * Searchable vendor dropdown. Vendors must come from the list; anyone missing
 * can be added here, which saves them for everyone.
 */
export function VendorPicker({ value, onSelect, autoFocus }: {
  value: string;
  onSelect: (v: Pick<Vendor, 'name' | 'gstin'>) => void;
  autoFocus?: boolean;
}) {
  const { be, me, vendors } = useStore();
  const listId = useId();
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState<{ name: string; gstin: string } | null>(null);
  const { busy, error, setError, run } = useAction();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => { if (!open) setQuery(value); }, [value, open]);

  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () => (needle ? vendors.filter((v) => v.name.toLowerCase().includes(needle) || v.id.includes(vendorKey(needle))) : vendors),
    [vendors, needle],
  );
  const exact = !!needle && vendors.some((v) => v.id === vendorKey(needle));
  // The last row is always "Add new vendor".
  const rowCount = matches.length + 1;

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function choose(v: Vendor) {
    onSelect({ name: v.name, gstin: v.gstin });
    setQuery(v.name);
    setOpen(false);
  }
  function startAdding() {
    setAdding({ name: exact ? '' : query.trim(), gstin: '' });
    setError('');
    setOpen(false);
  }

  const saveNew = () => run(async () => {
    const v = await addVendor(be, me.email, vendors, adding!.name, adding!.gstin);
    onSelect({ name: v.name, gstin: v.gstin || adding!.gstin.trim().toUpperCase() });
    setQuery(v.name);
    setAdding(null);
  });
  const enterSaves = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); void saveNew(); }
    else if (e.key === 'Escape') setAdding(null);
  };

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, rowCount - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && open) {
      e.preventDefault();
      if (active < matches.length) choose(matches[active]); else startAdding();
    } else if (e.key === 'Escape') setOpen(false);
  }

  return (
    <div className="vendor-picker">
      <input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoFocus={autoFocus}
        value={query}
        placeholder="Type to search vendors…"
        onFocus={() => { setOpen(true); setActive(0); }}
        onClick={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {value && query !== value && !open && <span className="muted small">Selected: {value}</span>}
      {open && (
        <ul className="vendor-list" role="listbox" id={listId} ref={listRef}>
          {matches.map((v, i) => (
            <li
              key={v.id}
              data-i={i}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => { e.preventDefault(); choose(v); }}
              onMouseEnter={() => setActive(i)}
            >
              {v.name}
              {v.gstin && <span className="muted small mono"> · {v.gstin}</span>}
            </li>
          ))}
          {!matches.length && <li className="muted small vendor-none">No vendor matches “{query.trim()}”.</li>}
          <li
            data-i={matches.length}
            role="option"
            aria-selected={active === matches.length}
            className={`vendor-add ${active === matches.length ? 'active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); startAdding(); }}
            onMouseEnter={() => setActive(matches.length)}
          >
            + Add new vendor{needle && !exact ? ` “${query.trim()}”` : ''}
          </li>
        </ul>
      )}
      {adding && (
        <div className="vendor-new">
          <b className="small">New vendor (saved for everyone)</b>
          <input value={adding.name} placeholder="Vendor name as on the invoice" autoFocus onKeyDown={enterSaves} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
          <input
            value={adding.gstin}
            className="mono"
            maxLength={15}
            placeholder="GSTIN (optional)"
            onKeyDown={enterSaves}
            onChange={(e) => setAdding({ ...adding, gstin: e.target.value.toUpperCase() })}
          />
          <div className="row-gap">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={saveNew}
            >{busy ? 'Adding…' : 'Add vendor'}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAdding(null)}>Cancel</button>
          </div>
          <ErrorNote error={error} />
        </div>
      )}
    </div>
  );
}

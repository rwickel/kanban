import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { OpenCodeModelInfo } from '../types';

interface ModelPoolPickerProps {
  /** Model list from `fetchModels()` (GET /api/kanban/oc/model). */
  models: OpenCodeModelInfo[];
  /** Selected "providerID/modelID" entries — the project's usable pool. */
  selected: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
  /** Shown as a warning; the current selection is never dropped because of it. */
  error?: string | null;
  onRefresh?: () => void;
}

const label = (m: OpenCodeModelInfo) =>
  m.name && m.name !== m.modelID ? `${m.modelID} — ${m.name}` : m.modelID;

/**
 * Project model pool: the list of available providers, each expandable to the
 * models it offers, with search and per-provider select-all. One component for
 * the desktop and the mobile project form.
 *
 * An empty selection means "no restriction" — every model the server offers.
 * Entries selected earlier but missing from the current list stay visible under
 * their own group so a failed/stale fetch can never silently drop them.
 */
export default function ModelPoolPicker({
  models, selected, onChange, loading, error, onRefresh,
}: ModelPoolPickerProps) {
  const [query, setQuery] = useState('');
  // Providers carrying a current selection start expanded, so reopening the form
  // shows what is allowed right away instead of a bare list of provider names.
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const s of selected) {
      const i = s.indexOf('/');
      if (i > 0) init[s.slice(0, i)] = true;
    }
    return init;
  });

  const q = query.trim().toLowerCase();
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const knownSet = useMemo(() => new Set(models.map((m) => `${m.providerID}/${m.modelID}`)), [models]);

  // providerID -> models, filtered by the search box, sorted by provider.
  const groups = useMemo(() => {
    const map = new Map<string, OpenCodeModelInfo[]>();
    for (const m of models) {
      const hit = !q || `${m.providerID}/${m.modelID} ${m.name ?? ''}`.toLowerCase().includes(q);
      if (!hit) continue;
      const list = map.get(m.providerID);
      if (list) list.push(m);
      else map.set(m.providerID, [m]);
    }
    for (const list of map.values()) list.sort((a, b) => a.modelID.localeCompare(b.modelID));
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models, q]);

  // Selected entries the current list does not contain (stale model, or a fetch
  // that failed outright) — kept visible instead of being dropped on save.
  const staleGroups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of selected) {
      if (knownSet.has(s)) continue;
      const idx = s.indexOf('/');
      const p = idx > 0 ? s.slice(0, idx) : '(unknown provider)';
      const list = map.get(p);
      if (list) list.push(s);
      else map.set(p, [s]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [selected, knownSet]);

  const toggleModel = (value: string) => {
    onChange(selectedSet.has(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  /** Provider checkbox: select every model it currently shows (or drop them all). */
  const toggleProvider = (entries: string[]) => {
    const set = new Set(entries);
    const allIn = entries.length > 0 && entries.every((e) => selectedSet.has(e));
    const next = allIn ? selected.filter((v) => !set.has(v)) : [...selected];
    if (!allIn) for (const e of entries) if (!selectedSet.has(e)) next.push(e);
    onChange(next);
  };

  const isOpen = (p: string) => (q ? true : open[p] ?? false);
  const toggleOpen = (p: string) => setOpen((o) => ({ ...o, [p]: !o[p] }));

  const allKeys = groups.flatMap(([, list]) => list.map((m) => `${m.providerID}/${m.modelID}`));

  return (
    <div className="rounded-xl border border-gray-700 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-gray-300">
          Models <span className="text-gray-500 font-normal">usable in this project</span>
        </span>
        <button type="button" onClick={onRefresh} disabled={loading}
          className="p-1 rounded hoverable" title="Refresh provider/model list">
          <RefreshCw className={`w-3.5 h-3.5 muted ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="relative">
        <Search className="w-3.5 h-3.5 muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search providers and models…"
          className="w-full pl-8 pr-8 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 text-[12px] mono focus:outline-none focus:ring-2 focus:ring-violet-500/50"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hoverable"
            title="Clear search">
            <X className="w-3.5 h-3.5 muted" />
          </button>
        )}
      </div>

      {error && (
        <p className="text-[11px] text-amber-400 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /> {error} — current selection kept
        </p>
      )}

      <div className="rounded-lg border border-gray-800 divide-y divide-gray-800/70 max-h-64 overflow-y-auto">
        {groups.length === 0 && (
          <p className="text-[11px] muted px-2.5 py-3 text-center">
            {models.length === 0 ? 'No providers loaded yet.' : `Nothing matches “${query}”.`}
          </p>
        )}

        {groups.map(([provider, list]) => {
          const keys = list.map((m) => `${m.providerID}/${m.modelID}`);
          const inside = keys.filter((k) => selectedSet.has(k)).length;
          const allIn = keys.length > 0 && inside === keys.length;
          const someIn = inside > 0 && !allIn;
          const expanded = isOpen(provider);

          return (
            <div key={provider}>
              <div className="flex items-center gap-2 px-2.5 py-1.5 hoverable">
                <input
                  type="checkbox"
                  checked={allIn}
                  ref={(el) => { if (el) el.indeterminate = someIn; }}
                  onChange={() => toggleProvider(keys)}
                  className="accent-violet-500 w-3.5 h-3.5 shrink-0"
                  aria-label={`Select every ${provider} model shown`}
                />
                <button
                  type="button"
                  onClick={() => toggleOpen(provider)}
                  aria-expanded={expanded}
                  className="flex-1 min-w-0 flex items-baseline justify-between gap-2 text-left"
                >
                  <span className="mono text-[12px] text-gray-200 truncate">{provider}</span>
                  <span className="text-[10px] muted shrink-0 tabular-nums">{inside}/{keys.length}</span>
                </button>
                <ChevronRight
                  className={`w-3.5 h-3.5 muted shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
                />
              </div>

              {expanded && (
                <div className="pb-1.5">
                  {list.map((m) => {
                    const key = `${m.providerID}/${m.modelID}`;
                    return (
                      <label key={key}
                        className="flex items-center gap-2 pl-7 pr-2.5 py-1 cursor-pointer hoverable">
                        <input
                          type="checkbox"
                          checked={selectedSet.has(key)}
                          onChange={() => toggleModel(key)}
                          className="accent-violet-500 w-3.5 h-3.5 shrink-0"
                        />
                        <span className="mono text-[11px] text-gray-300 truncate">{label(m)}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {staleGroups.length > 0 && (
          <div>
            <p className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-wide text-amber-400/80">
              Selected but not in the current list
            </p>
            {staleGroups.map(([provider, entries]) => (
              <div key={provider}>
                <div className="px-2.5 py-1 mono text-[11px] text-gray-400">{provider}</div>
                {entries.map((key) => (
                  <label key={key}
                    className="flex items-center gap-2 pl-7 pr-2.5 py-1 cursor-pointer hoverable">
                    <input
                      type="checkbox"
                      checked
                      onChange={() => toggleModel(key)}
                      className="accent-violet-500 w-3.5 h-3.5 shrink-0"
                    />
                    <span className="mono text-[11px] text-gray-400 truncate">{key.slice(provider.length + 1)}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-gray-500 min-w-0">
          {selected.length === 0 ? (
            <>No restriction — every provider model is available.</>
          ) : (
            <>{selected.length} model{selected.length === 1 ? '' : 's'} allowed.</>
          )}
        </p>
        <div className="flex items-center gap-1.5 shrink-0">
          {allKeys.length > 0 && (
            <button type="button" onClick={() => onChange([...new Set([...selected, ...allKeys])])}
              className="text-[11px] px-2 py-1 rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800">
              {q ? 'Select matches' : 'Select all'}
            </button>
          )}
          {selected.length > 0 && (
            <button type="button" onClick={() => onChange([])}
              className="text-[11px] px-2 py-1 rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800">
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

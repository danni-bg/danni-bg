import { ArrowDown, ArrowUp, Download, Filter, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ErrorState, Loading } from '../components/StatusMessage.tsx';
import { fetchResourceRows } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { type GridSort, cycleSort, hasActiveFilters } from '../lib/grid.ts';
import { cellText, tableColumns, toCsv } from '../lib/table.ts';
import { useServerState } from '../lib/useServerState.ts';
import type { ResourceContent } from '../types.ts';

const PAGE = 50;

interface ResourcePreviewProps {
  datasetId: string;
  resourceId: string;
  name: string;
  onClose: () => void;
  /** `panel` = compact side-panel card (default); `reader` = fill the centre document reader. */
  variant?: 'panel' | 'reader';
}

function download(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sameFilters(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/** The open column-filter popover: which column + where to anchor it (viewport coords). */
interface OpenFilter {
  col: string;
  left: number;
  top: number;
}

export function ResourcePreview({
  datasetId,
  resourceId,
  name,
  onClose,
  variant = 'panel',
}: ResourcePreviewProps) {
  const reader = variant === 'reader';
  // Scrollable data areas: a fixed cap in the side panel, but grow to fill the centre reader.
  const fill = reader ? 'min-h-0 flex-1' : 'max-h-80';
  const [content, setContent] = useState<ResourceContent | null>(null);
  const [rows, setRows] = useState<unknown[]>([]);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<GridSort | null>(null);
  const [colFilters, setColFilters] = useState<Record<string, string>>({}); // instant (input)
  const [appliedFilters, setAppliedFilters] = useState<Record<string, string>>({}); // debounced (sent)
  const [openFilter, setOpenFilter] = useState<OpenFilter | null>(null);
  // Column set persists across filtering so the header stays when a filter narrows to zero rows.
  const [columns, setColumns] = useState<string[]>([]);

  // Reset when the selected resource changes.
  useEffect(() => {
    setRows([]);
    setOffset(0);
    setContent(null);
    setSort(null);
    setColFilters({});
    setAppliedFilters({});
    setOpenFilter(null);
    setColumns([]);
  }, [datasetId, resourceId]);

  // Learn the columns from any non-empty page; keep them when a filter empties the view.
  useEffect(() => {
    if (rows.length > 0) setColumns(tableColumns(rows));
  }, [rows]);

  // Debounce the per-column filter inputs before they hit the server, and restart from page 0.
  useEffect(() => {
    if (sameFilters(colFilters, appliedFilters)) return;
    const id = setTimeout(() => {
      setAppliedFilters(colFilters);
      setOffset(0);
    }, 300);
    return () => clearTimeout(id);
  }, [colFilters, appliedFilters]);

  // Sort + filter are applied server-side over the whole resource. The keyed query owns load/cancel;
  // the key's cancellation guarantees the resolved page matches the current offset (FR-401/FR-402).
  const pageKey = JSON.stringify({ datasetId, resourceId, offset, sort, appliedFilters });
  const rowsQuery = useServerState(pageKey, () =>
    fetchResourceRows(datasetId, resourceId, PAGE, offset, { sort, filters: appliedFilters }),
  );
  // Apply each fetched page exactly once (a ref guards a StrictMode double-invoke): offset===0
  // replaces, else appends.
  const appliedRef = useRef<ResourceContent | null>(null);
  useEffect(() => {
    const c = rowsQuery.data;
    if (!c || c === appliedRef.current) return;
    appliedRef.current = c;
    setContent(c);
    setRows((prev) => (offset === 0 ? c.rows : [...prev, ...c.rows]));
  }, [rowsQuery.data, offset]);

  const filtering = hasActiveFilters(appliedFilters);
  // What kind of content this resource is — decided by shape, not by how many rows are loaded, so a
  // filter that matches nothing still shows the (empty) table rather than the JSON `[]` fallback.
  const isText = content?.text !== undefined;
  const isDocument = !isText && content?.document !== undefined;
  const isTable = !!content && !isText && !isDocument;
  const colFilterActive = (c: string) =>
    (appliedFilters[c] ?? '').trim() !== '' || (colFilters[c] ?? '').trim() !== '';

  function onDownload() {
    if (!content) return;
    if (isTable) download(`${resourceId}.csv`, toCsv(rows, tableColumns(rows, 100)), 'text/csv');
    else if (content.text !== undefined) download(`${resourceId}.txt`, content.text, 'text/plain');
    else
      download(
        `${resourceId}.json`,
        JSON.stringify(content.document ?? rows, null, 2),
        'application/json',
      );
  }

  return (
    <div
      className={cn(
        'rounded-md border bg-card p-3',
        reader ? 'flex h-full flex-col gap-2' : 'space-y-2',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium" title={name}>
          {name}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {content && (
            <button
              type="button"
              aria-label="Изтегли данните"
              onClick={onDownload}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <Download className="size-4" />
            </button>
          )}
          <button
            type="button"
            aria-label="Затвори визуализацията"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {rowsQuery.status === 'error' && (
        <ErrorState message="Грешка при зареждане на данните." onRetry={rowsQuery.refetch} />
      )}
      {!content && rowsQuery.status !== 'error' && <Loading />}

      {content && isTable && (
        <>
          <div className={cn('overflow-auto rounded border', fill)}>
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-10 bg-muted">
                <tr>
                  {columns.map((c) => {
                    const active = sort?.col === c;
                    return (
                      <th
                        key={c}
                        aria-sort={
                          active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                        }
                        className="whitespace-nowrap border-b font-medium"
                      >
                        <div className="flex items-center">
                          {/* Click the column to sort (unsorted → asc → desc → unsorted). */}
                          <button
                            type="button"
                            onClick={() => {
                              setSort((s) => cycleSort(s, c));
                              setOffset(0);
                            }}
                            className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-left hover:bg-accent/60"
                          >
                            <span className="truncate">{c}</span>
                            {active &&
                              (sort?.dir === 'asc' ? (
                                <ArrowUp className="size-3 shrink-0" aria-hidden />
                              ) : (
                                <ArrowDown className="size-3 shrink-0" aria-hidden />
                              ))}
                          </button>
                          {/* Excel-style per-column filter (funnel opens a small popover). */}
                          <button
                            type="button"
                            aria-label={`Филтрирай ${c}`}
                            aria-pressed={openFilter?.col === c}
                            onClick={(e) => {
                              if (openFilter?.col === c) return setOpenFilter(null);
                              const r = e.currentTarget.getBoundingClientRect();
                              setOpenFilter({ col: c, left: r.right - 208, top: r.bottom + 4 });
                            }}
                            className={cn(
                              'flex size-6 shrink-0 items-center justify-center rounded hover:bg-accent/60',
                              colFilterActive(c) ? 'text-primary' : 'text-muted-foreground',
                            )}
                          >
                            <Filter
                              className="size-3"
                              {...(colFilterActive(c) ? { fill: 'currentColor' } : {})}
                            />
                          </button>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: ordered append-only page (server-sorted)
                  <tr key={i} className="even:bg-muted/40">
                    {columns.map((c) => {
                      const rec = row as Record<string, unknown>;
                      return (
                        <td
                          key={c}
                          className="max-w-[220px] truncate border-b px-2 py-1"
                          title={cellText(rec?.[c])}
                        >
                          {cellText(rec?.[c])}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={Math.max(1, columns.length)}
                      className="px-2 py-6 text-center text-muted-foreground"
                    >
                      {filtering ? 'Няма съвпадения за филтъра.' : 'Няма данни.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {rows.length} от {content.total} реда{filtering && ' (филтрирани)'}
              {filtering && (
                <button
                  type="button"
                  onClick={() => setColFilters({})}
                  className="ml-2 underline-offset-2 hover:underline"
                >
                  изчисти филтрите
                </button>
              )}
              {content.gridTruncated && (
                <span
                  className="ml-2 text-warning"
                  title="Сортирано/филтрирано върху първите 100 000 реда"
                >
                  · върху първите 100k
                </span>
              )}
            </span>
            {rows.length < content.total && (
              <button
                type="button"
                onClick={() => setOffset(rows.length)}
                className="shrink-0 rounded-md border px-2 py-1 hover:bg-accent hover:text-accent-foreground"
              >
                Зареди още
              </button>
            )}
          </div>
        </>
      )}

      {content && isText && (
        <pre
          className={cn(
            'overflow-auto rounded border bg-muted/30 p-2 text-xs whitespace-pre-wrap',
            fill,
          )}
        >
          {content.text}
        </pre>
      )}
      {content && isDocument && (
        <pre className={cn('overflow-auto rounded border bg-muted/30 p-2 text-xs', fill)}>
          {JSON.stringify(content.document, null, 2)}
        </pre>
      )}

      {/* Column-filter popover (fixed, so it escapes the table's overflow clipping). */}
      {openFilter && (
        <>
          <button
            type="button"
            aria-label="Затвори филтъра"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpenFilter(null)}
          />
          <div
            className="fixed z-50 w-52 rounded-md border bg-card p-2 shadow-lg"
            style={{ left: Math.max(8, openFilter.left), top: openFilter.top }}
          >
            <div className="mb-1 truncate text-xs font-medium" title={openFilter.col}>
              {openFilter.col}
            </div>
            <input
              aria-label={`Стойност за филтър ${openFilter.col}`}
              // biome-ignore lint/a11y/noAutofocus: a filter popover should focus its input on open
              autoFocus
              value={colFilters[openFilter.col] ?? ''}
              onChange={(e) => setColFilters((f) => ({ ...f, [openFilter.col]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') setOpenFilter(null);
              }}
              placeholder="съдържа…"
              className="h-7 w-full rounded border border-input bg-background px-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {(colFilters[openFilter.col] ?? '') !== '' && (
              <button
                type="button"
                onClick={() => setColFilters((f) => ({ ...f, [openFilter.col]: '' }))}
                className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                изчисти
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

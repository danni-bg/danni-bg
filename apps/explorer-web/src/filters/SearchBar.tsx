import { Loader2, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Input } from '../components/ui/input.tsx';
import { useExplorer } from '../store/explorerStore.ts';

/** Pause after the last keystroke before committing the query, so typing doesn't fire a search
 *  (a hybrid keyword+vector lookup) on every character. */
const DEBOUNCE_MS = 300;

interface SearchBarProps {
  /** True while the list/regions are (re)loading — shows a spinner in the field. */
  loading?: boolean;
}

export function SearchBar({ loading }: SearchBarProps) {
  const query = useExplorer((s) => s.filters.query);
  const updateFilters = useExplorer((s) => s.updateFilters);
  const [text, setText] = useState(query);

  // Reflect external query changes (e.g. "Изчисти всички") back into the input.
  useEffect(() => {
    setText(query);
  }, [query]);

  // Debounced commit: the input updates instantly; the shared filter (which drives the fetch) only
  // catches up after the pause.
  useEffect(() => {
    if (text === query) return;
    const id = setTimeout(() => updateFilters((f) => ({ ...f, query: text })), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text, query, updateFilters]);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label="Търсене на набори"
        type="text"
        placeholder="Търси по дума, тема, издател…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="h-10 rounded-lg pr-9 pl-9"
      />
      {loading ? (
        <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
      ) : (
        text && (
          <button
            type="button"
            aria-label="Изчисти търсенето"
            onClick={() => setText('')}
            className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <X className="size-3.5" />
          </button>
        )
      )}
    </div>
  );
}

// The one loading + error affordance for server state (spec 057, FR-403/FR-405). Collapses the seven
// duplicated `Зареждане…` paragraphs to a single definition and gives every view a distinguishable
// failure state (message + retry) instead of a plausible empty state. The wording follows the
// existing DatasetDetail pattern (`Грешка при зареждане…`).

import { cn } from '../lib/cn.ts';

/** The single "loading" affordance. `className` lets callers keep their local placement (e.g. centred). */
export function Loading({ className }: { className?: string }) {
  return <p className={cn('text-sm text-muted-foreground', className)}>Зареждане…</p>;
}

interface ErrorStateProps {
  /** Context-specific message; defaults to the generic load-failure wording. */
  message?: string;
  /** When provided, renders a retry button (wire it to the query's `refetch`). */
  onRetry?: () => void;
  className?: string;
}

/** The single "failed" affordance: a destructive message plus an optional retry. */
export function ErrorState({ message, onRetry, className }: ErrorStateProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <p className="text-sm text-destructive">{message ?? 'Грешка при зареждане.'}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Опитай отново
        </button>
      )}
    </div>
  );
}

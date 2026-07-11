// Signed-in user menu: an avatar button in the header that opens a dropdown with the user's
// identity, settings links (+ admin platform link), and logout. Closes on click-outside / Escape /
// item click. No dropdown primitive in the app, so it's a small self-contained one.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { initials } from '../lib/format.ts';
import type { AuthUser } from './AuthContext.tsx';

const ICON = 'h-4 w-4 shrink-0 text-muted-foreground';

function GearIcon() {
  return (
    <svg
      className={ICON}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg
      className={ICON}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

const ITEM =
  'flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition hover:bg-accent';

export function UserMenu({
  user,
  isAdmin,
  onLogout,
}: {
  user: AuthUser;
  isAdmin: boolean;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Профил меню"
        className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-primary-foreground/15 text-xs font-semibold text-primary-foreground ring-1 ring-primary-foreground/30 transition hover:bg-primary-foreground/25"
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          initials(user.displayName?.trim() || user.email)
        )}
      </button>
      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
          <div className="border-b border-border px-4 py-3">
            <div className="truncate font-semibold">{user.displayName?.trim() || user.email}</div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {isAdmin ? 'Администратор' : 'Потребител'}
            </div>
            {user.displayName?.trim() ? (
              <div className="truncate text-xs text-muted-foreground">{user.email}</div>
            ) : null}
          </div>
          <nav className="py-1">
            <Link to="/auth/settings" className={ITEM} onClick={() => setOpen(false)}>
              <GearIcon />
              Настройки
            </Link>
            {isAdmin ? (
              <Link to="/auth/settings/admin/llm" className={ITEM} onClick={() => setOpen(false)}>
                <ShieldIcon />
                Платформа
              </Link>
            ) : null}
          </nav>
          <div className="border-t border-border py-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
              className={`${ITEM} text-destructive`}
            >
              <LogoutIcon />
              Изход
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

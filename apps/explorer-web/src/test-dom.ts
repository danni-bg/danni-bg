// DOM harness for the React-hook unit tests (`useServerState`, `useChatSession`, `useExplorer`).
// The app's `lib/*` state cores are framework-agnostic and tested without a DOM; the thin React
// wrappers over them still need one to run `useEffect`/`useState`. happy-dom + @testing-library
// supply it. Registration is per-file (beforeAll/afterAll) and only ADDS globals that are still
// undefined, so the DOM never leaks into the non-web (backend) test files sharing the process.

import { Window } from 'happy-dom';

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Node',
  'Element',
  'Event',
  'CustomEvent',
  'getComputedStyle',
  'localStorage',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

const added: string[] = [];

/** Install a happy-dom window's globals (once) and enable React's act environment. */
export function setupDom(): void {
  const w = new Window({ url: 'http://localhost/' });
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  for (const k of DOM_GLOBALS) {
    if ((globalThis as Record<string, unknown>)[k] === undefined) {
      (globalThis as Record<string, unknown>)[k] = (w as unknown as Record<string, unknown>)[k];
      added.push(k);
    }
  }
}

/** Remove exactly the globals this harness added, so a following backend test file sees no DOM. */
export function teardownDom(): void {
  for (const k of added) delete (globalThis as Record<string, unknown>)[k];
  added.length = 0;
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
}

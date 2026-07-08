// React-binding coverage for `useChatSession` (the thin hook over the framework-agnostic store, whose
// state machine is exhaustively tested in useChatSession.test.ts). These exercise the hook wiring
// itself: the send-time scope built from the live explorer filters, the live elapsed-time meter, the
// mount restore / unmount detach effect, and the production `defaultDeps` (real transport + meApi +
// localStorage + explorer store). Needs a DOM — installed per-file so it never leaks to backend tests.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { setupDom, teardownDom } from '../test-dom.ts';

beforeAll(setupDom);
afterAll(teardownDom);

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { SessionSummary } from '../lib/meApi.ts';
import { explorerStore } from '../store/explorerStore.ts';
import { EMPTY_FILTERS } from '../types.ts';
import type { ChatCallbacks } from './sendChat.ts';
import { type ChatSessionDeps, useChatSession } from './useChatSession.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;

function resetExplorer() {
  explorerStore.setState({
    filters: { ...EMPTY_FILTERS },
    highlight: { geoEntityIds: [], datasetIds: [] },
    chatFocus: null,
    reader: null,
    selectedDataset: null,
  });
}

beforeEach(() => {
  resetExplorer();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function injectedDeps(over: Partial<ChatSessionDeps> = {}): ChatSessionDeps {
  return {
    transport: {
      sendChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['sendChat'],
      resumeChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['resumeChat'],
    },
    api: {
      listSessions: mock(async () => [] as SessionSummary[]),
      getSession: mock(async () => {
        throw new Error('not stubbed');
      }),
      deleteSession: mock(async () => {}),
      stopGeneration: mock(async () => {}),
    },
    storage: null, // the hook restore reads from here; null → nothing to restore
    effects: { selectRegions: () => {}, clearFocus: () => {}, clearHighlight: () => {} },
    ...over,
  };
}

describe('useChatSession — hook wiring', () => {
  it('builds send scope from the live explorer filters (chatFocus + reader grounding)', async () => {
    // chatFocus → scope.datasetIds; an open reader → groundingDatasetIds (both branches taken).
    explorerStore.getState().setChatFocus({ datasetId: 'd-focus', titleBg: 'T' });
    explorerStore
      .getState()
      .openReader({ datasetId: 'd-read', resourceId: 'r1', name: 'r', titleBg: 'T' });

    let seenBody: unknown;
    const sendChat = mock(async (body: unknown, cb: ChatCallbacks) => {
      seenBody = body;
      cb.onDone?.();
    });
    const deps = injectedDeps({
      transport: {
        sendChat: sendChat as unknown as ChatSessionDeps['transport']['sendChat'],
        resumeChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['resumeChat'],
      },
    });

    const { result } = renderHook(() => useChatSession({ enabled: true }, deps));
    await act(async () => {
      await result.current.send('въпрос');
    });

    const seenScope = (seenBody as { scope: unknown }).scope;
    expect((seenScope as { datasetIds?: string[] }).datasetIds).toEqual(['d-focus']);
    expect((seenBody as { groundingDatasetIds?: string[] }).groundingDatasetIds).toEqual([
      'd-read',
    ]);
    expect(result.current.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('runs the live elapsed-time meter while streaming and stops it on done', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const sendChat = mock(async (_body: unknown, cb: ChatCallbacks) => {
      cb.onToken?.('…');
      await gate; // hold the turn open so the elapsed interval ticks
      cb.onDone?.();
    });
    const deps = injectedDeps({
      transport: {
        sendChat: sendChat as unknown as ChatSessionDeps['transport']['sendChat'],
        resumeChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['resumeChat'],
      },
    });

    const { result } = renderHook(() => useChatSession({ enabled: true }, deps));

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.send('дълъг въпрос');
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));

    await act(async () => {
      await sleep(160); // > the 100ms tick, so the interval callback fires
    });
    expect(result.current.elapsedMs).toBeGreaterThan(0);

    await act(async () => {
      release();
      await sendPromise;
    });
    expect(result.current.streaming).toBe(false);
  });

  it('exposes stop/newChat/openSession/removeSession bound to the store', async () => {
    const deps = injectedDeps({
      api: {
        listSessions: mock(async () => [] as SessionSummary[]),
        getSession: mock(async () => ({ sessionId: 's9', messages: [], contextDatasetIds: [] })),
        deleteSession: mock(async () => {}),
        stopGeneration: mock(async () => {}),
      },
    });
    const { result } = renderHook(() => useChatSession({ enabled: true }, deps));

    act(() => result.current.stop());
    act(() => result.current.newChat());
    await act(async () => {
      await result.current.openSession('s9');
    });
    expect(result.current.sessionId).toBe('s9');
    await act(async () => {
      await result.current.removeSession('s9');
    });
    expect(result.current.sessionId).toBeNull(); // removing the open session reset it
  });

  it('does not restore when disabled', async () => {
    const getSession = mock(async () => ({ sessionId: 's', messages: [], contextDatasetIds: [] }));
    const listSessions = mock(async () => [] as SessionSummary[]);
    const deps = injectedDeps({
      storage: {
        getItem: () => 's1',
        setItem: () => {},
        removeItem: () => {},
      },
      api: {
        getSession,
        listSessions,
        deleteSession: mock(async () => {}),
        stopGeneration: mock(async () => {}),
      },
    });
    renderHook(() => useChatSession({ enabled: false }, deps));
    await act(async () => {
      await sleep(0);
    });
    expect(listSessions).not.toHaveBeenCalled(); // the enabled:false guard short-circuits restore
  });

  it('wires the production defaultDeps (real transport + meApi + localStorage + explorer store)', async () => {
    // Stub the network so the real meApi/transport used by defaultDeps resolve deterministically.
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sessions: [] }),
      }) as unknown as Response) as typeof fetch;

    const { result, unmount } = renderHook(() => useChatSession({ enabled: true }));
    await act(async () => {
      await sleep(0); // let the real restore() (listSessions) settle
    });

    // newChat drives defaultDeps' explorer-store effects (selectRegions([]) + clearFocus + clearHighlight).
    explorerStore.getState().setChatFocus({ datasetId: 'd1', titleBg: 'T' });
    explorerStore.getState().selectRegions(['geo:x']);
    act(() => result.current.newChat());
    expect(explorerStore.getState().chatFocus).toBeNull();
    expect(explorerStore.getState().filters.geoUnitIds).toEqual([]);

    unmount(); // triggers the detach cleanup (must not throw)
  });
});

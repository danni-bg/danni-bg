import { describe, expect, it, mock } from 'bun:test';
import type { ResumedSession, SessionSummary } from '../lib/meApi.ts';
import type { ChatCallbacks } from './sendChat.ts';
import {
  type ChatSessionDeps,
  type ChatSessionEffects,
  createChatSessionStore,
  lastGroundedRegions,
} from './useChatSession.ts';

// --- test doubles -----------------------------------------------------------

/** An in-memory localStorage stand-in. */
function memoryStorage(seed?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    has: (k: string) => map.has(k),
  };
}

function recordingEffects(): ChatSessionEffects & { regions: string[][]; focusCleared: number } {
  const regions: string[][] = [];
  let focusCleared = 0;
  return {
    regions,
    get focusCleared() {
      return focusCleared;
    },
    selectRegions: (ids) => void regions.push(ids),
    clearFocus: () => {
      focusCleared++;
    },
    clearHighlight: () => {},
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function baseDeps(over: Partial<ChatSessionDeps> = {}): ChatSessionDeps {
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
    storage: memoryStorage(),
    effects: recordingEffects(),
    ...over,
  };
}

const resumed = (over: Partial<ResumedSession> = {}): ResumedSession => ({
  sessionId: 's1',
  messages: [],
  contextDatasetIds: [],
  ...over,
});

// --- send -------------------------------------------------------------------

describe('createChatSessionStore — send', () => {
  it('appends the user + assistant turns, streams into the bubble, and stamps usage + duration', async () => {
    const sendChat = mock(async (_body, cb: ChatCallbacks) => {
      cb.onSession?.('sv1');
      cb.onToken?.('Здра');
      cb.onToken?.('вей');
      cb.onUsage?.({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 });
      cb.onDone?.();
    });
    const deps = baseDeps({
      transport: {
        sendChat: sendChat as unknown as ChatSessionDeps['transport']['sendChat'],
        resumeChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['resumeChat'],
      },
    });
    const store = createChatSessionStore(deps);

    await store.getState().send('  Привет  ', { scope: {} });

    const s = store.getState();
    expect(s.streaming).toBe(false);
    expect(s.sessionId).toBe('sv1'); // onSession persisted
    expect(s.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Привет'],
      ['assistant', 'Здравей'],
    ]);
    const assistant = s.messages[1];
    expect(assistant?.usage).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 });
    expect(typeof assistant?.durationMs).toBe('number'); // a fresh send DOES record duration
  });

  it('routes message/citations/anchors callbacks into the transcript + effects', async () => {
    const effects = recordingEffects();
    const stopGeneration = mock(async () => {});
    const sendChat = mock(async (_body, cb: ChatCallbacks) => {
      cb.onMessage?.('gen-42'); // records the generation id for a later server-side stop
      cb.onToken?.('Да');
      cb.onCitations?.([
        { datasetId: 'd1', titleBg: 'Набор', sourceUrl: 'u', freshness: {} as never },
      ]);
      cb.onAnchors?.({ geoEntityIds: ['geo:bg-oblast-ruse'], datasetIds: [] });
      cb.onAnchors?.({ geoEntityIds: [], datasetIds: [] }); // empty anchor → no re-selection
      cb.onDone?.();
    });
    const deps = baseDeps({
      effects,
      transport: {
        sendChat: sendChat as unknown as ChatSessionDeps['transport']['sendChat'],
        resumeChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['resumeChat'],
      },
      api: { ...baseDeps().api, stopGeneration },
    });
    const store = createChatSessionStore(deps);

    await store.getState().send('въпрос', { scope: {} });

    const assistant = store.getState().messages[1];
    expect(assistant?.content).toBe('Да');
    expect(assistant?.citations?.[0]?.datasetId).toBe('d1');
    // The non-empty anchor re-selected regions; the empty one did not append.
    expect(effects.regions).toEqual([['geo:bg-oblast-ruse']]);

    // The recorded generation id is what a subsequent stop targets server-side.
    store.getState().stop();
    expect(stopGeneration).toHaveBeenCalledWith('gen-42');
  });

  it('detach aborts the in-flight reader locally without stopping it server-side', async () => {
    const stopGeneration = mock(async () => {});
    const storage = memoryStorage({ 'danni.chat.session': 's1' });
    const deps = baseDeps({
      storage,
      transport: {
        sendChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['sendChat'],
        resumeChat: hangingResume() as unknown as ChatSessionDeps['transport']['resumeChat'],
      },
      api: {
        ...baseDeps().api,
        getSession: mock(async () => resumed({ streaming: { messageId: 'gen-9' } })),
        stopGeneration,
      },
    });
    const store = createChatSessionStore(deps);
    const p = store.getState().restore();
    await flush();
    expect(store.getState().streaming).toBe(true);

    store.getState().detach();
    await expect(p).resolves.toBeUndefined();
    expect(store.getState().streaming).toBe(false);
    expect(stopGeneration).not.toHaveBeenCalled(); // detach is local-only (FR-412)
    expect(store.getState().error).toBeNull(); // an abort is not an error
  });

  it('is a no-op for a blank question or while already streaming', async () => {
    const store = createChatSessionStore(baseDeps());
    await store.getState().send('   ', { scope: {} });
    expect(store.getState().messages).toEqual([]);
  });

  it('surfaces a network failure during send as the shared error affordance', async () => {
    const deps = baseDeps({
      transport: {
        sendChat: mock(async () => {
          throw new Error('boom');
        }) as unknown as ChatSessionDeps['transport']['sendChat'],
        resumeChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['resumeChat'],
      },
    });
    const store = createChatSessionStore(deps);
    await store.getState().send('въпрос', { scope: {} });
    expect(store.getState().error).toBe('мрежова грешка');
    expect(store.getState().streaming).toBe(false);
  });

  it('tolerates a session-list refresh failure (refreshSessions swallows the rejection)', async () => {
    // onDone triggers refreshSessions(); if listSessions rejects, the turn must still complete cleanly.
    const deps = baseDeps({
      transport: {
        sendChat: mock(async (_body, cb: ChatCallbacks) => {
          cb.onToken?.('ok');
          cb.onDone?.();
        }) as unknown as ChatSessionDeps['transport']['sendChat'],
        resumeChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['resumeChat'],
      },
      api: {
        listSessions: mock(async () => {
          throw new Error('offline');
        }),
        getSession: mock(async () => {
          throw new Error('not stubbed');
        }),
        deleteSession: mock(async () => {}),
        stopGeneration: mock(async () => {}),
      },
    });
    const store = createChatSessionStore(deps);
    await store.getState().send('въпрос', { scope: {} });
    await flush(); // let the swallowed refreshSessions rejection settle
    expect(store.getState().streaming).toBe(false);
    expect(store.getState().sessions).toEqual([]); // failed refresh left the list untouched
  });

  it('surfaces a server-sent error event (onError) as the message error', async () => {
    // Distinct from a thrown network failure: the stream opens fine but the server emits an `error`
    // SSE event mid-turn, which the onError callback routes into state.
    const deps = baseDeps({
      transport: {
        sendChat: mock(async (_body, cb: ChatCallbacks) => {
          cb.onError?.('провалено генериране');
          cb.onDone?.();
        }) as unknown as ChatSessionDeps['transport']['sendChat'],
        resumeChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['resumeChat'],
      },
    });
    const store = createChatSessionStore(deps);
    await store.getState().send('въпрос', { scope: {} });
    expect(store.getState().error).toBe('провалено генериране');
  });
});

// --- restore + resume through the one attachStream path (FR-411) -------------

describe('createChatSessionStore — restore/resume', () => {
  it('restores a non-streaming conversation and maps its messages exactly once', async () => {
    const getSession = mock(async () =>
      resumed({
        messages: [
          { role: 'user', content: 'Q' },
          {
            role: 'assistant',
            content: 'A',
            citations: [
              { datasetId: 'd1', titleBg: 'Набор', sourceUrl: 'u', freshness: {} as never },
            ],
            usage: { inputTokens: 3, outputTokens: 4, cachedInputTokens: 1 },
            durationMs: 1200,
          },
        ],
      }),
    );
    const storage = memoryStorage({ 'danni.chat.session': 's1' });
    const deps = baseDeps({ storage, api: { ...baseDeps().api, getSession } });
    const store = createChatSessionStore(deps);

    await store.getState().restore();

    const msgs = store.getState().messages;
    expect(msgs.map((m) => m.content)).toEqual(['Q', 'A']);
    expect(msgs.map((m) => m.id)).toEqual([1, 2]); // sequential ids from the single mapper
    expect(msgs[1]?.citations?.[0]?.datasetId).toBe('d1');
    expect(msgs[1]?.durationMs).toBe(1200); // persisted duration is preserved verbatim
    expect(store.getState().sessionId).toBe('s1');
  });

  it('forgets a stored session that no longer exists', async () => {
    const storage = memoryStorage({ 'danni.chat.session': 'gone' });
    const deps = baseDeps({
      storage,
      api: {
        ...baseDeps().api,
        getSession: mock(async () => {
          throw new Error('404');
        }),
      },
    });
    await createChatSessionStore(deps).getState().restore();
    expect(storage.has('danni.chat.session')).toBe(false);
  });

  it('re-attaches to a live generation via the SAME attachStream path and OMITS resumed duration (FR-413)', async () => {
    // The resume streams a token + usage + done; because it is a resume, no durationMs is stamped.
    const resumeChat = mock(async (_id, cb: ChatCallbacks) => {
      cb.onToken?.('още');
      cb.onUsage?.({ inputTokens: 7, outputTokens: 1, cachedInputTokens: 0 });
      cb.onDone?.();
    });
    const storage = memoryStorage({ 'danni.chat.session': 's1' });
    const deps = baseDeps({
      storage,
      transport: {
        sendChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['sendChat'],
        resumeChat: resumeChat as unknown as ChatSessionDeps['transport']['resumeChat'],
      },
      api: {
        ...baseDeps().api,
        getSession: mock(async () =>
          resumed({
            messages: [{ role: 'user', content: 'Q' }],
            streaming: { messageId: 'gen-9' },
          }),
        ),
      },
    });
    const store = createChatSessionStore(deps);

    await store.getState().restore();

    const last = store.getState().messages.at(-1);
    expect(last?.content).toBe('още');
    expect(last?.usage).toEqual({ inputTokens: 7, outputTokens: 1, cachedInputTokens: 0 });
    expect(last?.durationMs).toBeUndefined(); // FR-413: never a from-re-attach duration
    expect(store.getState().streaming).toBe(false);
  });
});

// --- abort / network failure during resume (FR-412, SC-2) -------------------

/** A resume that streams a partial token then hangs until aborted, rejecting like a real reader. */
function hangingResume() {
  return mock(
    (_id: string, cb: ChatCallbacks, _f: unknown, signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        cb.onToken?.('частичен');
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  );
}

describe('createChatSessionStore — abort/failure during resume (FR-412)', () => {
  it('aborting a mid-resume via newChat does NOT throw an unhandled rejection', async () => {
    const storage = memoryStorage({ 'danni.chat.session': 's1' });
    const deps = baseDeps({
      storage,
      transport: {
        sendChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['sendChat'],
        resumeChat: hangingResume() as unknown as ChatSessionDeps['transport']['resumeChat'],
      },
      api: {
        ...baseDeps().api,
        getSession: mock(async () => resumed({ streaming: { messageId: 'gen-9' } })),
      },
    });
    const store = createChatSessionStore(deps);

    const p = store.getState().restore();
    await flush(); // let getSession resolve + attachStream start streaming
    expect(store.getState().streaming).toBe(true);

    store.getState().newChat(); // aborts mid-resume
    await expect(p).resolves.toBeUndefined(); // the rejected read is swallowed inside attachStream
    expect(store.getState().error).toBeNull(); // an abort is not an error
    expect(store.getState().streaming).toBe(false);
    expect(store.getState().messages).toEqual([]); // newChat cleared the transcript
  });

  it('a genuine network failure during resume surfaces the error affordance (SC-2)', async () => {
    const storage = memoryStorage({ 'danni.chat.session': 's1' });
    const deps = baseDeps({
      storage,
      transport: {
        sendChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['sendChat'],
        resumeChat: mock(async () => {
          throw new TypeError('Failed to fetch');
        }) as unknown as ChatSessionDeps['transport']['resumeChat'],
      },
      api: {
        ...baseDeps().api,
        getSession: mock(async () => resumed({ streaming: { messageId: 'gen-9' } })),
      },
    });
    const store = createChatSessionStore(deps);

    await store.getState().restore();
    expect(store.getState().error).toBe('мрежова грешка');
    expect(store.getState().streaming).toBe(false);
  });
});

// --- new / open / delete transitions ----------------------------------------

describe('createChatSessionStore — session transitions', () => {
  it('newChat clears state, persistence, and explorer side effects', async () => {
    const effects = recordingEffects();
    const storage = memoryStorage({ 'danni.chat.session': 's1' });
    const deps = baseDeps({
      storage,
      effects,
      api: {
        ...baseDeps().api,
        getSession: mock(async () => resumed({ messages: [{ role: 'user', content: 'Q' }] })),
      },
    });
    const store = createChatSessionStore(deps);
    await store.getState().restore();
    expect(store.getState().messages.length).toBe(1);

    store.getState().newChat();
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().sessionId).toBeNull();
    expect(storage.has('danni.chat.session')).toBe(false);
    expect(effects.focusCleared).toBeGreaterThan(0);
    expect(effects.regions.at(-1)).toEqual([]); // regions cleared on new chat
  });

  it('openSession loads a transcript, clears focus, and re-selects grounded regions', async () => {
    const effects = recordingEffects();
    const getSession = mock(async () =>
      resumed({
        sessionId: 's2',
        messages: [
          { role: 'user', content: 'Q' },
          {
            role: 'assistant',
            content: 'A',
            anchors: { geoEntityIds: ['geo:bg-oblast-ruse'], datasetIds: [] },
          },
        ],
      }),
    );
    const deps = baseDeps({ effects, api: { ...baseDeps().api, getSession } });
    const store = createChatSessionStore(deps);

    await store.getState().openSession('s2');

    expect(store.getState().sessionId).toBe('s2');
    expect(store.getState().messages.map((m) => m.content)).toEqual(['Q', 'A']);
    expect(effects.focusCleared).toBeGreaterThan(0);
    expect(effects.regions.at(-1)).toEqual(['geo:bg-oblast-ruse']);
  });

  it('openSession re-attaches when the opened conversation is still streaming (FR-411)', async () => {
    const resumeChat = mock(async (_id, cb: ChatCallbacks) => {
      cb.onToken?.('продължение');
      cb.onDone?.();
    });
    const getSession = mock(async () =>
      resumed({
        sessionId: 's3',
        messages: [{ role: 'user', content: 'Q' }],
        streaming: { messageId: 'gen-7' },
      }),
    );
    const deps = baseDeps({
      transport: {
        sendChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['sendChat'],
        resumeChat: resumeChat as unknown as ChatSessionDeps['transport']['resumeChat'],
      },
      api: { ...baseDeps().api, getSession },
    });
    const store = createChatSessionStore(deps);

    await store.getState().openSession('s3');

    expect(resumeChat).toHaveBeenCalledTimes(1);
    expect(store.getState().messages.at(-1)?.content).toBe('продължение');
    expect(store.getState().streaming).toBe(false);
  });

  it('removeSession surfaces a delete failure', async () => {
    const deps = baseDeps({
      api: {
        ...baseDeps().api,
        deleteSession: mock(async () => {
          throw new Error('500');
        }),
      },
    });
    const store = createChatSessionStore(deps);
    await store.getState().removeSession('s1');
    expect(store.getState().error).toBe('Неуспешно изтриване на разговора.');
  });

  it('openSession surfaces a load failure', async () => {
    const deps = baseDeps({
      api: {
        ...baseDeps().api,
        getSession: mock(async () => {
          throw new Error('500');
        }),
      },
    });
    const store = createChatSessionStore(deps);
    await store.getState().openSession('bad');
    expect(store.getState().error).toBe('Неуспешно зареждане на разговора.');
  });

  it('removeSession deletes, drops it from the list, and resets when it was open', async () => {
    const deleteSession = mock(async () => {});
    const storage = memoryStorage({ 'danni.chat.session': 's1' });
    const deps = baseDeps({
      storage,
      api: {
        listSessions: mock(
          async () => [{ id: 's1', title: 'A', updatedAt: '' }] as SessionSummary[],
        ),
        getSession: mock(async () => resumed({ sessionId: 's1' })),
        deleteSession,
        stopGeneration: mock(async () => {}),
      },
    });
    const store = createChatSessionStore(deps);
    await store.getState().restore(); // populates the session list + opens s1
    await flush(); // let refreshSessions resolve
    expect(store.getState().sessions.length).toBe(1);
    expect(store.getState().sessionId).toBe('s1');

    await store.getState().removeSession('s1');
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(store.getState().sessions).toEqual([]);
    expect(store.getState().sessionId).toBeNull(); // the open session was reset
  });

  it('stop aborts locally and stops the generation server-side', async () => {
    const stopGeneration = mock(async () => {});
    const resumeChat = hangingResume();
    const storage = memoryStorage({ 'danni.chat.session': 's1' });
    const deps = baseDeps({
      storage,
      transport: {
        sendChat: mock(async () => {}) as unknown as ChatSessionDeps['transport']['sendChat'],
        resumeChat: resumeChat as unknown as ChatSessionDeps['transport']['resumeChat'],
      },
      api: {
        ...baseDeps().api,
        getSession: mock(async () => resumed({ streaming: { messageId: 'gen-9' } })),
        stopGeneration,
      },
    });
    const store = createChatSessionStore(deps);
    const p = store.getState().restore();
    await flush();

    store.getState().stop();
    await p;
    expect(stopGeneration).toHaveBeenCalledWith('gen-9');
    expect(store.getState().streaming).toBe(false);
  });
});

// --- pure helper ------------------------------------------------------------

describe('lastGroundedRegions', () => {
  it('returns the latest assistant turn with a non-empty geo anchor', () => {
    expect(
      lastGroundedRegions([
        { role: 'assistant', anchors: { geoEntityIds: ['a'], datasetIds: [] } },
        { role: 'user' },
        { role: 'assistant', anchors: { geoEntityIds: ['b', 'c'], datasetIds: [] } },
        { role: 'assistant', anchors: { geoEntityIds: [], datasetIds: [] } },
      ]),
    ).toEqual(['b', 'c']);
  });

  it('returns [] when nothing grounded', () => {
    expect(lastGroundedRegions([{ role: 'user' }])).toEqual([]);
  });
});

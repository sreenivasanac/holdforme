// Shared state: session (API key), calls list, one live call (long-poll), settings.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, ApiError, setApiKey, setUnauthorizedHandler, type Call, type Config, type Line, type Settings } from './api';
import { clearKey, loadKey, saveKey } from './platform/keyStore';

const LONG_POLL_SECONDS = 25;
const LIST_POLL_MS = 3000;
const RETRY_MS = 3000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Try again.');

// ---- Session ----

export type Session = { key: string | null; signIn: (key: string) => Promise<void>; signOut: () => void };
export const SessionContext = createContext<Session>({ key: null, signIn: async () => {}, signOut: () => {} });
export const useSession = () => useContext(SessionContext);

/** Creates the session value for the root layout. A 401 anywhere signs out. */
export function useSessionState(): Session {
  const [key, setKey] = useState<string | null>(() => {
    const k = loadKey();
    setApiKey(k);
    return k;
  });
  const signOut = useCallback(() => {
    clearKey();
    setApiKey(null);
    setKey(null);
  }, []);
  useEffect(() => setUnauthorizedHandler(signOut), [signOut]);
  const signIn = useCallback(async (k: string) => {
    setApiKey(k);
    await api.profile(); // checks the key; throws ApiError on 401
    saveKey(k);
    setKey(k);
  }, []);
  return { key, signIn, signOut };
}

// ---- Calls list (shared by the alert banner and the Calls screen) ----

export type CallsState = {
  calls: Call[] | null;
  error: string | null;
  refresh: () => void;
  acknowledged: Set<string>;
  acknowledge: (id: string) => void;
};
export const CallsContext = createContext<CallsState>({ calls: null, error: null, refresh: () => {}, acknowledged: new Set(), acknowledge: () => {} });
export const useCalls = () => useContext(CallsContext);

export function useCallsState(enabled: boolean): CallsState {
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [acknowledged, setAck] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const list = await api.listCalls();
        if (!stop) {
          setCalls(list);
          setError(null);
        }
      } catch (e) {
        if (!stop) setError(message(e));
      }
      if (!stop) timer = setTimeout(load, LIST_POLL_MS);
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [enabled, tick]);
  return {
    calls,
    error,
    refresh: () => setTick((t) => t + 1),
    acknowledged,
    acknowledge: (id) => setAck((s) => new Set(s).add(id)),
  };
}

// ---- One call, followed with the same long-poll as agents ----

export function useCall(id: string) {
  const [call, setCall] = useState<Call | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    let lines: Line[] = [];
    let since = 0;
    let wait = 0; // first load returns at once
    setCall(null);
    void (async () => {
      while (!ac.signal.aborted) {
        try {
          const c = await api.getCall(id, wait, since, ac.signal);
          const fresh = (c.transcript ?? []).filter((l) => l.n >= since);
          lines = lines.concat(fresh);
          since = c.next_line ?? (fresh.length ? fresh[fresh.length - 1].n + 1 : since);
          setCall({ ...c, transcript: lines });
          setError(null);
          if (c.finished) return;
          wait = LONG_POLL_SECONDS;
        } catch (e) {
          if (ac.signal.aborted) return;
          setError(message(e));
          if (e instanceof ApiError && e.status === 404) return;
          await sleep(RETRY_MS);
        }
      }
    })();
    return () => ac.abort();
  }, [id]);
  return { call, error };
}

// ---- Settings and server config ----

export type CallerIdState = { number: string | null; verified: boolean };

export function useSettings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [callerId, setCallerId] = useState<CallerIdState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stop = false;
    setError(null);
    // A failing caller-ID check must not block the screen: treat it as not verified.
    const cid = api.callerId().catch(() => ({ number: null, verified: false }));
    Promise.all([api.config(), api.profile(), cid])
      .then(([c, p, v]) => {
        if (stop) return;
        setConfig(c);
        setSettings(p);
        setCallerId(v);
      })
      .catch((e) => !stop && setError(message(e)));
    return () => {
      stop = true;
    };
  }, [tick]);
  const save = useCallback(async (patch: Partial<Settings>) => {
    const next = await api.saveProfile(patch);
    setSettings(next);
    return next;
  }, []);
  const reloadCallerId = useCallback(() => api.callerId().then(setCallerId), []);
  return { config, settings, callerId, reloadCallerId, error, reload: () => setTick((t) => t + 1), save };
}

/** Re-renders every `ms` and returns the current time (timers, countdowns). */
export function useNow(ms = 1000, active = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return now;
}

/** Latest value in a ref, for callbacks that must not re-subscribe. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

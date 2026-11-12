// Shared state: session, calls list, one live call (long-poll), settings.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, ApiError, setUnauthorizedHandler, type AuthMe, type Call, type Config, type Line, type Settings } from './api';
import { forgetOldKey } from './platform/storage';

const LONG_POLL_SECONDS = 25;
const LIST_POLL_MS = 3000;
const RETRY_MS = 3000;
const MIN_POLL_MS = 2000; // the shortest gap between two unchanged long-poll answers
const LIST_LIMIT = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Try again.');

// ---- Session (cookie, checked with GET /api/auth/me) ----

export type Session = {
  me: AuthMe | null; // null while loading
  error: string | null;
  /** Asks the server who is signed in; false when that failed (the error is in `error`). */
  reload: () => Promise<boolean>;
  /** Throws when the server could not sign out. */
  signOut: () => Promise<void>;
};
export const SessionContext = createContext<Session>({ me: null, error: null, reload: async () => false, signOut: async () => {} });
export const useSession = () => useContext(SessionContext);

/** Creates the session value for the root layout. An expired session anywhere shows the sign-in screen. */
export function useSessionState(): Session {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setError(null);
    try {
      setMe(await api.me());
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    }
  }, []);
  const out = useCallback(() => setMe((m) => (m ? { ...m, signed_in: false, email: null } : m)), []);
  useEffect(() => {
    forgetOldKey();
    setUnauthorizedHandler(out);
    void reload();
  }, [out, reload]);
  const signOut = useCallback(async () => {
    try {
      await api.signOut();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e; // 401: the session had already ended
    }
    out();
  }, [out]);
  return { me, error, reload, signOut };
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
        const list = await api.listCalls(LIST_LIMIT);
        if (!stop) {
          setCalls(list);
          setError(null);
          // A dismissed alert that ended is forgotten, so the next alert on that call rings again.
          setAck((ack) => {
            const still = [...ack].filter((id) => list.some((c) => c.id === id && !c.finished && c.owner.state === 'alerting'));
            return still.length === ack.size ? ack : new Set(still);
          });
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

/** What the long-poll compares to see whether anything changed (talk_seconds counts up by itself). */
const signature = (c: Call) => JSON.stringify({ ...c, transcript: undefined, next_line: undefined, talk_seconds: undefined });

export function useCall(id: string) {
  const [call, setCall] = useState<Call | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    let lines: Line[] = [];
    let since = 0;
    let wait = 0; // first load returns at once
    let last = '';
    setCall(null);
    void (async () => {
      while (!ac.signal.aborted) {
        try {
          const started = Date.now();
          const c = await api.getCall(id, wait, since, ac.signal);
          const fresh = (c.transcript ?? []).filter((l) => l.n >= since);
          lines = lines.concat(fresh);
          since = c.next_line ?? (fresh.length ? fresh[fresh.length - 1].n + 1 : since);
          setCall({ ...c, transcript: lines });
          setError(null);
          if (c.finished) return;
          // The server may answer at once without a change (e.g. an inbound call it does not follow):
          // wait a little so this does not become a tight loop.
          const sig = signature(c);
          if (wait && !fresh.length && sig === last && Date.now() - started < MIN_POLL_MS) await sleep(MIN_POLL_MS);
          last = sig;
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

// ---- Settings and server config: loaded once for the whole console ----

export type CallerIdState = { number: string | null; verified: boolean };

export type SettingsState = {
  config: Config | null;
  settings: Settings | null;
  error: string | null;
  reload: () => void;
  save: (patch: Partial<Settings>) => Promise<Settings>;
  callerId: CallerIdState | null;
  /** Asks the server (a live Twilio lookup), so only screens that show caller ID call it. */
  loadCallerId: () => Promise<void>;
};
export const SettingsContext = createContext<SettingsState | null>(null);

export function useSettings(): SettingsState {
  const s = useContext(SettingsContext);
  if (!s) throw new Error('useSettings outside the console');
  return s;
}

/** The caller-ID state, loaded the first time a screen needs it. */
export function useCallerId() {
  const { callerId, loadCallerId } = useSettings();
  useEffect(() => {
    if (!callerId) void loadCallerId().catch(() => {});
  }, [callerId, loadCallerId]);
  return callerId;
}

export function useSettingsState(): SettingsState {
  const [config, setConfig] = useState<Config | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [callerId, setCallerId] = useState<CallerIdState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stop = false;
    setError(null);
    Promise.all([api.config(), api.profile()])
      .then(([c, p]) => {
        if (stop) return;
        setConfig(c);
        setSettings(p);
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
  const loadCallerId = useCallback(async () => {
    try {
      setCallerId(await api.callerId());
    } catch (e) {
      // A failing lookup must not block the screen: treat it as not verified.
      setCallerId({ number: null, verified: false });
      throw e;
    }
  }, []);
  return { config, settings, error, reload: () => setTick((t) => t + 1), save, callerId, loadCallerId };
}

// ---- Leaving the call page while the owner has the call through the browser ----

export type LeaveGuard = { guarded: boolean; setGuarded: (on: boolean) => void; go: (href: string) => void };
export const LeaveGuardContext = createContext<LeaveGuard>({ guarded: false, setGuarded: () => {}, go: () => {} });
/** Navigate inside the console; asks first while the owner has a call in this tab. */
export const useGo = () => useContext(LeaveGuardContext).go;

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

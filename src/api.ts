import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_CONFIG,
  EMPTY_STATE,
  KV_KEYS,
  type ActionRequest,
  type ActionResponse,
  type AppConfig,
  type AppState,
  type HistoryEntry,
} from '../shared/types';
import { themeStore } from './host-theme';

declare global {
  interface Window {
    CRIBL_API_URL: string;
    CRIBL_BASE_PATH: string;
    CRIBL_APP_ID?: string;
  }
}

const kvUrl = (key: string) => `${window.CRIBL_API_URL}/kvstore/${key}`;

export async function kvGet(key: string): Promise<string | null> {
  const res = await fetch(kvUrl(key));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Couldn't read ${key} (HTTP ${res.status})`);
  return res.text();
}

export async function kvPut(key: string, value: string): Promise<void> {
  const res = await fetch(kvUrl(key), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: value,
  });
  if (!res.ok) throw new Error(`Couldn't save ${key} (HTTP ${res.status})`);
}

/** Names of the keys currently in the app's KV store (used to tell whether a secret is set). */
export async function kvKeys(): Promise<string[]> {
  const res = await fetch(kvUrl('keys'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefix: '' }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as unknown;
  const list = Array.isArray(data) ? data : ((data as { items?: unknown[] }).items ?? []);
  return list.map((k) => (typeof k === 'string' ? k : String((k as { key?: string }).key ?? '')));
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function mergeConfig(partial: Partial<AppConfig>): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    device: { ...DEFAULT_CONFIG.device, ...partial.device },
    search: { ...DEFAULT_CONFIG.search, ...partial.search },
    summary: { ...DEFAULT_CONFIG.summary, ...partial.summary },
    twilio: { ...DEFAULT_CONFIG.twilio, ...partial.twilio },
    s3: { ...DEFAULT_CONFIG.s3, ...partial.s3 },
  };
}

function appId(): string {
  return window.CRIBL_APP_ID ?? window.CRIBL_BASE_PATH.split('/').filter(Boolean).pop() ?? '';
}

/** Invokes the `action` backend endpoint. */
export async function callAction(req: ActionRequest): Promise<ActionResponse> {
  const res = await fetch(`${window.CRIBL_API_URL}/a/${encodeURIComponent(appId())}/endpoints/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  const text = await res.text();
  const body = parseJson<Partial<ActionResponse> & { error?: string }>(text, {});
  if ('ok' in body && typeof body.ok === 'boolean') return body as ActionResponse;
  return { ok: false, error: body.error ?? `Request failed (HTTP ${res.status})` };
}

export type AppData = {
  config: AppConfig;
  state: AppState;
  history: HistoryEntry[];
  secrets: { twilio: boolean; aws: boolean };
};

/** Loads config, state, and history from the KV store, refreshing every 30s while mounted. */
export function useAppData() {
  const [data, setData] = useState<AppData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [config, state, history, keys] = await Promise.all([
        kvGet(KV_KEYS.config),
        kvGet(KV_KEYS.state),
        kvGet(KV_KEYS.history),
        kvKeys(),
      ]);
      setData({
        config: mergeConfig(parseJson<Partial<AppConfig>>(config, {})),
        state: { ...EMPTY_STATE, ...parseJson<Partial<AppState>>(state, {}) },
        history: parseJson<HistoryEntry[]>(history, []),
        secrets: { twilio: keys.includes(KV_KEYS.twilioBasic), aws: keys.includes(KV_KEYS.awsSecretKey) },
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { data, error, refresh };
}

/** Current time, updated every 30s, so render stays pure. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function useHostTheme() {
  return useSyncExternalStore(themeStore.subscribe, themeStore.get);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return 'Never';
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

export const dateTime = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);

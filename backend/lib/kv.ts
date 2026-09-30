// App-scoped KV store access from a backend endpoint. The frontend reaches the same store via
// CRIBL_API_URL + '/kvstore/...', which the platform rewrites to this app-scoped path.

export type Kv = {
  get(key: string): Promise<string | null>;
  getJson<T>(key: string, fallback: T): Promise<T>;
  put(key: string, value: string): Promise<void>;
  putJson(key: string, value: unknown): Promise<void>;
};

export function createKv(appId: string): Kv {
  const base = `/api/v1/a/${encodeURIComponent(appId)}/kvstore/`;

  const get = async (key: string) => {
    const res = await fetch(base + key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV get ${key} failed: HTTP ${res.status}`);
    return res.text();
  };

  const put = async (key: string, value: string) => {
    const res = await fetch(base + key, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: value,
    });
    if (!res.ok) throw new Error(`KV put ${key} failed: HTTP ${res.status}`);
  };

  return {
    get,
    put,
    async getJson<T>(key: string, fallback: T): Promise<T> {
      const raw = await get(key);
      if (!raw) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    },
    putJson: (key, value) => put(key, JSON.stringify(value)),
  };
}

// Runs a Cribl Search job over the PA-410 logs and aggregates the device's traffic per domain.

import type { AppConfig } from '../../shared/types.js';

const JOBS = '/api/v1/m/default_search/search/jobs';
const POLL_MS = 1500;
const MAX_WAIT_MS = 90_000;

export type SiteActivity = {
  domain: string;
  category: string;
  hits: number;
  blocked: boolean;
};

const BLOCK_ACTION = /block|deny|drop|reset|override/i;

/**
 * Normalises a PAN-OS URL log value ("www.example.com/path", "https://x.com:443/") to a hostname.
 * A leading "www." is dropped: list entries also cover subdomains, so example.com includes www.
 */
export function toDomain(raw: string): string {
  let s = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, '');
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');
  return /^[a-z0-9.-]+$/.test(s) && s.includes('.') ? s : '';
}

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function buildQuery(cfg: AppConfig): string {
  const s = cfg.search;
  if (s.customQuery.trim()) return s.customQuery.replaceAll('{ip}', cfg.device.ip);
  return [
    `dataset=${quote(s.dataset)}`,
    `| where ${s.srcField} == ${quote(cfg.device.ip)} and isnotempty(${s.urlField})`,
    `| summarize hits=count() by ${s.urlField}, ${s.actionField}, ${s.categoryField}`,
  ].join(' ');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readResults(id: string): Promise<{ finished: boolean; rows: Record<string, unknown>[] }> {
  const res = await fetch(`${JOBS}/${encodeURIComponent(id)}/results?limit=5000`);
  if (!res.ok) throw new Error(`Search results failed: HTTP ${res.status}`);
  const lines = (await res.text()).split('\n').filter(Boolean);
  if (lines.length === 0) return { finished: false, rows: [] };
  const header = JSON.parse(lines[0]) as { isFinished?: boolean; job?: { status?: string } };
  if (header.job?.status === 'failed' || header.job?.status === 'canceled') {
    throw new Error(`Search job ${id} ${header.job.status}`);
  }
  return { finished: Boolean(header.isFinished), rows: lines.slice(1).map((l) => JSON.parse(l)) };
}

/** Searches [sinceMs, now] and returns per-domain activity for the restricted device. */
export async function searchActivity(cfg: AppConfig, sinceMs: number): Promise<SiteActivity[]> {
  const res = await fetch(JOBS, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: buildQuery(cfg),
      earliest: Math.floor(sinceMs / 1000),
      latest: 'now',
      isPrivate: true,
    }),
  });
  if (!res.ok) throw new Error(`Search job create failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const created = (await res.json()) as { items?: { id: string }[] };
  const id = created.items?.[0]?.id;
  if (!id) throw new Error('Search job create returned no id');

  const started = Date.now();
  let rows: Record<string, unknown>[] = [];
  for (;;) {
    const r = await readResults(id);
    if (r.finished) {
      rows = r.rows;
      break;
    }
    if (Date.now() - started > MAX_WAIT_MS) throw new Error(`Search job ${id} did not finish in time`);
    await sleep(POLL_MS);
  }

  const byDomain = new Map<string, SiteActivity>();
  for (const row of rows) {
    const domain = toDomain(String(row[cfg.search.urlField] ?? ''));
    if (!domain) continue;
    const blocked = BLOCK_ACTION.test(String(row[cfg.search.actionField] ?? ''));
    const hits = Number(row.hits ?? 1) || 1;
    const key = `${domain}|${blocked}`;
    const existing = byDomain.get(key);
    if (existing) existing.hits += hits;
    else byDomain.set(key, { domain, blocked, hits, category: String(row[cfg.search.categoryField] ?? '') });
  }
  return [...byDomain.values()].sort((a, b) => b.hits - a.hits);
}

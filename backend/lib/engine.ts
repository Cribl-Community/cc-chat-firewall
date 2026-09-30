// Core app logic shared by the `tick` (scheduled) and `action` (UI) endpoints: activity summaries,
// WhatsApp command handling, allow/deny decisions, expiry of temporary allows, and publishing the
// PA-410 External Dynamic Lists to S3.

import {
  DEFAULT_CONFIG,
  EMPTY_STATE,
  KV_KEYS,
  missingConfig,
  parseDuration,
  type AppConfig,
  type AppState,
  type HistoryEntry,
  type HistoryKind,
  type SiteRequest,
} from '../../shared/types.js';
import { createKv, type Kv } from './kv.js';
import { putObject } from './s3.js';
import { searchActivity, toDomain } from './search.js';
import { broadcast, listInbound, sendWhatsApp } from './twilio.js';

const MAX_HISTORY = 300;
const MAX_SEEN_SIDS = 300;
/** Ignore chat commands older than this (e.g. after the app was paused for a while). */
const MAX_COMMAND_AGE_MS = 6 * 3_600_000;
/** Never search further back than this, even if the last summary is older. */
const MAX_LOOKBACK_MS = 24 * 3_600_000;
/** PAN-OS rejects an EDL with no valid entries, so an empty list carries a harmless placeholder. */
const EMPTY_LIST_PLACEHOLDER = 'placeholder.invalid/';

export type Ctx = {
  kv: Kv;
  cfg: AppConfig;
  state: AppState;
  history: HistoryEntry[];
  now: number;
};

export async function load(appId: string): Promise<Ctx> {
  const kv = createKv(appId);
  const [cfg, state, history] = await Promise.all([
    kv.getJson<Partial<AppConfig>>(KV_KEYS.config, {}),
    kv.getJson<Partial<AppState>>(KV_KEYS.state, {}),
    kv.getJson<HistoryEntry[]>(KV_KEYS.history, []),
  ]);
  return {
    kv,
    cfg: {
      ...DEFAULT_CONFIG,
      ...cfg,
      device: { ...DEFAULT_CONFIG.device, ...cfg.device },
      search: { ...DEFAULT_CONFIG.search, ...cfg.search },
      summary: { ...DEFAULT_CONFIG.summary, ...cfg.summary },
      twilio: { ...DEFAULT_CONFIG.twilio, ...cfg.twilio },
      s3: { ...DEFAULT_CONFIG.s3, ...cfg.s3 },
    },
    state: { ...EMPTY_STATE, ...state },
    history: Array.isArray(history) ? history : [],
    now: Date.now(),
  };
}

export async function save(ctx: Ctx): Promise<void> {
  await ctx.kv.putJson(KV_KEYS.state, ctx.state);
  await ctx.kv.putJson(KV_KEYS.history, ctx.history.slice(-MAX_HISTORY));
}

export function log(ctx: Ctx, kind: HistoryKind, text: string): void {
  ctx.history.push({ at: Date.now(), kind, text });
}

export function recordError(ctx: Ctx, where: string, err: unknown): void {
  const message = `${where}: ${err instanceof Error ? err.message : String(err)}`;
  ctx.state.lastError = { at: Date.now(), message };
  log(ctx, 'error', message);
}

export function assertConfigured(ctx: Ctx): void {
  const missing = missingConfig(ctx.cfg);
  if (missing.length) throw new Error(`Setup incomplete: missing ${missing.join(', ')}`);
}

// ---------------------------------------------------------------------------------------------
// Formatting helpers

export function fmtDuration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 6) / 10;
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 2.4) / 10}d`;
}

const isActiveAllow = (r: SiteRequest, now: number) =>
  r.status === 'allowed' && (r.expiresAt == null || r.expiresAt > now);

function describe(r: SiteRequest, now: number): string {
  if (r.status === 'allowed') {
    return r.expiresAt == null ? 'allowed permanently' : `allowed, ${fmtDuration(r.expiresAt - now)} left`;
  }
  return r.status;
}

// ---------------------------------------------------------------------------------------------
// Decisions

export type Decision = 'allow' | 'deny' | 'revoke';

/** Applies a decision to a request and returns a one-line confirmation. */
export function decide(
  ctx: Ctx,
  req: SiteRequest,
  decision: Decision,
  durationMs: number | null,
  by: string,
): string {
  const now = Date.now();
  req.decidedAt = now;
  req.decidedBy = by;
  let text: string;
  if (decision === 'allow') {
    req.status = 'allowed';
    req.expiresAt = durationMs == null ? null : now + durationMs;
    text = `✅ #${req.id} ${req.domain} allowed ${durationMs == null ? 'permanently' : `for ${fmtDuration(durationMs)}`}`;
  } else if (decision === 'deny') {
    req.status = 'denied';
    req.expiresAt = undefined;
    text = `⛔ #${req.id} ${req.domain} denied`;
  } else {
    req.status = 'revoked';
    req.expiresAt = undefined;
    text = `↩️ #${req.id} ${req.domain} access revoked`;
  }
  log(ctx, 'decision', `${text} (by ${by})`);
  return text;
}

function findOrCreate(ctx: Ctx, domain: string): SiteRequest {
  const existing = ctx.state.requests.find((r) => r.domain === domain);
  if (existing) return existing;
  const req: SiteRequest = {
    id: ctx.state.nextId++,
    domain,
    category: '',
    hits: 0,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    status: 'pending',
  };
  ctx.state.requests.push(req);
  return req;
}

/** Marks temporary allows that have run out as expired. Returns one line per expiry. */
export function expireAllows(ctx: Ctx): string[] {
  const now = Date.now();
  const lines: string[] = [];
  for (const r of ctx.state.requests) {
    if (r.status === 'allowed' && r.expiresAt != null && r.expiresAt <= now) {
      r.status = 'expired';
      const line = `⌛ #${r.id} ${r.domain} access expired and is blocked again`;
      log(ctx, 'expiry', line);
      lines.push(line);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// External Dynamic Lists

const edlEntries = (domain: string) => [`${domain}/`, `*.${domain}/`];

export function buildLists(state: AppState, now: number): { allow: string; block: string } {
  const allow = state.requests.filter((r) => isActiveAllow(r, now)).flatMap((r) => edlEntries(r.domain));
  const block = state.requests.filter((r) => r.status === 'denied').flatMap((r) => edlEntries(r.domain));
  const render = (entries: string[]) => `${(entries.length ? [...new Set(entries)].sort() : [EMPTY_LIST_PLACEHOLDER]).join('\n')}\n`;
  return { allow: render(allow), block: render(block) };
}

/** Uploads the allow/block lists to S3 when they changed (or always when `force`). */
export async function publishLists(ctx: Ctx, force = false): Promise<boolean> {
  const lists = buildLists(ctx.state, Date.now());
  const hash = `${lists.allow}\u0000${lists.block}`;
  if (!force && hash === ctx.state.publishedHash) return false;

  const secret = await ctx.kv.get(KV_KEYS.awsSecretKey);
  if (!secret) throw new Error('AWS secret access key is not set');
  const prefix = ctx.cfg.s3.prefix.replace(/^\/+|\/+$/g, '');
  await putObject(ctx.cfg, secret, `${prefix}/allow.txt`, lists.allow);
  await putObject(ctx.cfg, secret, `${prefix}/block.txt`, lists.block);

  ctx.state.publishedHash = hash;
  ctx.state.lastPublishAt = Date.now();
  const count = (s: string) => (s.startsWith(EMPTY_LIST_PLACEHOLDER) ? 0 : s.trim().split('\n').length / 2);
  log(ctx, 'publish', `Published lists: ${count(lists.allow)} allowed, ${count(lists.block)} denied site(s)`);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Activity summary

export async function runSummary(ctx: Ctx, force = false): Promise<void> {
  const now = Date.now();
  const intervalMs = ctx.cfg.summary.intervalMinutes * 60_000;
  const since = ctx.state.lastSummaryAt ? Math.max(ctx.state.lastSummaryAt, now - MAX_LOOKBACK_MS) : now - intervalMs;
  const activity = await searchActivity(ctx.cfg, since);
  ctx.state.lastSummaryAt = now;

  const newlyBlocked: SiteRequest[] = [];
  let retriedDenied = 0;
  for (const site of activity.filter((a) => a.blocked)) {
    const req = findOrCreate(ctx, site.domain);
    req.hits += site.hits;
    req.lastSeen = now;
    if (site.category && !req.category) req.category = site.category;
    if (req.status === 'denied') {
      retriedDenied += site.hits;
    } else if (!isActiveAllow(req, now)) {
      // New, expired, or revoked site asked for again: (re)open it for a decision.
      req.status = 'pending';
      req.expiresAt = undefined;
      newlyBlocked.push(req);
    }
  }

  const pendingOlder = ctx.state.requests.filter((r) => r.status === 'pending' && !newlyBlocked.includes(r));
  const allowedHits = activity.filter((a) => !a.blocked);
  const blockedHits = activity.filter((a) => a.blocked);
  const total = activity.reduce((n, a) => n + a.hits, 0);

  if (!force && ctx.cfg.summary.onlyWhenBlocked && newlyBlocked.length === 0) {
    log(ctx, 'summary', `Summary skipped: ${total} request(s), no new blocked sites`);
    return;
  }

  const name = ctx.cfg.device.name || ctx.cfg.device.ip;
  const lines: string[] = [`🛡️ *${name}* — last ${fmtDuration(now - since)}`];
  if (total === 0) {
    lines.push('No web activity.');
  } else {
    lines.push(
      `${total} request(s) to ${new Set(activity.map((a) => a.domain)).size} site(s), ` +
        `${blockedHits.reduce((n, a) => n + a.hits, 0)} blocked.`,
    );
    if (allowedHits.length) {
      lines.push('', '*Top sites*');
      for (const a of allowedHits.slice(0, 8)) lines.push(`• ${a.domain} (${a.hits})`);
    }
  }
  if (newlyBlocked.length) {
    lines.push('', '*Blocked — needs your decision*');
    for (const r of newlyBlocked) {
      lines.push(`#${r.id} ${r.domain}${r.category ? ` · ${r.category}` : ''} (${r.hits} tries)`);
    }
  }
  if (pendingOlder.length) {
    lines.push('', `Still waiting: ${pendingOlder.map((r) => `#${r.id} ${r.domain}`).join(', ')}`);
  }
  if (retriedDenied) lines.push('', `Denied sites were tried ${retriedDenied} more time(s).`);
  if (newlyBlocked.length || pendingOlder.length) {
    const ex = (newlyBlocked[0] ?? pendingOlder[0]).id;
    lines.push('', `Reply: *allow ${ex} 1h*, *allow ${ex} always*, *deny ${ex}*, or *help*`);
  }

  await broadcast(ctx.cfg, lines.join('\n'));
  log(ctx, 'summary', `Summary sent: ${total} request(s), ${newlyBlocked.length} new blocked site(s)`);
}

// ---------------------------------------------------------------------------------------------
// WhatsApp commands

const HELP = [
  '*Chat Firewall commands*',
  '• *allow 3* — allow #3 for the default time',
  '• *allow 3 2h* / *allow 3 30m* / *allow 3 1d*',
  '• *allow 3 always* — allow permanently',
  '• *allow 3,4 1h* — several at once (or *allow all 1h*)',
  '• *deny 3* — keep #3 blocked and stop asking',
  '• *revoke 3* — end an allow early',
  '• *allow example.com 1h* — use a site name instead of a number',
  '• *status* — pending requests and active allows',
  '• *summary* — send an activity summary now',
].join('\n');

const VERBS: Record<string, Decision | 'status' | 'help' | 'summary'> = {
  allow: 'allow', approve: 'allow', ok: 'allow', yes: 'allow', unblock: 'allow',
  deny: 'deny', block: 'deny', reject: 'deny', no: 'deny',
  revoke: 'revoke', remove: 'revoke', cancel: 'revoke',
  status: 'status', list: 'status', pending: 'status',
  help: 'help', '?': 'help', commands: 'help',
  summary: 'summary', report: 'summary',
};

export function statusText(ctx: Ctx): string {
  const now = Date.now();
  const pending = ctx.state.requests.filter((r) => r.status === 'pending');
  const allowed = ctx.state.requests.filter((r) => isActiveAllow(r, now));
  const denied = ctx.state.requests.filter((r) => r.status === 'denied');
  const lines = ['*Status*'];
  lines.push(pending.length ? `Pending: ${pending.map((r) => `#${r.id} ${r.domain}`).join(', ')}` : 'Pending: none');
  lines.push(
    allowed.length ? `Allowed: ${allowed.map((r) => `#${r.id} ${r.domain} (${describe(r, now)})`).join(', ')}` : 'Allowed: none',
  );
  if (denied.length) lines.push(`Denied: ${denied.map((r) => `#${r.id} ${r.domain}`).join(', ')}`);
  return lines.join('\n');
}

/** Handles one chat message. Returns the reply and whether a summary was requested. */
export function handleCommand(ctx: Ctx, from: string, body: string): { reply: string; wantsSummary: boolean } {
  const tokens = body.trim().toLowerCase().replace(/[,;]+/g, ' ').split(/\s+/).filter(Boolean);
  const verb = VERBS[tokens[0] ?? ''];
  if (!verb) return { reply: `Sorry, I didn't understand "${body.trim().slice(0, 60)}".\n\n${HELP}`, wantsSummary: false };
  if (verb === 'help') return { reply: HELP, wantsSummary: false };
  if (verb === 'status') return { reply: statusText(ctx), wantsSummary: false };
  if (verb === 'summary') return { reply: '📊 Preparing a summary…', wantsSummary: true };

  let args = tokens.slice(1);
  let durationMs: number | null = null;
  if (verb === 'allow') {
    const last = args[args.length - 1];
    const parsed = last ? parseDuration(last) : undefined;
    if (parsed !== undefined && args.length > 1) {
      durationMs = parsed;
      args = args.slice(0, -1);
    } else {
      durationMs = parseDuration(ctx.cfg.defaultAllowDuration) ?? 3_600_000;
    }
  }
  if (args.length === 0) return { reply: `Which site? e.g. *${tokens[0]} 3*. Send *status* to see numbers.`, wantsSummary: false };

  const targets: SiteRequest[] = [];
  const errors: string[] = [];
  for (const arg of args) {
    if (arg === 'all') {
      const pending = ctx.state.requests.filter((r) => r.status === 'pending');
      if (pending.length) targets.push(...pending);
      else errors.push('No requests are waiting for a decision');
      continue;
    }
    const num = /^#?(\d+)$/.exec(arg);
    if (num) {
      const req = ctx.state.requests.find((r) => r.id === Number(num[1]));
      if (req) targets.push(req);
      else errors.push(`#${num[1]} not found`);
      continue;
    }
    const domain = toDomain(arg);
    if (!domain) {
      errors.push(`"${arg}" isn't a request number or site`);
      continue;
    }
    if (verb === 'revoke') {
      const req = ctx.state.requests.find((r) => r.domain === domain);
      if (req) targets.push(req);
      else errors.push(`${domain} has no allow to revoke`);
    } else {
      targets.push(findOrCreate(ctx, domain));
    }
  }

  const lines = [...new Set(targets)].map((req) => {
    if (verb === 'revoke' && !isActiveAllow(req, Date.now())) return `#${req.id} ${req.domain} is not currently allowed`;
    return decide(ctx, req, verb, durationMs, from);
  });
  lines.push(...errors);
  if (targets.length) lines.push('', 'The firewall picks this up on its next list refresh (about 5 min).');
  return { reply: lines.join('\n') || 'Nothing to do.', wantsSummary: false };
}

/** Polls Twilio for new commands from allowed numbers and answers them. */
export async function processInbound(ctx: Ctx): Promise<{ wantsSummary: boolean }> {
  const messages = await listInbound(ctx.cfg);
  const seen = new Set(ctx.state.seenSids);
  let wantsSummary = false;

  if (!ctx.state.inboundBaselined) {
    // First run: don't act on chat history that predates the app.
    ctx.state.seenSids = messages.map((m) => m.sid).slice(-MAX_SEEN_SIDS);
    ctx.state.inboundBaselined = true;
    return { wantsSummary };
  }

  const allowed = new Set(ctx.cfg.twilio.to);
  for (const m of messages) {
    if (seen.has(m.sid)) continue;
    seen.add(m.sid);
    ctx.state.seenSids.push(m.sid);
    if (!allowed.has(m.from)) {
      log(ctx, 'command', `Ignored message from unknown number ${m.from}`);
      continue;
    }
    if (Date.now() - m.dateSent > MAX_COMMAND_AGE_MS) continue;
    log(ctx, 'command', `${m.from}: ${m.body.slice(0, 120)}`);
    const result = handleCommand(ctx, m.from, m.body);
    wantsSummary ||= result.wantsSummary;
    await sendWhatsApp(ctx.cfg, m.from, result.reply);
  }
  ctx.state.seenSids = ctx.state.seenSids.slice(-MAX_SEEN_SIDS);
  return { wantsSummary };
}

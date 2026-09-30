// Types shared by the frontend (src/) and the backend endpoints (backend/). Both sides read and
// write the same KV store keys, so the shapes live in one place.

/** KV store keys used by the app. Secrets are written by the Settings page and never read back by the UI. */
export const KV_KEYS = {
  config: 'config',
  state: 'state',
  history: 'history',
  /** base64("AccountSid:AuthToken"), injected as a Basic auth header by config/proxies.yml. */
  twilioBasic: 'twilio_basic',
  /** AWS secret access key, used by the backend to presign S3 uploads. */
  awsSecretKey: 'aws_secret_key',
} as const;

export type AppConfig = {
  device: {
    /** Friendly name used in chat messages, e.g. "Sam's laptop". */
    name: string;
    /** Source IP of the restricted device as it appears in the firewall logs. */
    ip: string;
  };
  search: {
    /** Cribl Search / Lake dataset holding the PA-410 logs. */
    dataset: string;
    /** Field names in the parsed PAN-OS log events. */
    srcField: string;
    urlField: string;
    actionField: string;
    categoryField: string;
    /**
     * Optional full query override. `{ip}` is replaced with the device IP. The query must return
     * rows with the url/action/category fields named above plus a numeric `hits` field.
     */
    customQuery: string;
  };
  summary: {
    /** How often a WhatsApp activity summary is sent, in minutes. */
    intervalMinutes: number;
    /** Only send a summary when there is new blocked traffic (otherwise also send "all quiet" digests). */
    onlyWhenBlocked: boolean;
  };
  twilio: {
    accountSid: string;
    /** WhatsApp-enabled Twilio sender, E.164, e.g. +14155238886. */
    from: string;
    /** Parent/admin numbers that receive summaries and may send commands, E.164. */
    to: string[];
  };
  s3: {
    bucket: string;
    region: string;
    /** Object key prefix. Keep a random segment in it: the firewall reads these objects without auth. */
    prefix: string;
    accessKeyId: string;
  };
  /** Duration applied by a bare "allow 3" command. */
  defaultAllowDuration: string;
};

export type RequestStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'revoked';

export type SiteRequest = {
  id: number;
  domain: string;
  category: string;
  hits: number;
  firstSeen: number;
  lastSeen: number;
  status: RequestStatus;
  decidedAt?: number;
  /** Who made the decision: a WhatsApp number or "app". */
  decidedBy?: string;
  /** Epoch ms when a temporary allow ends; null means allowed permanently. */
  expiresAt?: number | null;
};

export type AppState = {
  nextId: number;
  requests: SiteRequest[];
  lastSummaryAt: number;
  /** Twilio message SIDs already processed (bounded). */
  seenSids: string[];
  /** Set once the first inbound poll has baselined existing messages. */
  inboundBaselined: boolean;
  /** Hash of the last lists uploaded to S3, so unchanged lists aren't re-uploaded. */
  publishedHash: string;
  lastPublishAt: number;
  lastTickAt: number;
  lastError: { at: number; message: string } | null;
};

export type HistoryKind = 'summary' | 'decision' | 'expiry' | 'publish' | 'command' | 'error';

export type HistoryEntry = {
  at: number;
  kind: HistoryKind;
  text: string;
};

/** Body accepted by the `action` backend endpoint. */
export type ActionRequest =
  | { op: 'decide'; id: number; decision: 'allow' | 'deny' | 'revoke'; duration?: string }
  | { op: 'test-message' }
  | { op: 'run-now' }
  | { op: 'publish' };

export type ActionResponse = { ok: true; message: string } | { ok: false; error: string };

export const DEFAULT_CONFIG: AppConfig = {
  device: { name: '', ip: '' },
  search: {
    dataset: 'pan_firewall',
    srcField: 'src_ip',
    urlField: 'url',
    actionField: 'action',
    categoryField: 'category',
    customQuery: '',
  },
  summary: { intervalMinutes: 30, onlyWhenBlocked: true },
  twilio: { accountSid: '', from: '', to: [] },
  s3: { bucket: '', region: 'us-east-1', prefix: '', accessKeyId: '' },
  defaultAllowDuration: '1h',
};

export const EMPTY_STATE: AppState = {
  nextId: 1,
  requests: [],
  lastSummaryAt: 0,
  seenSids: [],
  inboundBaselined: false,
  publishedHash: '',
  lastPublishAt: 0,
  lastTickAt: 0,
  lastError: null,
};

/** Returns the settings still missing before the app can run, as human-readable labels. */
export function missingConfig(c: AppConfig): string[] {
  const missing: string[] = [];
  if (!c.device.ip) missing.push('device IP');
  if (!c.search.dataset) missing.push('dataset');
  if (!c.twilio.accountSid || !c.twilio.from || c.twilio.to.length === 0) missing.push('WhatsApp (Twilio)');
  if (!c.s3.bucket || !c.s3.region || !c.s3.prefix || !c.s3.accessKeyId) missing.push('S3 lists');
  return missing;
}

/** Public URL the PA-410 uses to fetch a list (path-style S3 URL). */
export function edlUrl(c: AppConfig, list: 'allow' | 'block'): string {
  const key = `${c.s3.prefix.replace(/^\/+|\/+$/g, '')}/${list}.txt`;
  return `https://s3.${c.s3.region}.amazonaws.com/${c.s3.bucket}/${key}`;
}

/** Parses "30m", "2h", "1d", "always". Returns ms, null for permanent, or undefined when invalid. */
export function parseDuration(input: string): number | null | undefined {
  const s = input.trim().toLowerCase();
  if (['always', 'forever', 'permanent', 'perm'].includes(s)) return null;
  const m = /^(\d+)\s*(m|min|mins|h|hr|hrs|hour|hours|d|day|days)$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n <= 0) return undefined;
  const unit = m[2][0];
  return n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
}

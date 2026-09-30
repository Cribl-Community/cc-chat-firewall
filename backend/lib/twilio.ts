// Twilio WhatsApp messaging. Authentication is injected by the platform proxy from the KV key
// `twilio_basic` (see config/proxies.yml), so this module never handles the auth token.

import type { AppConfig } from '../../shared/types.js';

const API = 'https://api.twilio.com/2010-04-01';
/** WhatsApp bodies are capped at 1600 characters. */
const MAX_BODY = 1500;

export type InboundMessage = {
  sid: string;
  from: string;
  body: string;
  dateSent: number;
};

type TwilioMessage = {
  sid: string;
  from: string;
  to: string;
  body: string;
  direction: string;
  date_sent: string | null;
  date_created: string;
};

const wa = (n: string) => (n.startsWith('whatsapp:') ? n : `whatsapp:${n}`);

function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** Splits long text on line boundaries so each chunk fits a WhatsApp message. */
export function chunk(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > MAX_BODY) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line.slice(0, MAX_BODY);
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function sendWhatsApp(cfg: AppConfig, to: string, text: string): Promise<void> {
  for (const body of chunk(text)) {
    const res = await fetch(`${API}/Accounts/${cfg.twilio.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ From: wa(cfg.twilio.from), To: wa(to), Body: body }),
    });
    if (!res.ok) {
      throw new Error(`Twilio send to ${to} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }
}

export async function broadcast(cfg: AppConfig, text: string): Promise<void> {
  for (const to of cfg.twilio.to) await sendWhatsApp(cfg, to, text);
}

/** Recent inbound WhatsApp messages sent to our Twilio number, oldest first. */
export async function listInbound(cfg: AppConfig): Promise<InboundMessage[]> {
  const url = `${API}/Accounts/${cfg.twilio.accountSid}/Messages.json?${form({
    To: wa(cfg.twilio.from),
    PageSize: '50',
  })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twilio list failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { messages?: TwilioMessage[] };
  return (data.messages ?? [])
    .filter((m) => m.direction === 'inbound')
    .map((m) => ({
      sid: m.sid,
      from: m.from.replace(/^whatsapp:/, ''),
      body: m.body ?? '',
      dateSent: Date.parse(m.date_sent ?? m.date_created),
    }))
    .sort((a, b) => a.dateSent - b.dateSent);
}

import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  NumberField,
  PasswordField,
  SelectField,
  Switch,
  TabNav,
  Text,
  TextArea,
  TextField,
  Toast,
} from '@capra/core';
import { KV_KEYS, edlUrl, missingConfig, type AppConfig } from '../../shared/types';
import { callAction, kvPut, relativeTime, type AppData } from '../api';
import { PageHeader } from '../components/PageHeader';

type Props = { data: AppData | null; error: string | null; refresh: () => Promise<void> };

const TABS = [
  { key: 'device', name: 'Device & logs', href: '/settings/device' },
  { key: 'whatsapp', name: 'WhatsApp', href: '/settings/whatsapp' },
  { key: 'lists', name: 'Firewall lists', href: '/settings/lists' },
];

const DURATIONS = [
  { id: '30m', label: '30 minutes' },
  { id: '1h', label: '1 hour' },
  { id: '2h', label: '2 hours' },
  { id: '4h', label: '4 hours' },
  { id: '1d', label: '1 day' },
  { id: 'always', label: 'Always (permanent)' },
];

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;
const E164 = /^\+[1-9]\d{6,14}$/;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const FIELD = /^[A-Za-z_][\w.]*$/;

type Secrets = { twilioToken: string; awsSecret: string };

function randomPrefix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `chat-firewall/${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function validate(c: AppConfig, s: Secrets, saved: AppConfig | undefined, hasTwilio: boolean) {
  const e: Partial<Record<string, string>> = {};
  if (c.device.ip && !IPV4.test(c.device.ip) && !(c.device.ip.includes(':') && IPV6.test(c.device.ip))) {
    e.ip = 'Enter an IPv4 or IPv6 address, e.g. 192.168.1.50';
  }
  for (const f of ['srcField', 'urlField', 'actionField', 'categoryField'] as const) {
    if (!FIELD.test(c.search[f])) e[f] = 'Use a field name, e.g. src_ip';
  }
  if (c.search.customQuery && !c.search.customQuery.includes('{ip}')) e.customQuery = 'Include {ip} where the device IP goes';
  if (c.twilio.accountSid && !/^AC[0-9a-f]{32}$/i.test(c.twilio.accountSid)) e.accountSid = 'Account SIDs start with AC and have 34 characters';
  if (c.twilio.from && !E164.test(c.twilio.from)) e.from = 'Use international format, e.g. +14155238886';
  const badTo = c.twilio.to.filter((n) => !E164.test(n));
  if (badTo.length) e.to = `Not in international format: ${badTo.join(', ')}`;
  const sidChanged = saved && saved.twilio.accountSid !== c.twilio.accountSid;
  if (c.twilio.accountSid && !s.twilioToken && (!hasTwilio || sidChanged)) e.twilioToken = 'Enter the auth token for this account';
  if (c.s3.region && !REGION.test(c.s3.region)) e.region = 'Use an AWS region code, e.g. us-east-1';
  if (c.s3.bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.s3.bucket)) e.bucket = 'Not a valid S3 bucket name';
  if (c.s3.accessKeyId && !/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(c.s3.accessKeyId)) e.accessKeyId = 'Access key IDs start with AKIA and have 20 characters';
  return e;
}

export default function Settings(props: Props) {
  if (!props.data) return <PageHeader title="Settings" description="Loading…" />;
  return <SettingsForm data={props.data} refresh={props.refresh} />;
}

function SettingsForm({ data, refresh }: { data: AppData; refresh: () => Promise<void> }) {
  const { tab = 'device' } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState<AppConfig>(() => structuredClone(data.config));
  const [toText, setToText] = useState(() => data.config.twilio.to.join('\n'));
  const [secrets, setSecrets] = useState<Secrets>({ twilioToken: '', awsSecret: '' });
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const reset = () => {
    setForm(structuredClone(data.config));
    setToText(data.config.twilio.to.join('\n'));
    setSecrets({ twilioToken: '', awsSecret: '' });
  };

  const update = (fn: (c: AppConfig) => void) =>
    setForm((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });

  const errors = validate(form, secrets, data.config, data.secrets.twilio);
  const hasErrors = Object.keys(errors).length > 0;
  const dirty =
    JSON.stringify(form) !== JSON.stringify(data.config) || Boolean(secrets.twilioToken || secrets.awsSecret);
  const savedAndReady =
    !dirty && missingConfig(data.config).length === 0 && data.secrets.twilio && data.secrets.aws;

  const field = (key: string, helper?: string) => ({
    appearance: errors[key] ? ('danger' as const) : ('default' as const),
    helperText: errors[key] ?? helper,
  });

  const save = async () => {
    setSaving(true);
    try {
      if (secrets.twilioToken) {
        await kvPut(KV_KEYS.twilioBasic, btoa(`${form.twilio.accountSid}:${secrets.twilioToken}`));
      }
      if (secrets.awsSecret) await kvPut(KV_KEYS.awsSecretKey, secrets.awsSecret);
      await kvPut(KV_KEYS.config, JSON.stringify(form));
      setSecrets({ twilioToken: '', awsSecret: '' });
      await refresh();
      Toast.success('Settings saved');
    } catch (err) {
      Toast.error(`Couldn't save settings: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (op: 'test-message' | 'publish') => {
    setBusy(op);
    const result = await callAction({ op });
    setBusy(null);
    if (result.ok) Toast.success(result.message);
    else Toast.error(result.error);
    void refresh();
  };

  return (
    <>
      <PageHeader
        title="Settings"
        description="Connect the PA-410 logs, WhatsApp, and the S3 lists the firewall reads."
        tabs={<TabNav activeKey={tab} items={TABS} onTabPress={(key) => navigate(`/settings/${key}`)} />}
      />
      <div className="page-grid">
        <div className="span-8 stack-lg">
          {tab === 'device' && (
            <>
              <Section title="Restricted device" text="The device whose web activity is summarized in WhatsApp.">
                <TextField
                  label="Device name"
                  placeholder="Sam's laptop"
                  value={form.device.name}
                  onChange={(v) => update((c) => void (c.device.name = v))}
                  helperText="Used in chat messages."
                />
                <TextField
                  label="Device IP address"
                  required
                  placeholder="192.168.1.50"
                  value={form.device.ip}
                  onChange={(v) => update((c) => void (c.device.ip = v.trim()))}
                  {...field('ip', 'Source IP as it appears in the firewall logs. Give the device a DHCP reservation so it doesn’t change.')}
                />
              </Section>
              <Section
                title="Firewall logs"
                text="Where the PA-410 URL filtering logs land in Cribl. See Documentation for how to send them."
              >
                <TextField
                  label="Dataset"
                  required
                  value={form.search.dataset}
                  onChange={(v) => update((c) => void (c.search.dataset = v.trim()))}
                  helperText="Cribl Search / Lake dataset name."
                />
                <div className="field-grid">
                  <TextField
                    label="Source IP field"
                    value={form.search.srcField}
                    onChange={(v) => update((c) => void (c.search.srcField = v.trim()))}
                    {...field('srcField')}
                  />
                  <TextField
                    label="URL field"
                    value={form.search.urlField}
                    onChange={(v) => update((c) => void (c.search.urlField = v.trim()))}
                    {...field('urlField')}
                  />
                  <TextField
                    label="Action field"
                    value={form.search.actionField}
                    onChange={(v) => update((c) => void (c.search.actionField = v.trim()))}
                    {...field('actionField', 'Values like block-url, deny, or drop count as blocked.')}
                  />
                  <TextField
                    label="Category field"
                    value={form.search.categoryField}
                    onChange={(v) => update((c) => void (c.search.categoryField = v.trim()))}
                    {...field('categoryField')}
                  />
                </div>
                <TextArea
                  label="Custom query (optional)"
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  placeholder={'dataset="pan_firewall" | where src_ip == "{ip}" | summarize hits=count() by url, action, category'}
                  value={form.search.customQuery}
                  onChange={(v) => update((c) => void (c.search.customQuery = v))}
                  {...field(
                    'customQuery',
                    'Overrides the generated query. Must return the URL, action, and category fields above plus a hits count.',
                  )}
                />
              </Section>
            </>
          )}

          {tab === 'whatsapp' && (
            <>
              <Section title="Twilio" text="Summaries are sent from a WhatsApp-enabled Twilio number, and replies are read back every minute.">
                <TextField
                  label="Account SID"
                  required
                  placeholder="AC…"
                  value={form.twilio.accountSid}
                  onChange={(v) => update((c) => void (c.twilio.accountSid = v.trim()))}
                  {...field('accountSid')}
                />
                <PasswordField
                  label="Auth token"
                  required={!data.secrets.twilio}
                  placeholder={data.secrets.twilio ? '••••••••  (saved)' : ''}
                  value={secrets.twilioToken}
                  onChange={(v) => setSecrets((s) => ({ ...s, twilioToken: v.trim() }))}
                  {...field('twilioToken', data.secrets.twilio ? 'Saved. Leave blank to keep the current token.' : undefined)}
                />
                <TextField
                  label="WhatsApp sender number"
                  required
                  placeholder="+14155238886"
                  value={form.twilio.from}
                  onChange={(v) => update((c) => void (c.twilio.from = v.trim()))}
                  {...field('from', 'Your Twilio WhatsApp sender, or the Twilio Sandbox number while testing.')}
                />
                <TextArea
                  label="Chat members"
                  required
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  placeholder="+15551234567"
                  value={toText}
                  onChange={(v) => {
                    setToText(v);
                    update((c) => void (c.twilio.to = v.split(/[\s,]+/).filter(Boolean)));
                  }}
                  {...field('to', 'One number per line. They receive summaries, and only they can allow or deny sites.')}
                />
              </Section>
              <Section title="Summaries" text="How often the chat gets an activity summary.">
                <NumberField
                  label="Summary interval (minutes)"
                  min={5}
                  max={1440}
                  step={5}
                  value={form.summary.intervalMinutes}
                  onChange={(v) => update((c) => void (c.summary.intervalMinutes = Number.isFinite(v) ? v : 30))}
                />
                <div className="switch-row">
                  <Switch
                    aria-labelledby="only-when-blocked"
                    checked={form.summary.onlyWhenBlocked}
                    onChange={(e) => {
                      const checked = e.currentTarget.checked;
                      update((c) => void (c.summary.onlyWhenBlocked = checked));
                    }}
                  />
                  <Text id="only-when-blocked">Only send a summary when there are new blocked sites</Text>
                </div>
                <SelectField
                  label="Default allow time"
                  helperText='Used when someone replies "allow 3" without a time.'
                  items={DURATIONS}
                  value={form.defaultAllowDuration}
                  onChange={(key) => key != null && update((c) => void (c.defaultAllowDuration = String(key)))}
                />
              </Section>
              <div>
                <Button onClick={() => runAction('test-message')} pending={busy === 'test-message'} disabled={!savedAndReady}>
                  Send test message
                </Button>
              </div>
            </>
          )}

          {tab === 'lists' && (
            <>
              <Section
                title="S3 bucket"
                text="The app writes allow.txt and block.txt here, and the PA-410 downloads them as External Dynamic Lists."
              >
                <TextField
                  label="Bucket"
                  required
                  value={form.s3.bucket}
                  onChange={(v) => update((c) => void (c.s3.bucket = v.trim()))}
                  {...field('bucket')}
                />
                <TextField
                  label="Region"
                  required
                  value={form.s3.region}
                  onChange={(v) => update((c) => void (c.s3.region = v.trim()))}
                  {...field(
                    'region',
                    form.s3.region === 'us-east-1'
                      ? undefined
                      : `The app's config/proxies.yml must allow s3.${form.s3.region}.amazonaws.com. Ask your app developer to update it.`,
                  )}
                />
                <div className="inline-field">
                  <TextField
                    label="Object prefix"
                    required
                    value={form.s3.prefix}
                    onChange={(v) => update((c) => void (c.s3.prefix = v.trim()))}
                    helperText="Keep the random part: the firewall reads these objects without signing in."
                  />
                  <Button variant="tertiary" onClick={() => update((c) => void (c.s3.prefix = randomPrefix()))}>
                    Generate
                  </Button>
                </div>
                <TextField
                  label="Access key ID"
                  required
                  value={form.s3.accessKeyId}
                  onChange={(v) => update((c) => void (c.s3.accessKeyId = v.trim()))}
                  {...field('accessKeyId', 'An IAM user allowed only s3:PutObject on this prefix.')}
                />
                <PasswordField
                  label="Secret access key"
                  required={!data.secrets.aws}
                  placeholder={data.secrets.aws ? '••••••••  (saved)' : ''}
                  value={secrets.awsSecret}
                  onChange={(v) => setSecrets((s) => ({ ...s, awsSecret: v.trim() }))}
                  helperText={data.secrets.aws ? 'Saved. Leave blank to keep the current key.' : undefined}
                />
              </Section>
              {form.s3.bucket && form.s3.prefix && (
                <Section title="PA-410 External Dynamic Lists" text="Create two URL List EDLs on the firewall with these sources.">
                  <TextField label="Allow list URL" value={edlUrl(form, 'allow')} readOnly />
                  <TextField label="Block list URL" value={edlUrl(form, 'block')} readOnly />
                  <Text as="p" color="subtle">
                    {data.state.lastPublishAt
                      ? `Last uploaded ${relativeTime(data.state.lastPublishAt)}.`
                      : 'Not uploaded yet.'}
                  </Text>
                </Section>
              )}
              <div>
                <Button onClick={() => runAction('publish')} pending={busy === 'publish'} disabled={!savedAndReady}>
                  Publish lists now
                </Button>
              </div>
            </>
          )}

          {dirty && hasErrors && (
            <Alert appearance="warning" layout="inline">
              Fix the highlighted fields before saving.
            </Alert>
          )}
          <div className="form-footer">
            <Button variant="secondary" onClick={reset} disabled={!dirty || saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} pending={saving} disabled={!dirty || hasErrors}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function Section({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <section className="stack">
      <div>
        <Text as="h2" variant="heading-sm">
          {title}
        </Text>
        <Text as="p" color="subtle">
          {text}
        </Text>
      </div>
      {children}
    </section>
  );
}

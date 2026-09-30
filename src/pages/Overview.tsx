import { useMemo, useState } from 'react';
import { Alert, Button, Card, EmptyState, SelectField, Table, Tag, Text, Toast, defineColumns } from '@capra/core';
import type { TagColor } from '@capra/core';
import { missingConfig, type RequestStatus, type SiteRequest } from '../../shared/types';
import { callAction, dateTime, relativeTime, useHostTheme, useNow, type AppData } from '../api';
import { PageHeader } from '../components/PageHeader';
import { SetupNotice } from '../components/SetupNotice';
import { DecisionModal, type PendingDecision } from '../components/DecisionModal';

type Props = { data: AppData | null; error: string | null; refresh: () => Promise<void> };

const STATUS: Record<RequestStatus, { label: string; color: TagColor }> = {
  pending: { label: 'Needs decision', color: 'warning' },
  allowed: { label: 'Allowed', color: 'success' },
  denied: { label: 'Denied', color: 'danger' },
  expired: { label: 'Expired', color: 'default' },
  revoked: { label: 'Revoked', color: 'default' },
};

const FILTERS = [
  { id: 'pending', label: 'Needs decision' },
  { id: 'allowed', label: 'Allowed' },
  { id: 'denied', label: 'Denied' },
  { id: 'all', label: 'All sites' },
];

/** Table row: a request plus display-only values. Capra renders empty cells as "--" itself. */
type Row = SiteRequest & { accessEnds: string };

const columns = defineColumns<Row>([
  { id: 'id', label: '#', allowsSorting: true, render: (v) => `#${v}` },
  { id: 'domain', label: 'Site', allowsSorting: true },
  { id: 'category', label: 'Category', allowsSorting: true },
  { id: 'hits', label: 'Blocked tries', allowsSorting: true },
  {
    id: 'status',
    label: 'Status',
    allowsSorting: true,
    render: (v) => {
      const s = STATUS[v as RequestStatus];
      return (
        <Tag color={s.color} size="sm">
          {s.label}
        </Tag>
      );
    },
  },
  { id: 'accessEnds', label: 'Access ends' },
  { id: 'lastSeen', label: 'Last seen', allowsSorting: true, render: (v) => dateTime(v as number) },
]);

type SortDescriptor = { column: string | number; direction: 'ascending' | 'descending' };

export default function Overview({ data, error, refresh }: Props) {
  const theme = useHostTheme();
  const [filter, setFilter] = useState('pending');
  const [sort, setSort] = useState<SortDescriptor>({ column: 'domain', direction: 'ascending' });
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [running, setRunning] = useState(false);

  const requests = useMemo(() => data?.state.requests ?? [], [data]);
  const now = useNow();
  const counts = useMemo(
    () => ({
      pending: requests.filter((r) => r.status === 'pending').length,
      allowed: requests.filter((r) => r.status === 'allowed' && (r.expiresAt == null || r.expiresAt > now)).length,
      denied: requests.filter((r) => r.status === 'denied').length,
    }),
    [requests, now],
  );

  const rows = useMemo((): Row[] => {
    const filtered = (filter === 'all' ? requests : requests.filter((r) => r.status === filter)).map((r) => ({
      ...r,
      accessEnds: r.status !== 'allowed' ? '' : r.expiresAt == null ? 'Never' : relativeTime(r.expiresAt, now),
    }));
    const key = sort.column as keyof SiteRequest;
    const dir = sort.direction === 'ascending' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[key] ?? '';
      const bv = b[key] ?? '';
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
  }, [requests, filter, sort, now]);

  const configured = data ? missingConfig(data.config).length === 0 && data.secrets.twilio && data.secrets.aws : false;
  const lastError = data?.state.lastError;
  const showError = lastError && now - lastError.at < 3_600_000;

  const runNow = async () => {
    setRunning(true);
    const result = await callAction({ op: 'run-now' });
    setRunning(false);
    if (result.ok) Toast.success(result.message);
    else Toast.error(`Check failed: ${result.error}`);
    void refresh();
  };

  const renderActions = (req: SiteRequest) => {
    const open = (decision: PendingDecision['decision']) => () => setPending({ req, decision });
    const active = req.status === 'allowed' && (req.expiresAt == null || req.expiresAt > now);
    return (
      <div className="row-actions">
        {active ? (
          <>
            <Button size="sm" onClick={open('allow')}>
              Extend
            </Button>
            <Button size="sm" variant="tertiary" onClick={open('revoke')}>
              Revoke
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" onClick={open('allow')}>
              Allow
            </Button>
            {req.status !== 'denied' && (
              <Button size="sm" variant="tertiary" appearance="danger" onClick={open('deny')}>
                Deny
              </Button>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          data?.config.device.name || data?.config.device.ip
            ? `Blocked sites requested by ${data.config.device.name || data.config.device.ip}, and your decisions from WhatsApp or here.`
            : 'Blocked sites requested by the restricted device, and your decisions from WhatsApp or here.'
        }
        actions={
          <Button variant="primary" onClick={runNow} pending={running} disabled={!configured}>
            Check now
          </Button>
        }
      />
      <div className="page-grid">
        {error && (
          <div className="span-12">
            <Alert appearance="danger" title="Couldn't load app data">
              {error}
            </Alert>
          </div>
        )}
        {data && !configured && (
          <div className="span-12">
            <SetupNotice config={data.config} secrets={data.secrets} />
          </div>
        )}
        {showError && (
          <div className="span-12">
            <Alert appearance="warning" title={`Last problem ${relativeTime(lastError.at)}`} onDismiss>
              {lastError.message}
            </Alert>
          </div>
        )}

        <Metric label="Needs decision" value={counts.pending} />
        <Metric label="Allowed now" value={counts.allowed} />
        <Metric label="Denied" value={counts.denied} />
        <Metric
          label="Last summary"
          value={data ? relativeTime(data.state.lastSummaryAt) : '—'}
          note={data?.state.lastTickAt ? `Last check ${relativeTime(data.state.lastTickAt)}` : 'Not run yet'}
        />

        <div className="span-12 stack">
          <div className="toolbar">
            <Text as="h2" variant="heading-sm">
              Site requests
            </Text>
            <div className="toolbar-filter">
              <SelectField
                aria-label="Show"
                size="sm"
                items={FILTERS}
                value={filter}
                onChange={(key) => key != null && setFilter(String(key))}
              />
            </div>
          </div>
          {data && rows.length === 0 ? (
            <EmptyState
              theme={theme}
              illustration={filter === 'pending' ? 'Celebration' : 'EmptyFolder'}
              title={filter === 'pending' ? 'Nothing waiting for a decision' : 'No sites here yet'}
              description={
                filter === 'pending'
                  ? 'When the device tries a blocked site, it shows up here and in the WhatsApp summary.'
                  : 'Sites appear here after the device requests them and a decision is made.'
              }
            />
          ) : (
            <Table
              aria-label="Site requests"
              columns={columns}
              visibleColumns={['id', 'domain', 'category', 'hits', 'status', 'accessEnds', 'lastSeen']}
              items={rows}
              isLoading={!data}
              sortDescriptor={sort}
              onSortChange={(d) => setSort(d as SortDescriptor)}
              // Capra drops action cells while loading but keeps the header, so only pass it with data.
              renderActionColumn={data ? renderActions : undefined}
            />
          )}
        </div>
      </div>
      <DecisionModal
        key={pending ? `${pending.req.id}-${pending.decision}` : 'none'}
        pending={pending}
        defaultDuration={data?.config.defaultAllowDuration ?? '1h'}
        onClose={() => setPending(null)}
        onDone={() => {
          setPending(null);
          void refresh();
        }}
      />
    </>
  );
}

function Metric({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return (
    <div className="span-3">
      <Card>
        <Card.Content>
          <div className="metric">
            <Text color="subtle">{label}</Text>
            <Text variant="metric-md">{String(value)}</Text>
            {note && (
              <Text variant="body-xs-normal" color="subtle">
                {note}
              </Text>
            )}
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}

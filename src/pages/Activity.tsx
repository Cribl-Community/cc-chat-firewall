import { useMemo, useState } from 'react';
import { EmptyState, SelectField, Table, Tag, defineColumns } from '@capra/core';
import type { TagColor } from '@capra/core';
import { missingConfig, type HistoryEntry, type HistoryKind } from '../../shared/types';
import { dateTime, useHostTheme, type AppData } from '../api';
import { PageHeader } from '../components/PageHeader';
import { SetupNotice } from '../components/SetupNotice';

type Props = { data: AppData | null; error: string | null; refresh: () => Promise<void> };

const KINDS: Record<HistoryKind, { label: string; color: TagColor }> = {
  summary: { label: 'Summary', color: 'info' },
  decision: { label: 'Decision', color: 'accent' },
  expiry: { label: 'Expiry', color: 'default' },
  publish: { label: 'Firewall lists', color: 'success' },
  command: { label: 'Chat', color: 'highlight' },
  error: { label: 'Problem', color: 'danger' },
};

type Row = HistoryEntry & { id: number };

const columns = defineColumns<Row>([
  { id: 'at', label: 'Time', allowsSorting: true, render: (v) => dateTime(v as number) },
  {
    id: 'kind',
    label: 'Type',
    render: (v) => {
      const k = KINDS[v as HistoryKind] ?? KINDS.summary;
      return (
        <Tag color={k.color} size="sm">
          {k.label}
        </Tag>
      );
    },
  },
  { id: 'text', label: 'Details' },
]);

const FILTERS = [{ id: 'all', label: 'All types' }, ...Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label }))];

type SortDescriptor = { column: string | number; direction: 'ascending' | 'descending' };

export default function Activity({ data }: Props) {
  const theme = useHostTheme();
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<SortDescriptor>({ column: 'at', direction: 'descending' });

  const rows = useMemo(() => {
    const all = (data?.history ?? []).map((h, i) => ({ ...h, id: i }));
    const filtered = filter === 'all' ? all : all.filter((h) => h.kind === filter);
    return filtered.sort((a, b) => (sort.direction === 'ascending' ? a.at - b.at : b.at - a.at));
  }, [data, filter, sort]);

  return (
    <>
      <PageHeader
        title="Activity"
        description="Summaries sent, chat commands, decisions, expiries, and firewall list updates."
        actions={
          <SelectField
            aria-label="Type"
            size="sm"
            items={FILTERS}
            value={filter}
            onChange={(key) => key != null && setFilter(String(key))}
          />
        }
      />
      <div className="page-grid">
        {data && missingConfig(data.config).length > 0 && (
          <div className="span-12">
            <SetupNotice config={data.config} secrets={data.secrets} />
          </div>
        )}
        <div className="span-12">
          {data && rows.length === 0 ? (
            <EmptyState
              theme={theme}
              illustration="Hibernating"
              title="No activity yet"
              description="Once setup is complete, the app checks every minute and records what it does here."
            />
          ) : (
            <Table
              aria-label="Activity history"
              columns={columns}
              visibleColumns={['at', 'kind', 'text']}
              items={rows}
              isLoading={!data}
              sortDescriptor={sort}
              onSortChange={(d) => setSort(d as SortDescriptor)}
            />
          )}
        </div>
      </div>
    </>
  );
}

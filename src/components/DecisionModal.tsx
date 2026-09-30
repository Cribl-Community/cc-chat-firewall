import { useState } from 'react';
import { Modal, SelectField, Text, Toast } from '@capra/core';
import type { SiteRequest } from '../../shared/types';
import { callAction } from '../api';

export type PendingDecision = { req: SiteRequest; decision: 'allow' | 'deny' | 'revoke' };

const DURATIONS = [
  { id: '30m', label: '30 minutes' },
  { id: '1h', label: '1 hour' },
  { id: '2h', label: '2 hours' },
  { id: '4h', label: '4 hours' },
  { id: '1d', label: '1 day' },
  { id: 'always', label: 'Always (permanent)' },
];

type Props = {
  pending: PendingDecision | null;
  defaultDuration: string;
  onClose: () => void;
  onDone: () => void;
};

/** Confirms an allow/deny/revoke before it changes the firewall lists. */
export function DecisionModal({ pending, defaultDuration, onClose, onDone }: Props) {
  const [duration, setDuration] = useState<string>(defaultDuration);
  if (!pending) return null;
  const { req, decision } = pending;

  const title = { allow: `Allow ${req.domain}?`, deny: `Deny ${req.domain}?`, revoke: `Revoke access to ${req.domain}?` }[decision];
  const confirm = { allow: 'Allow site', deny: 'Deny site', revoke: 'Revoke access' }[decision];
  const description = {
    allow: `${req.domain} and its subdomains will be added to the firewall's allow list for the restricted device.`,
    deny: `${req.domain} will be added to the firewall's block list and won't be offered for approval again.`,
    revoke: `${req.domain} will be removed from the firewall's allow list and blocked again.`,
  }[decision];

  const submit = async () => {
    const result = await callAction({ op: 'decide', id: req.id, decision, duration });
    if (result.ok) {
      Toast.success(result.message);
      onDone();
    } else {
      Toast.error(`Couldn't update ${req.domain}: ${result.error}`);
    }
  };

  return (
    <Modal
      isOpen
      onIsOpenChange={(open) => !open && onClose()}
      onClose={onClose}
      title={title}
      confirmButtonText={confirm}
      onConfirm={submit}
      size="sm"
    >
      <div className="stack">
        <Text as="p">{description}</Text>
        {decision === 'allow' && (
          <SelectField
            label="Allow for"
            items={DURATIONS}
            value={duration}
            onChange={(key) => key != null && setDuration(String(key))}
          />
        )}
        <Text as="p" color="subtle">
          The lists are uploaded to S3 now. The PA-410 applies them on its next External Dynamic List refresh, and
          the WhatsApp chat is notified.
        </Text>
      </div>
    </Modal>
  );
}

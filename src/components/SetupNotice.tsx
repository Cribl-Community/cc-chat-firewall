import { useNavigate } from 'react-router-dom';
import { Alert } from '@capra/core';
import { missingConfig, type AppConfig } from '../../shared/types';

type Props = {
  config: AppConfig;
  secrets: { twilio: boolean; aws: boolean };
};

/** Directs the user to Settings while required setup is missing. Shown on every page that needs it. */
export function SetupNotice({ config, secrets }: Props) {
  const navigate = useNavigate();
  const missing = missingConfig(config);
  if (!secrets.twilio) missing.push('Twilio auth token');
  if (!secrets.aws) missing.push('AWS secret key');
  if (missing.length === 0) return null;

  return (
    <Alert
      appearance="warning"
      title="Finish setup to start monitoring"
      action={{ label: 'Go to Settings', onClick: () => navigate('/settings') }}
    >
      {`Chat Firewall can't run until these are set: ${missing.join(', ')}.`}
    </Alert>
  );
}

import type { ReactNode } from 'react';
import { Card, Table, Text, defineColumns } from '@capra/core';
import { PageHeader } from '../components/PageHeader';

type Command = { id: string; example: string; does: string };

const commands: Command[] = [
  { id: '1', example: 'allow 3', does: 'Allow request #3 for the default time set in Settings' },
  { id: '2', example: 'allow 3 2h', does: 'Allow #3 for 2 hours (use m, h, or d: 30m, 4h, 1d)' },
  { id: '3', example: 'allow 3 always', does: 'Allow #3 permanently' },
  { id: '4', example: 'allow 3,4 1h', does: 'Allow several requests at once. "allow all 1h" allows everything pending' },
  { id: '5', example: 'allow example.com 1h', does: 'Allow a site by name, even one the device hasn’t asked for yet' },
  { id: '6', example: 'deny 3', does: 'Keep #3 blocked and stop asking about it' },
  { id: '7', example: 'revoke 3', does: 'End an allow early' },
  { id: '8', example: 'status', does: 'List pending requests, active allows, and denied sites' },
  { id: '9', example: 'summary', does: 'Send an activity summary now' },
  { id: '10', example: 'help', does: 'Show the command list' },
];

const commandColumns = defineColumns<Command>([
  { id: 'example', label: 'Message' },
  { id: 'does', label: 'What it does' },
]);

export default function Documentation() {
  return (
    <>
      <PageHeader title="Documentation" description="How Chat Firewall works and how to connect the PA-410, WhatsApp, and S3." />
      <div className="page-grid">
        <div className="span-8 stack-lg">
          <Doc title="How it works">
            <Steps
              items={[
                'The PA-410 sends its URL filtering logs to Cribl, where they land in a Cribl Lake dataset.',
                'Every minute, the app reads new WhatsApp replies and applies any allow or deny commands.',
                'At the summary interval, it searches the logs for the restricted device and sends the chat its top sites plus a numbered list of blocked sites.',
                'Decisions update allow.txt and block.txt in S3. The PA-410 downloads them as External Dynamic Lists, so changes apply within about 5 minutes.',
                'When a temporary allow ends, the site is removed from the allow list and the chat is told.',
              ]}
            />
          </Doc>

          <Doc title="1. Send PA-410 logs to Cribl">
            <Steps
              items={[
                'In Cribl Stream on Cribl.Cloud, enable a Syslog source with TLS and note its address and port (for example, 6514).',
                'On the PA-410, go to Device > Server Profiles > Syslog and add that address with Transport SSL and Format IETF.',
                'Go to Objects > Log Forwarding, create a profile that forwards URL (and Traffic) logs to the syslog server profile, and attach it to the security rule for the restricted device.',
                'In Stream, route these events through the Palo Alto Networks pack (or your own parser) to a Cribl Lake dataset.',
                'In Cribl Search, run a query on the dataset and check the field names for source IP, URL, action, and category. Enter them on Settings > Device & logs.',
              ]}
            />
            <Text as="p" color="subtle">
              Tip: to see allowed sites in summaries, set allowed URL categories to "alert" instead of "allow" in the URL filtering
              profile. The PA-410 only logs URL requests for categories set to alert, block, continue, or override.
            </Text>
          </Doc>

          <Doc title="2. Create the S3 bucket and IAM user">
            <Steps
              items={[
                'Create an S3 bucket (or reuse one). Settings > Firewall lists shows the object prefix. Keep its random part.',
                'Add a bucket policy that allows public s3:GetObject on arn:aws:s3:::<bucket>/<prefix>/* only, so the firewall can download the lists.',
                'Create an IAM user whose only permission is s3:PutObject on the same prefix. Enter its access key on Settings > Firewall lists.',
                'If the bucket isn’t in us-east-1, add s3.<region>.amazonaws.com to config/proxies.yml and repackage the app.',
                'Click "Publish lists now" to upload the first (empty) lists.',
              ]}
            />
          </Doc>

          <Doc title="3. Configure the PA-410 to use the lists">
            <Steps
              items={[
                'Objects > External Dynamic Lists > Add. Type: URL List. Source: the allow list URL from Settings. Check for updates: Five Minute. Name it chat-fw-allow.',
                'Add a second URL List named chat-fw-block with the block list URL.',
                'Objects > Security Profiles > URL Filtering: in the restricted device’s profile, set chat-fw-allow to Allow and chat-fw-block to Block. Keep your other category blocks.',
                'Make sure the security rule for the device’s IP uses this profile, then Commit.',
                'Under the EDL, use "Test Source URL" to confirm the firewall can reach S3.',
              ]}
            />
          </Doc>

          <Doc title="4. Set up WhatsApp with Twilio">
            <Steps
              items={[
                'Create a Twilio account and either register a WhatsApp sender or turn on the WhatsApp Sandbox for testing.',
                'With the Sandbox, each chat member must first send the "join <code>" message Twilio shows to the Sandbox number.',
                'Enter the Account SID, auth token, sender number, and chat member numbers on Settings > WhatsApp.',
                'Click "Send test message" and reply "help" to confirm replies are received. The app reads replies once a minute.',
              ]}
            />
            <Text as="p" color="subtle">
              Only numbers listed as chat members can allow or deny sites. Messages from any other number are ignored.
            </Text>
          </Doc>

          <Doc title="Chat commands">
            <Table aria-label="Chat commands" columns={commandColumns} visibleColumns={['example', 'does']} items={commands} density="compact" />
          </Doc>
        </div>
      </div>
    </>
  );
}

function Doc({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <Card.Header>
        <Card.Title>{title}</Card.Title>
      </Card.Header>
      <Card.Content>
        <div className="stack">{children}</div>
      </Card.Content>
    </Card>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="steps">
      {items.map((text) => (
        <li key={text}>
          <Text>{text}</Text>
        </li>
      ))}
    </ol>
  );
}

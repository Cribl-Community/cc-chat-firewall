# Chat Firewall

Monitor a restricted device behind a Palo Alto Networks firewall from a WhatsApp chat, and allow or deny blocked sites by replying.

## Summary

Chat Firewall is a Cribl app for supervising a restricted device, such as a child's laptop or a kiosk, behind a Palo Alto Networks PA-410. It summarizes the device's web activity in a WhatsApp chat, lists the sites the firewall blocked, and lets chat members allow or deny each one with a short reply.

## What This App Does

* Primary purpose: turn firewall URL logs into a WhatsApp conversation that parents or admins can act on.
* Key capabilities:
  * Periodic WhatsApp summaries of the device's top sites and blocked requests, each blocked site numbered
  * Chat commands: `allow 3 1h`, `allow 3 always`, `deny 3`, `revoke 3`, `status`, `summary`, `help`
  * Temporary allows that expire automatically, with a message when access ends
  * Allow and block lists published to S3 and applied by the PA-410 as External Dynamic Lists
  * An in-app overview of requests, decisions, and activity history, with the same allow/deny actions
* Intended users: home or small-office admins, parents, IT staff
* Works with: Cribl.Cloud, Cribl Search, Cribl Lake, Cribl Stream

## When To Use This App

* Approve or refuse blocked sites for a supervised device without logging in to the firewall
* Give short, time-boxed access to a site (for example, one hour for homework research)
* Keep a record of what was requested, who decided, and when

## Before You Install

* Cribl.Cloud with Cribl Search, and PA-410 URL filtering logs flowing into a Cribl Lake dataset
* A Palo Alto Networks firewall that supports URL List External Dynamic Lists (PAN-OS 9.0+)
* A Twilio account with a WhatsApp sender (or the WhatsApp Sandbox for testing)
* An AWS S3 bucket, and an IAM user limited to `s3:PutObject` on the app's prefix
* The bucket's region must be declared in `config/proxies.yml` (the default is `us-east-1`)

## Installation

1. Go to Apps in your Cribl environment.
2. Install from the Marketplace, or import the `.tgz` package from file or URL.
3. Open the app and complete Settings.

## Configuration

| Setting | Required | Description | Example | Scope |
|---|---|---|---|---|
| Device IP address | Yes | Source IP of the restricted device in the firewall logs | 192.168.1.50 | shared |
| Device name | No | Name used in chat messages | Sam's laptop | shared |
| Dataset | Yes | Cribl Lake dataset with the PA-410 logs | pan_firewall | shared |
| Log field names | Yes | Source IP, URL, action, and category fields | src_ip, url, action, category | shared |
| Twilio Account SID and auth token | Yes | Twilio credentials. The token is stored in the app's KV store | AC… | shared |
| WhatsApp sender number | Yes | Twilio WhatsApp sender | +14155238886 | shared |
| Chat members | Yes | Numbers that receive summaries and may send commands | +15551234567 | shared |
| Summary interval | Yes | Minutes between summaries | 30 | shared |
| Default allow time | Yes | Duration for "allow 3" with no time | 1 hour | shared |
| S3 bucket, region, prefix, access key | Yes | Where the allow and block lists are written | my-bucket, us-east-1 | shared |

## How To Use

### Typical Workflow
1. When the device tries a blocked site, the next summary lists it with a number, for example `#3 tiktok.com`.
2. A chat member replies `allow 3 1h`, `allow 3 always`, or `deny 3`.
3. The app confirms in the chat and updates the S3 lists. The PA-410 applies them on its next list refresh (every 5 minutes).
4. Temporary allows expire automatically, and the chat is told.

### First-Run Checklist
* Complete Settings > Device & logs, WhatsApp, and Firewall lists
* Click "Send test message" and reply `help`
* Click "Publish lists now", then add both list URLs as URL List EDLs on the PA-410 and use them in the device's URL filtering profile

## Permissions

### Cribl API Endpoints Used

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/v1/m/default_search/search/jobs` | Search the firewall logs for the device's activity |
| GET | `/api/v1/m/default_search/search/jobs/{id}/results` | Read search results |
| GET/PUT | `/api/v1/a/{appId}/kvstore/*` | Store settings, request state, and history (app-scoped) |

## External API Access

### Default Configuration
* `default/proxies.yml`: `api.twilio.com`, with auth injected from the app's KV store, and `s3.us-east-1.amazonaws.com`
* `default/policies.yml`: Cribl Search job create and read
* `default/schedules.yml`: runs the `tick` endpoint every minute

### External Endpoints
* Twilio: sends WhatsApp messages and reads replies
* Amazon S3: uploads the allow and block lists with presigned requests

## Data And Storage

* KV keys: `config` (settings), `state` (requests and decisions), `history` (last 300 events), `twilio_basic` and `aws_secret_key` (credentials)
* The lists in S3 contain only domain names. The firewall reads them without auth, so the object prefix includes a random segment

## Support

### Community Built
This app is a community contribution with no official Cribl support commitment. Contact the maintainer at lordahli@gmail.com.

## Known Limitations

* Replies are read once a minute, and the firewall refreshes lists every 5 minutes, so a decision can take up to about 6 minutes to apply
* Allowing a site allows it and its subdomains. Sites that load content from other domains may need those allowed too
* Only one restricted device per app installation

## Troubleshooting

### No summaries arrive
Check the Activity page for problems, confirm the dataset and field names in Cribl Search, and use "Send test message".

### Replies are ignored
Only numbers listed as chat members are accepted. With the Twilio Sandbox, each member must first join the Sandbox.

### Decisions don't take effect
Use "Test Source URL" on the PA-410 EDL, confirm the bucket policy allows public reads on the prefix, and check that the EDLs are in the device's URL filtering profile.

## Development

```bash
npm install
npm run dev
npm run package
```

## App Metadata

| Field | Value |
|---|---|
| App Name | Chat Firewall |
| App ID | la-chat-firewall |
| Version | 1.0.0 |
| Author | lordahli |
| Support Model | community-built |
| Support Label | Community Built |
| Support Contact | lordahli@gmail.com |
| License | See LICENSE |
| Product Tags | search, lake, stream |
| Category | Security |
| Audience | admin |
| Availability | preview |
| Requires External Access | yes |
| README Schema Version | 1.0 |

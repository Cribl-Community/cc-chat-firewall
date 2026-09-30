// Called by the app UI for user-initiated operations: decide on a request, send a test message,
// run a check now, or force a list publish.

import { parseDuration, type ActionRequest, type ActionResponse } from '../shared/types.js';
import {
  assertConfigured,
  decide,
  expireAllows,
  load,
  processInbound,
  publishLists,
  recordError,
  runSummary,
  save,
  type Ctx,
} from './lib/engine.js';
import { broadcast } from './lib/twilio.js';

export async function onRequest(request: Request, context: { appId: string }): Promise<Response> {
  let body: ActionRequest;
  try {
    body = (await request.json()) as ActionRequest;
  } catch {
    return reply({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const ctx = await load(context.appId);
  try {
    assertConfigured(ctx);
    const message = await run(ctx, body);
    await save(ctx);
    return reply({ ok: true, message });
  } catch (err) {
    recordError(ctx, `Action ${body.op}`, err);
    await save(ctx).catch(() => undefined);
    return reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function run(ctx: Ctx, body: ActionRequest): Promise<string> {
  switch (body.op) {
    case 'decide': {
      const req = ctx.state.requests.find((r) => r.id === body.id);
      if (!req) throw new Error(`Request #${body.id} not found`);
      let durationMs: number | null = null;
      if (body.decision === 'allow') {
        const parsed = parseDuration(body.duration ?? ctx.cfg.defaultAllowDuration);
        if (parsed === undefined) throw new Error(`Invalid duration "${body.duration}"`);
        durationMs = parsed;
      }
      const text = decide(ctx, req, body.decision, durationMs, 'Cribl app');
      await publishLists(ctx);
      await broadcast(ctx.cfg, `${text} (from the Cribl app)`).catch((err) => recordError(ctx, 'WhatsApp notice', err));
      return `${text.replace(/^\S+\s/, '')}. Lists published; the firewall applies them on its next refresh.`;
    }
    case 'test-message':
      await broadcast(ctx.cfg, '👋 Chat Firewall is connected. Send *help* to see the commands.');
      return `Test message sent to ${ctx.cfg.twilio.to.join(', ')}`;
    case 'run-now': {
      await processInbound(ctx);
      const expired = expireAllows(ctx);
      if (expired.length) await broadcast(ctx.cfg, expired.join('\n'));
      await runSummary(ctx, true);
      await publishLists(ctx);
      return 'Checked the firewall logs and sent a summary';
    }
    case 'publish':
      await publishLists(ctx, true);
      return 'Allow and block lists uploaded to S3';
    default:
      throw new Error('Unknown operation');
  }
}

function reply(body: ActionResponse, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

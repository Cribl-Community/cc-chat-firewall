// Scheduled every minute (config/schedules.yml). Each run:
//   1. answers new WhatsApp commands,
//   2. expires temporary allows,
//   3. sends an activity summary when one is due,
//   4. re-publishes the PA-410 allow/block lists to S3 if they changed.
// Each stage is isolated so one failing service doesn't stop the others.

import { assertConfigured, expireAllows, load, processInbound, publishLists, recordError, runSummary, save } from './lib/engine.js';
import { broadcast } from './lib/twilio.js';

export async function onRequest(_request: Request, context: { appId: string }): Promise<Response> {
  const ctx = await load(context.appId);
  try {
    assertConfigured(ctx);
  } catch (err) {
    return json({ ok: false, skipped: err instanceof Error ? err.message : String(err) });
  }

  let wantsSummary = false;
  try {
    wantsSummary = (await processInbound(ctx)).wantsSummary;
  } catch (err) {
    recordError(ctx, 'WhatsApp inbound', err);
  }

  try {
    const expired = expireAllows(ctx);
    if (expired.length) await broadcast(ctx.cfg, expired.join('\n'));
  } catch (err) {
    recordError(ctx, 'Expiry notice', err);
  }

  const due = Date.now() - ctx.state.lastSummaryAt >= ctx.cfg.summary.intervalMinutes * 60_000;
  if (due || wantsSummary) {
    try {
      await runSummary(ctx, wantsSummary);
    } catch (err) {
      // Don't retry every minute on a persistent failure; try again next interval.
      ctx.state.lastSummaryAt = Date.now();
      recordError(ctx, 'Summary', err);
    }
  }

  try {
    await publishLists(ctx);
  } catch (err) {
    recordError(ctx, 'S3 publish', err);
  }

  ctx.state.lastTickAt = Date.now();
  await save(ctx);
  return json({ ok: true });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

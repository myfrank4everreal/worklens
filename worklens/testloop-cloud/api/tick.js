// cron-job.org calls this once a day at 20:00 UTC (21:00 WAT): the nightly strikes/reminders pass.
// nightly() itself refuses to run twice on the same day.
import { load, save, getKv } from '../lib/store.js';
import { nightly } from '../lib/core.js';
import { json, authed } from '../lib/http.js';

export default async function handler(req, res) {
  if (!authed(req, 'CRON_SECRET')) return json(res, 401, { error: 'unauthorized' });
  if (new Date().getUTCHours() < 20 && req.query.force !== '1') return json(res, 200, { ok: true, skipped: 'before 20:00 UTC' });
  await load(); await nightly(); await save();
  return json(res, 200, { ok: true, ran: getKv('nightly_ran') });
}

// Cloudflare Worker entry: the /api routes (static files for the app are
// served by Workers assets, see wrangler.jsonc) plus the 6-hourly cron that
// syncs openfootball and settles finished matches.

import { LEAGUE_IDS, handle } from './api'
import type { Env } from './db'
import { sync, type Fetcher } from './settle'

// Wrapped so callers can hold it as a method (this.fetcher(...)): workerd
// throws "Illegal invocation" when the global fetch is called with any other
// `this`.
const fetcher: Fetcher = (url, init) => fetch(url, init)

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env, Date.now(), fetcher)
  },

  async scheduled(controller: { scheduledTime: number }, env: Env): Promise<void> {
    const report = await sync(env.DB, controller.scheduledTime, fetcher, LEAGUE_IDS)
    console.log(JSON.stringify({ cron: new Date(controller.scheduledTime).toISOString(), ...report }))
  },
}

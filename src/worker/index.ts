// Cloudflare Worker entry: the HTTP API plus the 6-hourly cron that syncs
// openfootball and settles finished matches.

import { LEAGUE_IDS, handle } from './api'
import type { Env } from './db'
import { sync } from './settle'

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env, Date.now(), fetch)
  },

  async scheduled(controller: { scheduledTime: number }, env: Env): Promise<void> {
    const report = await sync(env.DB, controller.scheduledTime, fetch, LEAGUE_IDS)
    console.log(JSON.stringify({ cron: new Date(controller.scheduledTime).toISOString(), ...report }))
  },
}

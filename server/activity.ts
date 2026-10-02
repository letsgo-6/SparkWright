// SPDX-License-Identifier: MPL-2.0
import type { FastifyInstance } from 'fastify'
import { db } from './db'
import { permissionError, requireAdmin } from './permissions'

export type ActivityView = '24h' | '7d' | '30d'
const durations = { '24h': 86400, '7d': 604800, '30d': 2592000 }
const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

// Explicit product routes: automatic message/presence/notification/admin polling is excluded.
export function isActivityRoute(method: string, route: string): boolean {
  if (method === 'GET') return /^(?:\/api\/(?:dashboard|ideas|ideas\/\:id|plaza|plaza\/\:id|plaza\/leaderboard|dev|dev\/\:id|orders|orders\/\:id|media|studio|studio\/\:id|wishes|consult|daily-plans|daily-reviews))$/.test(route)
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false
  if (route.includes('/ai/chat')) return false // SSE uses its confirmed completion path.
  if (method === 'POST' && route === '/api/feedback') return false // Only new submissions record activity.
  return /^\/api\/(?:ideas(?:\/|$)|steps\/|plaza(?:\/|$)|dev(?:\/|$)|orders(?:\/|$)|media(?:\/|$)|studio(?:\/|$)|wishes(?:\/|$)|consult(?:\/|$)|daily-plans(?:\/|$)|daily-reviews(?:\/|$))/.test(route)
    || (method === 'POST' && /^\/api\/channels\/\:id\/messages$/.test(route))
    || (method === 'POST' && /^\/api\/synthesis\/\:id\/import$/.test(route))
}

export class ActivityTracker {
  private readonly seen = new Map<number, number>()
  private lastErrorAt: number | null = null
  private lastCleanup = 0
  private cleanupHandle: NodeJS.Immediate | null = null
  private stopped = false
  constructor(private readonly clock = () => Math.floor(Date.now() / 1000)) {
    db.prepare('INSERT INTO activity_collection_meta (id, collection_started_at) VALUES (1, ?) ON CONFLICT DO NOTHING').run(clock())
  }

  record(userId: number): void {
    if (this.stopped) return
    const now = this.clock(), hour = Math.floor(now / 3600) * 3600, last = this.seen.get(userId)
    if (last !== undefined && now - last < 60 && Math.floor(last / 3600) * 3600 === hour) return
    try {
      if (!(db.prepare("SELECT id FROM users WHERE id = ? AND role = 'user'").get(userId))) return
      db.transaction(() => {
        db.prepare('INSERT INTO user_activity_state (user_id,last_seen_at) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET last_seen_at=MAX(last_seen_at,excluded.last_seen_at)').run(userId, now)
        db.prepare(`INSERT INTO user_activity_hours (user_id,hour_start,first_seen_at,last_seen_at) VALUES (?,?,?,?)
          ON CONFLICT(user_id,hour_start) DO UPDATE SET first_seen_at=MIN(first_seen_at,excluded.first_seen_at), last_seen_at=MAX(last_seen_at,excluded.last_seen_at)`).run(userId, hour, now, now)
      }).immediate()
      if (this.seen.size >= 20000) {
        for (const [id, time] of this.seen) if (time < now - 86400) this.seen.delete(id)
        if (this.seen.size >= 20000) this.seen.delete(this.seen.keys().next().value!)
      }
      this.seen.set(userId, now)
      if (now - this.lastCleanup >= 86400) { this.lastCleanup = now; this.cleanup(now) }
    } catch {
      if (this.lastErrorAt === null || now - this.lastErrorAt >= 60) console.error('[activity] collection_failed')
      this.lastErrorAt = now
    }
  }

  private cleanup(now: number): void {
    const meta = db.prepare('SELECT last_cleanup_at FROM activity_collection_meta WHERE id=1').get() as { last_cleanup_at: number | null }
    if (meta.last_cleanup_at !== null && now - meta.last_cleanup_at < 86400) return
    const batch = () => {
      try {
        const result = db.prepare('DELETE FROM user_activity_hours WHERE rowid IN (SELECT rowid FROM user_activity_hours WHERE hour_start < ? LIMIT 5000)').run(now - 90 * 86400)
        if (result.changes === 5000) this.cleanupHandle = setImmediate(() => { this.cleanupHandle = null; if (!this.stopped) batch() })
        else db.prepare('UPDATE activity_collection_meta SET last_cleanup_at=? WHERE id=1').run(now)
      } catch { this.lastErrorAt = now; console.error('[activity] cleanup_failed') }
    }
    batch()
  }

  stop(): void { this.stopped = true; if (this.cleanupHandle) clearImmediate(this.cleanupHandle) }

  report(view: ActivityView) {
    const now = this.clock()
    return db.transaction(() => {
      const start = (db.prepare('SELECT collection_started_at FROM activity_collection_meta WHERE id=1').get() as { collection_started_at: number }).collection_started_at
      const summary = Object.fromEntries(Object.entries(durations).map(([key, duration]) => {
        const value = (db.prepare(`SELECT COUNT(*) value FROM user_activity_state a JOIN users u ON u.id=a.user_id
          WHERE u.role='user' AND a.last_seen_at > ? AND a.last_seen_at <= ?`).get(now - duration, now) as { value: number }).value
        return [key, { value, window_complete: start <= now - duration }]
      }))
      const hourly = view === '24h', size = hourly ? 3600 : 86400, count = hourly ? 24 : view === '7d' ? 7 : 30
      const current = hourly ? Math.floor(now / size) * size : Math.floor((now + 28800) / size) * size - 28800
      const from = current - (count - 1) * size
      // At most 30 bounded range queries avoid a large computed-day GROUP BY sort.
      const bucketCount = db.prepare(`SELECT COUNT(DISTINCT a.user_id) value
        FROM user_activity_hours a INDEXED BY idx_activity_hours_chart JOIN users u ON u.id=a.user_id
        WHERE u.role='user' AND a.hour_start >= ? AND a.hour_start < ? AND a.first_seen_at <= ?`)
      const series = Array.from({ length: count }, (_, index) => {
        const bucket = from + index * size
        const notCollected = bucket + size <= start
        return { start: iso(bucket), value: notCollected ? null : (bucketCount.get(bucket,bucket+size,now) as {value:number}).value,
          coverage: notCollected ? 'not_collected' : bucket < start || bucket + size > now ? 'partial' : 'complete' }
      })
      return { generated_at: iso(now), scope: 'current_user_role', timezone: 'Asia/Shanghai', sampling_interval_seconds: 60,
        collection_started_at: iso(start), collection_health: this.lastErrorAt === null ? 'ok' : 'degraded',
        last_collection_error_at: this.lastErrorAt === null ? null : iso(this.lastErrorAt), summary,
        view, bucket: hourly ? 'hour' : 'day', chart_from: iso(from), chart_to: iso(now), series }
    }).deferred()
  }
}

export function registerActivity(app: FastifyInstance, tracker: ActivityTracker): void {
  app.addHook('onClose', async () => tracker.stop())
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 200 && reply.statusCode < 300 && req.activitySucceeded !== false && !req.raw.aborted && req.authUser && isActivityRoute(req.method, req.routeOptions.url || ''))
      tracker.record(req.authUser.id)
  })
  app.get<{ Querystring: Record<string, unknown> }>('/api/admin/analytics/activity', async (req, reply) => {
    requireAdmin(req)
    const view = req.query.view === undefined ? '24h' : req.query.view
    if (!['24h','7d','30d'].includes(String(view)) || Object.keys(req.query).some((key) => key !== 'view'))
      throw permissionError(400, 'invalid_activity_view', '统计周期不合法')
    reply.header('Cache-Control', 'no-store')
    return tracker.report(view as ActivityView)
  })
}

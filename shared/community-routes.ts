// SPDX-License-Identifier: MPL-2.0
// Explicit shared HTTP contract. No private workbench, exports, backups or Key reveal.
export function communityRoute(method: string, path: string): boolean {
  if (method === 'GET' && ['/api/health', '/api/community/auth/me', '/api/community/info', '/api/community/history', '/api/community/mine', '/api/community/admin/status', '/api/community/admin/activity', '/api/plaza', '/api/plaza/leaderboard', '/api/settings', '/api/feedback', '/api/admin/feedback', '/api/admin/moderation/users', '/api/admin/channels', '/api/admin/users', '/api/admin/plaza/ideas', '/api/notifications'].includes(path)) return true
  if (method === 'GET' && /^\/api\/(?:plaza\/\d+(?:\/scores)?|feedback\/\d+(?:\/events)?|admin\/feedback\/\d+(?:\/events)?)$/.test(path)) return true
  if (method === 'POST' && ['/api/community/auth/register', '/api/community/auth/login', '/api/community/auth/logout', '/api/community/messages', '/api/community/activity', '/api/community/submissions', '/api/feedback'].includes(path)) return true
  if (method === 'POST' && /^\/api\/(?:ideas\/\d+\/ai\/score|plaza\/\d+\/(?:publish|unpublish)|admin\/plaza\/ideas\/\d+\/(?:remove|restore)|admin\/channels\/\d+\/restore|admin\/feedback\/\d+\/(?:notes|replies))$/.test(path)) return true
  if (method === 'PUT' && (path === '/api/settings' || /^\/api\/ideas\/\d+\/leaderboard$/.test(path))) return true
  if (method === 'PATCH' && /^\/api\/(?:admin\/users\/\d+\/(?:mute|role)|admin\/channels\/\d+|admin\/feedback\/\d+\/status)$/.test(path)) return true
  return method === 'DELETE' && /^\/api\/admin\/channels\/\d+$/.test(path)
}

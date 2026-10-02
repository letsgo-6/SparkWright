// SPDX-License-Identifier: MPL-2.0
/** Validate before rendering, and again at the API boundary. No network requests. */
export function safeActionUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null
  try {
    if (/[\\\u0000-\u001f\u007f]/.test(decodeURIComponent(value))) return null
    if (value.startsWith('/')) {
      if (value.startsWith('//') || decodeURIComponent(value).startsWith('//')) return null
      const url = new URL(value, 'https://sparkwright.invalid')
      return url.origin === 'https://sparkwright.invalid' ? value : null
    }
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function githubRepositoryUrl(value: unknown): string | null {
  const safe = safeActionUrl(value)
  if (!safe || safe.startsWith('/')) return null
  const url = new URL(safe)
  const parts = url.pathname.replace(/\/$/, '').split('/')
  if (url.hostname !== 'github.com' || url.port || url.search || url.hash || parts.length !== 3 ||
      !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(parts[1]) || !/^[a-z\d_.-]{1,100}$/i.test(parts[2]) || ['.', '..'].includes(parts[2])) return null
  return `https://github.com/${parts[1]}/${parts[2]}`
}

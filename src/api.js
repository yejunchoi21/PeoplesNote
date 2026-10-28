/**
 * Shared API helper: always sends cookies (credentials) and CSRF header.
 * Auth tokens are never stored in localStorage — only HttpOnly session cookies.
 */

let csrfToken = ''

export function getCsrfToken() {
  return csrfToken
}

export function setCsrfToken(token) {
  csrfToken = typeof token === 'string' ? token : ''
}

export async function refreshCsrf() {
  const res = await fetch('/api/auth/csrf', { credentials: 'include' })
  if (!res.ok) {
    throw new Error('Could not initialize security token.')
  }
  const data = await res.json()
  setCsrfToken(data.csrfToken || '')
  return csrfToken
}

export async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const headers = { ...(options.headers || {}) }

  if (options.body != null && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken
  }

  const res = await fetch(path, {
    ...options,
    method,
    credentials: 'include',
    headers,
  })

  return res
}

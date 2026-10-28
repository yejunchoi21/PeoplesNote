import { useEffect, useState } from 'react'
import { api, getCsrfToken, refreshCsrf, setCsrfToken } from './api'

export default function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    refreshCsrf()
      .then(() => {
        if (!cancelled) setReady(true)
      })
      .catch(() => {
        if (!cancelled) {
          setError('Could not reach the server. Is the API running?')
          setReady(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (!getCsrfToken()) {
        await refreshCsrf()
      }
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/signup'
      const res = await api(path, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.message || 'Authentication failed.')
      }
      if (data.csrfToken) setCsrfToken(data.csrfToken)
      onAuthenticated(data.user)
    } catch (err) {
      setError(err.message || 'Authentication failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand auth-brand">
          <span className="brand-mark" aria-hidden="true">
            PN
          </span>
          <span className="brand-name">PeoplesNote</span>
        </div>
        <h1>{mode === 'login' ? 'Log in' : 'Create account'}</h1>
        <p className="auth-subtitle">
          Your contacts and reminders stay private to your account.
        </p>

        <form className="contact-form auth-form" onSubmit={handleSubmit}>
          <label>
            Email
            <input
              type="email"
              name="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={!ready || busy}
              autoFocus
            />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete={
                mode === 'login' ? 'current-password' : 'new-password'
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              disabled={!ready || busy}
            />
          </label>

          {error && (
            <p className="status-banner status-banner--error" role="alert">
              {error}
            </p>
          )}

          <div className="form-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!ready || busy}
            >
              {busy
                ? mode === 'login'
                  ? 'Logging in…'
                  : 'Creating account…'
                : mode === 'login'
                  ? 'Log in'
                  : 'Sign up'}
            </button>
          </div>
        </form>

        <p className="auth-switch">
          {mode === 'login' ? (
            <>
              No account yet?{' '}
              <button
                type="button"
                className="auth-link"
                onClick={() => {
                  setMode('signup')
                  setError('')
                }}
                disabled={busy}
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                type="button"
                className="auth-link"
                onClick={() => {
                  setMode('login')
                  setError('')
                }}
                disabled={busy}
              >
                Log in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  )
}

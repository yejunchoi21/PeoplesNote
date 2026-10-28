/**
 * Automated isolation check for two accounts.
 * Creates ephemeral users, verifies cross-account denial, then deletes them.
 * Requires the API to be running on http://127.0.0.1:3001
 *
 * Usage: npm test
 */
import { MongoClient } from 'mongodb'
import 'dotenv/config'

const BASE = process.env.API_BASE || 'http://127.0.0.1:3001'
const MONGODB_URI = process.env.MONGODB_URI

function jar() {
  return { cookie: '' }
}

function storeCookie(cookieJar, res) {
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : []
  for (const c of raw) {
    const part = c.split(';')[0]
    if (part.startsWith('peoplesnote.sid=')) cookieJar.cookie = part
  }
}

async function req(cookieJar, path, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (cookieJar.cookie) headers.Cookie = cookieJar.cookie
  if (options.body != null && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(BASE + path, { ...options, headers })
  storeCookie(cookieJar, res)
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

async function signup(cookieJar, email, password) {
  const csrf = await req(cookieJar, '/api/auth/csrf')
  return req(cookieJar, '/api/auth/signup', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf.data.csrfToken },
    body: JSON.stringify({ email, password }),
  })
}

async function cleanupUsers(emails) {
  if (!MONGODB_URI) return
  const client = new MongoClient(MONGODB_URI)
  try {
    await client.connect()
    const db = client.db()
    const users = await db
      .collection('users')
      .find({ email: { $in: emails } })
      .toArray()
    const ids = users.map((u) => u._id)
    if (ids.length === 0) return
    await db.collection('contacts').deleteMany({ userId: { $in: ids } })
    await db.collection('reminders').deleteMany({ userId: { $in: ids } })
    await db.collection('users').deleteMany({ _id: { $in: ids } })
  } finally {
    await client.close()
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const stamp = Date.now()
const emailA = `iso_a_${stamp}@example.com`
const emailB = `iso_b_${stamp}@example.com`
// Ephemeral password for this run only — not a real account credential.
const password = `Tmp-${stamp}-x`

const jarA = jar()
const jarB = jar()

try {
  const a = await signup(jarA, emailA, password)
  assert(a.status === 201, `A signup failed: ${a.status}`)
  const b = await signup(jarB, emailB, password)
  assert(b.status === 201, `B signup failed: ${b.status}`)

  const csrfA = (await req(jarA, '/api/auth/csrf')).data.csrfToken
  const csrfB = (await req(jarB, '/api/auth/csrf')).data.csrfToken

  const createA = await req(jarA, '/api/contacts', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfA },
    body: JSON.stringify({ name: 'Isolation Contact', tags: ['test'] }),
  })
  assert(createA.status === 201, 'A should create a contact')
  const contactAId = createA.data.id

  const listB = await req(jarB, '/api/contacts')
  assert(listB.status === 200, 'B should list contacts')
  assert(
    Array.isArray(listB.data) && listB.data.length === 0,
    'B must not see A contacts',
  )

  const steal = await req(jarB, `/api/contacts/${contactAId}`, {
    method: 'PUT',
    headers: { 'X-CSRF-Token': csrfB },
    body: JSON.stringify({ name: 'Hacked' }),
  })
  assert(steal.status === 404, 'B must not edit A contact')

  const del = await req(jarB, `/api/contacts/${contactAId}`, {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': csrfB },
  })
  assert(del.status === 404, 'B must not delete A contact')

  const remB = await req(jarB, '/api/reminders', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfB },
    body: JSON.stringify({
      contactId: contactAId,
      reason: 'should fail',
      dueDate: '2030-01-01',
    }),
  })
  assert(remB.status === 400, 'B must not attach reminder to A contact')

  const unauth = await fetch(`${BASE}/api/contacts`)
  assert(unauth.status === 401, 'Unauthenticated access must be denied')

  console.log('isolation tests passed')
} finally {
  await cleanupUsers([emailA, emailB])
}

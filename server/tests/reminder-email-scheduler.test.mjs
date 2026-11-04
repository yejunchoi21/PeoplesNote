/**
 * Focused scheduler tests with an in-memory Mongo-like collection
 * and a mocked sendEmail — never talks to Resend.
 */

import {
  MAX_NOTIFY_ATTEMPTS,
  NOTIFY_STATUS,
  STALE_PROCESSING_MS,
  applyNotifyScheduleChange,
  buildNotifyIdempotencyKey,
  claimNextDueReminder,
  classifyProviderFailure,
  computeRetryDelaySeconds,
  dueReminderQuery,
  processDueReminderEmails,
  safeNotifyError,
} from '../reminderEmailScheduler.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function matchesQuery(doc, query) {
  for (const [key, expected] of Object.entries(query)) {
    if (key === '$or') {
      if (!Array.isArray(expected) || !expected.some((q) => matchesQuery(doc, q))) {
        return false
      }
      continue
    }
    const actual = doc[key]
    if (
      expected &&
      typeof expected === 'object' &&
      !Array.isArray(expected) &&
      '$lte' in expected
    ) {
      if (actual == null) return false
      const left =
        actual instanceof Date ? actual.toISOString() : String(actual)
      const right =
        expected.$lte instanceof Date
          ? expected.$lte.toISOString()
          : String(expected.$lte)
      if (!(left <= right)) return false
      continue
    }
    if (actual !== expected) return false
  }
  return true
}

function createMemoryCollection(initialDocs = []) {
  const docs = initialDocs.map((d) => structuredClone(d))

  return {
    _docs: docs,
    async findOne(query) {
      return docs.find((d) => matchesQuery(d, query)) || null
    },
    async findOneAndUpdate(query, update, options = {}) {
      let candidates = docs.filter((d) => matchesQuery(d, query))
      if (options.sort?.notifyAtUtc) {
        candidates = candidates.sort((a, b) =>
          String(a.notifyAtUtc).localeCompare(String(b.notifyAtUtc)),
        )
      }
      const doc = candidates[0]
      if (!doc) return null
      if (update.$set) Object.assign(doc, update.$set)
      return doc
    },
    async updateOne(query, update) {
      const doc = docs.find((d) => matchesQuery(d, query))
      if (!doc) return { matchedCount: 0 }
      if (update.$set) Object.assign(doc, update.$set)
      return { matchedCount: 1 }
    },
  }
}

function baseReminder(overrides = {}) {
  const dueIso = overrides.notifyAtUtc || '2026-06-01T11:00:00.000Z'
  const id = overrides._id || 'r1'
  return {
    _id: id,
    userId: 'u1',
    reason: 'Check in',
    dueDate: '2026-06-02',
    completed: false,
    emailNotifyEnabled: true,
    notifyAtUtc: dueIso,
    notifyStatus: NOTIFY_STATUS.PENDING,
    notifyAttemptCount: 0,
    notifyIdempotencyKey: buildNotifyIdempotencyKey(id, dueIso),
    ...overrides,
  }
}

// —— helpers ——
assert(safeNotifyError('  hi  ').length <= 240, 'safe error trims')
assert(
  buildNotifyIdempotencyKey('abc', '2026-01-01T12:00:00.000Z') ===
    'pn-reminder/abc/2026-01-01T12:00:00.000Z',
  'idempotency key shape',
)
assert(computeRetryDelaySeconds(1, null) === 60, 'default backoff attempt 1')
assert(computeRetryDelaySeconds(1, 120) === 120, 'honors retry-after when larger')
assert(computeRetryDelaySeconds(2, 10) === 300, 'backoff wins when larger')

assert(
  classifyProviderFailure({ name: 'rate_limit_exceeded', retryAfterSeconds: 12 })
    .retryable === true,
  'rate limit is temporary',
)
assert(
  classifyProviderFailure({ name: 'validation_error', error: 'bad recipient' })
    .retryable === false,
  'validation is permanent',
)
assert(
  classifyProviderFailure({ name: 'daily_quota_exceeded' }).retryable === false,
  'quota is permanent',
)
assert(
  classifyProviderFailure({ error: 'socket hang up' }).retryable === true,
  'unknown/network treated temporary',
)

const disabled = applyNotifyScheduleChange(
  {
    emailNotifyEnabled: false,
    notifyAtUtc: null,
    notifyTimeZone: null,
    notifyLocalDate: null,
    notifyLocalTime: null,
  },
  'id1',
)
assert(disabled.notifyStatus === null, 'disabled clears status')
assert(disabled.notifyAttemptCount === 0, 'disabled clears attempts')

const enabled = applyNotifyScheduleChange(
  {
    emailNotifyEnabled: true,
    notifyAtUtc: '2026-01-01T12:00:00.000Z',
    notifyTimeZone: 'UTC',
    notifyLocalDate: '2026-01-01',
    notifyLocalTime: '12:00',
  },
  'id1',
)
assert(enabled.notifyStatus === NOTIFY_STATUS.PENDING, 'enable → pending')
assert(enabled.notifyAttemptCount === 0, 'enable resets attempts')

const now = new Date('2026-06-01T12:00:00.000Z')
const dueIso = '2026-06-01T11:00:00.000Z'
const q = dueReminderQuery(now)
assert(Array.isArray(q.$or) && q.$or.length === 3, 'due query has pending/retry/stale')

// —— atomic claim ——
{
  const reminders = createMemoryCollection([baseReminder()])
  const first = await claimNextDueReminder(reminders, now)
  assert(first && first._id === 'r1', 'claims due reminder')
  assert(first.notifyStatus === NOTIFY_STATUS.PROCESSING, 'moves to processing')
  const second = await claimNextDueReminder(reminders, now)
  assert(second === null, 'second claim finds nothing')
}

// —— successful submit ——
{
  const reminders = createMemoryCollection([baseReminder()])
  const users = createMemoryCollection([
    { _id: 'u1', email: 'owner@example.com', reminderEmailsEnabled: true },
  ])
  let sendCalls = 0
  let usedKey = null
  const outcomes = await processDueReminderEmails({
    remindersCollection: reminders,
    usersCollection: users,
    emailFrom: 'PeoplesNote <onboarding@resend.dev>',
    now,
    sendEmail: async (payload) => {
      sendCalls += 1
      usedKey = payload.idempotencyKey
      assert(payload.to === 'owner@example.com', 'sends only to owner email')
      return { ok: true, id: 'email_mock_1' }
    },
  })
  assert(sendCalls === 1, 'mock send called once')
  assert(outcomes[0].status === 'submitted', 'submitted')
  assert(reminders._docs[0].notifyAttemptCount === 1, 'attempt counted')
  assert(
    usedKey === buildNotifyIdempotencyKey('r1', dueIso),
    'stable idempotency key',
  )
}

// —— permanent failure → failed (no retry) ——
{
  const reminders = createMemoryCollection([baseReminder({ _id: 'r-perm' })])
  const users = createMemoryCollection([
    { _id: 'u1', email: 'owner@example.com', reminderEmailsEnabled: true },
  ])
  const outcomes = await processDueReminderEmails({
    remindersCollection: reminders,
    usersCollection: users,
    emailFrom: 'from@example.com',
    now,
    sendEmail: async () => ({
      ok: false,
      name: 'validation_error',
      error: 'invalid recipient',
      statusCode: 403,
    }),
  })
  assert(outcomes[0].status === 'failed', 'permanent → failed')
  assert(reminders._docs[0].notifyStatus === NOTIFY_STATUS.FAILED, 'stays failed')
  assert(reminders._docs[0].notifyNextAttemptAt == null, 'no next attempt')
}

// —— temporary failure → retrying with delay; same idempotency key on retry ——
{
  const reminders = createMemoryCollection([baseReminder({ _id: 'r-retry' })])
  const users = createMemoryCollection([
    { _id: 'u1', email: 'owner@example.com', reminderEmailsEnabled: true },
  ])
  const keys = []
  const first = await processDueReminderEmails({
    remindersCollection: reminders,
    usersCollection: users,
    emailFrom: 'from@example.com',
    now,
    sendEmail: async (payload) => {
      keys.push(payload.idempotencyKey)
      return {
        ok: false,
        name: 'rate_limit_exceeded',
        error: 'Too many requests',
        statusCode: 429,
        retryAfterSeconds: 90,
      }
    },
  })
  assert(first[0].status === 'retrying', 'temporary → retrying')
  assert(reminders._docs[0].notifyStatus === NOTIFY_STATUS.RETRYING, 'status retrying')
  assert(reminders._docs[0].notifyAttemptCount === 1, 'attempt 1 recorded')
  assert(
    reminders._docs[0].notifyNextAttemptAt ===
      new Date(now.getTime() + 90 * 1000).toISOString(),
    'honors retry-after (90 > 60)',
  )

  // Too early for retry
  const early = await processDueReminderEmails({
    remindersCollection: reminders,
    usersCollection: users,
    emailFrom: 'from@example.com',
    now: new Date(now.getTime() + 30_000),
    sendEmail: async () => ({ ok: true, id: 'should-not' }),
  })
  assert(early.length === 0, 'not claimed before next attempt')

  // After delay, retry with same key and succeed
  const later = new Date(now.getTime() + 120_000)
  const second = await processDueReminderEmails({
    remindersCollection: reminders,
    usersCollection: users,
    emailFrom: 'from@example.com',
    now: later,
    sendEmail: async (payload) => {
      keys.push(payload.idempotencyKey)
      return { ok: true, id: 'email_retry_ok' }
    },
  })
  assert(second[0].status === 'submitted', 'retry submitted')
  assert(keys[0] === keys[1], 'idempotency key stable across retries')
  assert(reminders._docs[0].notifyAttemptCount === 2, 'attempt 2 on success path')
}

// —— max attempts exhausted ——
{
  const reminders = createMemoryCollection([
    baseReminder({
      _id: 'r-max',
      notifyAttemptCount: MAX_NOTIFY_ATTEMPTS - 1,
    }),
  ])
  const users = createMemoryCollection([
    { _id: 'u1', email: 'owner@example.com', reminderEmailsEnabled: true },
  ])
  const outcomes = await processDueReminderEmails({
    remindersCollection: reminders,
    usersCollection: users,
    emailFrom: 'from@example.com',
    now,
    sendEmail: async () => ({
      ok: false,
      name: 'rate_limit_exceeded',
      error: 'still limited',
      statusCode: 429,
      retryAfterSeconds: 5,
    }),
  })
  assert(outcomes[0].status === 'failed', '3rd temp failure → failed')
  assert(reminders._docs[0].notifyAttemptCount === MAX_NOTIFY_ATTEMPTS, 'max attempts')
  assert(reminders._docs[0].notifyStatus === NOTIFY_STATUS.FAILED, 'final failed')
}

// —— account preference disabled → skipped, no send ——
{
  const reminders = createMemoryCollection([baseReminder({ _id: 'r-pref-off' })])
  const users = createMemoryCollection([
    { _id: 'u1', email: 'owner@example.com', reminderEmailsEnabled: false },
  ])
  let sendCalls = 0
  const outcomes = await processDueReminderEmails({
    remindersCollection: reminders,
    usersCollection: users,
    emailFrom: 'from@example.com',
    now,
    sendEmail: async () => {
      sendCalls += 1
      return { ok: true, id: 'x' }
    },
  })
  assert(sendCalls === 0, 'no send when account pref off')
  assert(outcomes[0].status === 'skipped', 'skipped')
  assert(reminders._docs[0].notifyStatus === NOTIFY_STATUS.SKIPPED, 'status skipped')
}

// —— re-enable must not send backlog (notifyAtUtc before enabledAt) ——
{
  const reminders = createMemoryCollection([
    baseReminder({
      _id: 'r-backlog',
      notifyAtUtc: '2026-06-01T10:00:00.000Z',
      notifyIdempotencyKey: buildNotifyIdempotencyKey(
        'r-backlog',
        '2026-06-01T10:00:00.000Z',
      ),
    }),
  ])
  const users = createMemoryCollection([
    {
      _id: 'u1',
      email: 'owner@example.com',
      reminderEmailsEnabled: true,
      // Re-enabled after the notification time.
      reminderEmailsEnabledAt: '2026-06-01T11:30:00.000Z',
    },
  ])
  let sendCalls = 0
  const outcomes = await processDueReminderEmails({
    remindersCollection: reminders,
    usersCollection: users,
    emailFrom: 'from@example.com',
    now,
    sendEmail: async () => {
      sendCalls += 1
      return { ok: true, id: 'x' }
    },
  })
  assert(sendCalls === 0, 'no backlog send after re-enable')
  assert(outcomes[0].status === 'skipped', 'backlog skipped')
  assert(
    /re-enabled/i.test(reminders._docs[0].notifyError || ''),
    'explains backlog skip',
  )
}

// —— account isolation: u2 still sends when u1 pref is off ——
{
  const reminders = createMemoryCollection([
    baseReminder({ _id: 'r-u1', userId: 'u1' }),
    baseReminder({
      _id: 'r-u2',
      userId: 'u2',
      notifyIdempotencyKey: buildNotifyIdempotencyKey('r-u2', dueIso),
    }),
  ])
  const users = createMemoryCollection([
    { _id: 'u1', email: 'a@example.com', reminderEmailsEnabled: false },
    { _id: 'u2', email: 'b@example.com', reminderEmailsEnabled: true },
  ])
  const sentTo = []
  const outcomes = await processDueReminderEmails({
    remindersCollection: reminders,
    usersCollection: users,
    emailFrom: 'from@example.com',
    now,
    limit: 10,
    sendEmail: async (payload) => {
      sentTo.push(payload.to)
      return { ok: true, id: `id-${payload.to}` }
    },
  })
  assert(
    outcomes.some((o) => o.id === 'r-u1' && o.status === 'skipped'),
    'u1 skipped',
  )
  assert(
    outcomes.some((o) => o.id === 'r-u2' && o.status === 'submitted'),
    'u2 submitted',
  )
  assert(sentTo.length === 1 && sentTo[0] === 'b@example.com', 'only u2 emailed')
}

// —— interrupted processing reclaim uses same key ——
{
  const staleClaim = new Date(now.getTime() - STALE_PROCESSING_MS - 1000)
  const reminders = createMemoryCollection([
    baseReminder({
      _id: 'r-stale',
      notifyStatus: NOTIFY_STATUS.PROCESSING,
      notifyClaimedAt: staleClaim.toISOString(),
      notifyAttemptCount: 1,
    }),
  ])
  const users = createMemoryCollection([
    { _id: 'u1', email: 'owner@example.com', reminderEmailsEnabled: true },
  ])
  let key = null
  const outcomes = await processDueReminderEmails({
    remindersCollection: reminders,
    usersCollection: users,
    emailFrom: 'from@example.com',
    now,
    sendEmail: async (payload) => {
      key = payload.idempotencyKey
      return { ok: true, id: 'reclaimed' }
    },
  })
  assert(outcomes[0].status === 'submitted', 'stale processing reclaimed')
  assert(
    key === buildNotifyIdempotencyKey('r-stale', dueIso),
    'reclaim keeps stable idempotency key',
  )
}

// —— completed / reminder-disabled after claim → skipped ——
{
  const reminders = createMemoryCollection([baseReminder({ _id: 'r-done' })])
  const users = createMemoryCollection([
    { _id: 'u1', email: 'owner@example.com', reminderEmailsEnabled: true },
  ])
  const wrapped = {
    findOneAndUpdate: (...args) => reminders.findOneAndUpdate(...args),
    updateOne: (...args) => reminders.updateOne(...args),
    async findOne(query) {
      const doc = await reminders.findOne(query)
      if (doc && String(doc._id) === 'r-done') return { ...doc, completed: true }
      return doc
    },
  }
  let sendCalls = 0
  const outcomes = await processDueReminderEmails({
    remindersCollection: wrapped,
    usersCollection: users,
    emailFrom: 'from@example.com',
    now,
    sendEmail: async () => {
      sendCalls += 1
      return { ok: true, id: 'x' }
    },
  })
  assert(sendCalls === 0, 'no send when completed after claim')
  assert(outcomes[0].status === 'skipped', 'completed → skipped')
}

{
  // Future notifyAtUtc is not claimed
  const future = createMemoryCollection([
    baseReminder({
      _id: 'r-future',
      notifyAtUtc: '2026-12-01T00:00:00.000Z',
      notifyIdempotencyKey: buildNotifyIdempotencyKey(
        'r-future',
        '2026-12-01T00:00:00.000Z',
      ),
    }),
  ])
  const claimed = await claimNextDueReminder(future, now)
  assert(claimed === null, 'future notification not due yet')
}

console.log('reminder-email-scheduler tests passed')

/**
 * Focused scheduler tests with an in-memory Mongo-like collection
 * and a mocked sendEmail — never talks to Resend.
 */

import {
  NOTIFY_STATUS,
  applyNotifyScheduleChange,
  buildNotifyIdempotencyKey,
  claimNextDueReminder,
  dueReminderQuery,
  processDueReminderEmails,
  safeNotifyError,
} from '../reminderEmailScheduler.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function createMemoryCollection(initialDocs = []) {
  const docs = initialDocs.map((d) => structuredClone(d))

  function matches(doc, query) {
    for (const [key, expected] of Object.entries(query)) {
      const actual = doc[key]
      if (
        expected &&
        typeof expected === 'object' &&
        !Array.isArray(expected) &&
        '$lte' in expected
      ) {
        if (!(String(actual) <= String(expected.$lte))) return false
        continue
      }
      if (actual !== expected) return false
    }
    return true
  }

  return {
    _docs: docs,
    async findOne(query) {
      return docs.find((d) => matches(d, query)) || null
    },
    async findOneAndUpdate(query, update, options = {}) {
      let candidates = docs.filter((d) => matches(d, query))
      if (options.sort?.notifyAtUtc) {
        candidates = candidates.sort((a, b) =>
          String(a.notifyAtUtc).localeCompare(String(b.notifyAtUtc)),
        )
      }
      const doc = candidates[0]
      if (!doc) return null
      if (update.$set) Object.assign(doc, update.$set)
      return options.returnDocument === 'after' ? doc : doc
    },
    async updateOne(query, update) {
      const doc = docs.find((d) => matches(d, query))
      if (!doc) return { matchedCount: 0 }
      if (update.$set) Object.assign(doc, update.$set)
      return { matchedCount: 1 }
    },
  }
}

// —— helpers ——
assert(safeNotifyError('  hi  ').length <= 240, 'safe error trims')
assert(
  buildNotifyIdempotencyKey('abc', '2026-01-01T12:00:00.000Z') ===
    'pn-reminder/abc/2026-01-01T12:00:00.000Z',
  'idempotency key shape',
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
assert(disabled.notifyIdempotencyKey === null, 'disabled clears key')

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
assert(
  enabled.notifyIdempotencyKey ===
    'pn-reminder/id1/2026-01-01T12:00:00.000Z',
  'enable sets key from schedule',
)

const rescheduled = applyNotifyScheduleChange(
  {
    emailNotifyEnabled: true,
    notifyAtUtc: '2026-01-02T15:00:00.000Z',
    notifyTimeZone: 'UTC',
    notifyLocalDate: '2026-01-02',
    notifyLocalTime: '15:00',
  },
  'id1',
)
assert(rescheduled.notifyStatus === NOTIFY_STATUS.PENDING, 'reschedule resets pending')
assert(
  rescheduled.notifyIdempotencyKey ===
    'pn-reminder/id1/2026-01-02T15:00:00.000Z',
  'reschedule refreshes idempotency key',
)
assert(rescheduled.notifyProviderId === null, 'reschedule clears provider id')

// —— claim is atomic (second claim gets nothing) ——
const now = new Date('2026-06-01T12:00:00.000Z')
const dueIso = '2026-06-01T11:00:00.000Z'
const reminders = createMemoryCollection([
  {
    _id: 'r1',
    userId: 'u1',
    reason: 'Check in',
    dueDate: '2026-06-02',
    completed: false,
    emailNotifyEnabled: true,
    notifyAtUtc: dueIso,
    notifyStatus: NOTIFY_STATUS.PENDING,
    notifyIdempotencyKey: buildNotifyIdempotencyKey('r1', dueIso),
  },
])

const q = dueReminderQuery(now)
assert(q.notifyStatus === NOTIFY_STATUS.PENDING, 'due query pending')

const first = await claimNextDueReminder(reminders, now)
assert(first && first._id === 'r1', 'claims due reminder')
assert(first.notifyStatus === NOTIFY_STATUS.PROCESSING, 'moves to processing')

const second = await claimNextDueReminder(reminders, now)
assert(second === null, 'second claim finds nothing')

// —— processDueReminderEmails with mock send ——
const users = createMemoryCollection([{ _id: 'u1', email: 'owner@example.com' }])

{
  // Reset to pending for send test
  reminders._docs[0].notifyStatus = NOTIFY_STATUS.PENDING
  reminders._docs[0].notifyClaimedAt = null

  let sendCalls = 0
  const outcomes = await processDueReminderEmails({
    remindersCollection: reminders,
    usersCollection: users,
    emailFrom: 'PeoplesNote <onboarding@resend.dev>',
    now,
    sendEmail: async (payload) => {
      sendCalls += 1
      assert(payload.to === 'owner@example.com', 'sends only to owner email')
      assert(
        payload.idempotencyKey === buildNotifyIdempotencyKey('r1', dueIso),
        'passes idempotency key',
      )
      return { ok: true, id: 'email_mock_1' }
    },
  })

  assert(sendCalls === 1, 'mock send called once')
  assert(outcomes.length === 1 && outcomes[0].status === 'submitted', 'submitted')
  assert(
    reminders._docs[0].notifyStatus === NOTIFY_STATUS.SUBMITTED,
    'doc marked submitted',
  )
  assert(
    reminders._docs[0].notifyProviderId === 'email_mock_1',
    'stores provider id',
  )
  assert(
    reminders._docs[0].notifySubmittedAt != null,
    'records submitted timestamp',
  )
}

{
  // Provider rejection → failed (no retry)
  reminders._docs[0].notifyStatus = NOTIFY_STATUS.PENDING
  reminders._docs[0].notifyProviderId = null
  reminders._docs[0].notifySubmittedAt = null

  const outcomes = await processDueReminderEmails({
    remindersCollection: reminders,
    usersCollection: users,
    emailFrom: 'PeoplesNote <onboarding@resend.dev>',
    now,
    sendEmail: async () => ({ ok: false, error: 'provider said no' }),
  })
  assert(outcomes[0].status === 'failed', 'failed outcome')
  assert(reminders._docs[0].notifyStatus === NOTIFY_STATUS.FAILED, 'stays failed')
  assert(
    reminders._docs[0].notifyError === 'provider said no',
    'stores safe error',
  )
}

{
  // Completed after claim → skip, do not call provider
  reminders._docs[0].notifyStatus = NOTIFY_STATUS.PENDING
  reminders._docs[0].completed = false
  reminders._docs[0].notifyError = null
  reminders._docs[0].emailNotifyEnabled = true

  const completedAfterClaim = {
    async findOneAndUpdate(query, update, options) {
      return reminders.findOneAndUpdate(query, update, options)
    },
    async findOne(query) {
      const doc = await reminders.findOne(query)
      if (doc && String(doc._id) === 'r1') {
        return { ...doc, completed: true }
      }
      return doc
    },
    async updateOne(query, update) {
      return reminders.updateOne(query, update)
    },
  }

  let sendCalls = 0
  const outcomes = await processDueReminderEmails({
    remindersCollection: completedAfterClaim,
    usersCollection: users,
    emailFrom: 'from@example.com',
    now,
    sendEmail: async () => {
      sendCalls += 1
      return { ok: true, id: 'x' }
    },
  })
  assert(sendCalls === 0, 'no send when completed after claim')
  assert(outcomes[0].status === 'skipped_completed', 'skipped completed')
  assert(reminders._docs[0].notifyStatus === null, 'clears status after skip')
}

{
  // Disabled after claim → skip
  reminders._docs.push({
    _id: 'r2',
    userId: 'u1',
    reason: 'Later',
    dueDate: '2026-06-03',
    completed: false,
    emailNotifyEnabled: true,
    notifyAtUtc: dueIso,
    notifyStatus: NOTIFY_STATUS.PENDING,
    notifyIdempotencyKey: buildNotifyIdempotencyKey('r2', dueIso),
  })

  const disabledAfterClaim = {
    async findOneAndUpdate(query, update, options) {
      return reminders.findOneAndUpdate(query, update, options)
    },
    async findOne(query) {
      const doc = await reminders.findOne(query)
      if (doc && String(doc._id) === 'r2') {
        return { ...doc, emailNotifyEnabled: false }
      }
      return doc
    },
    async updateOne(query, update) {
      return reminders.updateOne(query, update)
    },
  }

  let sendCalls = 0
  const outcomes = await processDueReminderEmails({
    remindersCollection: disabledAfterClaim,
    usersCollection: users,
    emailFrom: 'from@example.com',
    now,
    sendEmail: async () => {
      sendCalls += 1
      return { ok: true, id: 'x' }
    },
  })
  assert(sendCalls === 0, 'no send when disabled after claim')
  assert(outcomes[0].status === 'skipped_disabled', 'skipped disabled')
}

{
  // Future notifyAtUtc is not claimed
  const future = createMemoryCollection([
    {
      _id: 'r3',
      userId: 'u1',
      reason: 'Future',
      dueDate: '2026-07-01',
      completed: false,
      emailNotifyEnabled: true,
      notifyAtUtc: '2026-12-01T00:00:00.000Z',
      notifyStatus: NOTIFY_STATUS.PENDING,
    },
  ])
  const claimed = await claimNextDueReminder(future, now)
  assert(claimed === null, 'future notification not due yet')
}

console.log('reminder-email-scheduler tests passed')

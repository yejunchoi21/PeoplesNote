/**
 * In-process reminder email scheduler (learning-project style).
 *
 * Behavior
 * - Once per minute the Express process claims due reminder notifications and
 *   submits them via the email provider.
 * - Overlapping timer ticks in this process are skipped (run lock).
 * - Each row is claimed atomically (pending|retrying|stale-processing →
 *   processing) so overlapping workers cannot both send the same row.
 * - Account preference `reminderEmailsEnabled` is checked before send.
 *   Re-enabling sets `reminderEmailsEnabledAt`; notifications with
 *   notifyAtUtc before that timestamp are marked skipped (no backlog send).
 *
 * Attempts & retries
 * - Max 3 total send attempts per notification schedule.
 * - Temporary failures (rate limits, 5xx, concurrent idempotent lock, network)
 *   → status "retrying" with notifyNextAttemptAt (exponential backoff, or
 *   provider retry-after / ratelimit-reset when larger).
 * - Permanent failures (validation, invalid recipient, auth, quota exhausted)
 *   → status "failed" immediately (no automatic retry).
 * - Retries of the same schedule reuse the stable notifyIdempotencyKey.
 *
 * Interrupted processing
 * - Rows stuck in "processing" longer than STALE_PROCESSING_MS may be
 *   reclaimed once. The same Idempotency-Key is reused so Resend can return
 *   the original acceptance within ~24h instead of sending a duplicate.
 * - Uncertain outcome: if the first request was accepted but our process died
 *   before writing "submitted", reclaim + retry is usually safe inside the
 *   24h idempotency window. After the key expires, a reclaim could submit a
 *   second email — operators should inspect provider logs if that happens.
 * - "submitted" means provider acceptance only, never inbox delivery.
 *
 * Resend idempotency limits
 * - Key = pn-reminder/<reminderId>/<notifyAtUtc> (stable across retries).
 * - Dedupes same key + same payload for ~24 hours.
 * - Same key + different payload → 409; keys expire after ~24h.
 */

export const NOTIFY_STATUS = {
  PENDING: 'pending',
  RETRYING: 'retrying',
  PROCESSING: 'processing',
  SUBMITTED: 'submitted',
  FAILED: 'failed',
  SKIPPED: 'skipped',
}

export const MAX_NOTIFY_ATTEMPTS = 3
/** Backoff seconds after attempt 1, 2, … (capped by max attempts). */
export const RETRY_BACKOFF_SECONDS = [60, 300, 900]
/** Reclaim processing rows older than this (interrupted send recovery). */
export const STALE_PROCESSING_MS = 15 * 60 * 1000

const SAFE_ERROR_MAX = 240

export function safeNotifyError(err) {
  const raw =
    typeof err === 'string'
      ? err
      : err?.message
        ? String(err.message)
        : 'Email send failed'
  return raw.replace(/\s+/g, ' ').trim().slice(0, SAFE_ERROR_MAX)
}

export function buildNotifyIdempotencyKey(reminderId, notifyAtUtc) {
  return `pn-reminder/${String(reminderId)}/${String(notifyAtUtc)}`
}

export function computeRetryDelaySeconds(attemptCount, retryAfterSeconds) {
  const idx = Math.max(0, Math.min(attemptCount, RETRY_BACKOFF_SECONDS.length) - 1)
  const backoff = RETRY_BACKOFF_SECONDS[idx] ?? RETRY_BACKOFF_SECONDS.at(-1)
  const guided =
    typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
      ? Math.ceil(retryAfterSeconds)
      : 0
  return Math.max(backoff, guided)
}

/**
 * Classify a provider failure. Honors explicit `retryable` when provided.
 * Temporary: rate_limit_exceeded, 5xx, concurrent idempotent, network-ish.
 * Permanent: validation, auth, invalid recipient, quota exhausted, most 4xx.
 */
export function classifyProviderFailure(failure = {}) {
  if (typeof failure.retryable === 'boolean') {
    return {
      retryable: failure.retryable,
      retryAfterSeconds:
        typeof failure.retryAfterSeconds === 'number'
          ? failure.retryAfterSeconds
          : null,
      message: safeNotifyError(failure.error || failure.message || failure),
    }
  }

  const name = String(failure.name || failure.code || '').toLowerCase()
  const message = String(failure.error || failure.message || '')
  const lower = message.toLowerCase()
  const statusCode = Number(failure.statusCode) || 0
  const retryAfterSeconds =
    typeof failure.retryAfterSeconds === 'number'
      ? failure.retryAfterSeconds
      : null

  const permanentNames = new Set([
    'validation_error',
    'missing_required_field',
    'invalid_access',
    'invalid_parameter',
    'invalid_region',
    'missing_api_key',
    'invalid_api_key',
    'suspended_api_key',
    'invalid_from_address',
    'invalid_idempotency_key',
    'invalid_idempotent_request',
    'not_found',
    'daily_quota_exceeded',
    'monthly_quota_exceeded',
  ])

  const temporaryNames = new Set([
    'rate_limit_exceeded',
    'application_error',
    'internal_server_error',
    'concurrent_idempotent_requests',
    'resource_locked',
  ])

  if (
    permanentNames.has(name) ||
    /daily_quota|monthly_quota/.test(name) ||
    /invalid recipient|not a valid email|domain is not verified|only send testing emails/.test(
      lower,
    )
  ) {
    return { retryable: false, retryAfterSeconds: null, message: safeNotifyError(message) }
  }

  if (temporaryNames.has(name) || statusCode === 429 || statusCode >= 500) {
    return {
      retryable: true,
      retryAfterSeconds,
      message: safeNotifyError(message || name || 'Temporary provider error'),
    }
  }

  if (statusCode >= 400 && statusCode < 500) {
    return { retryable: false, retryAfterSeconds: null, message: safeNotifyError(message) }
  }

  // Unknown / thrown network errors → temporary so we can retry cautiously.
  if (!statusCode && !name) {
    return {
      retryable: true,
      retryAfterSeconds,
      message: safeNotifyError(message || 'Temporary send failure'),
    }
  }

  return { retryable: false, retryAfterSeconds: null, message: safeNotifyError(message) }
}

/**
 * Status fields when enabling/disabling or changing the notification schedule.
 * Changing the schedule always resets to pending with a fresh idempotency key.
 */
export function applyNotifyScheduleChange(notifyFields, reminderId, now = new Date()) {
  if (!notifyFields.emailNotifyEnabled) {
    return {
      emailNotifyEnabled: false,
      notifyAtUtc: null,
      notifyTimeZone: null,
      notifyLocalDate: null,
      notifyLocalTime: null,
      notifyStatus: null,
      notifyStatusUpdatedAt: now,
      notifySubmittedAt: null,
      notifyFailedAt: null,
      notifyClaimedAt: null,
      notifyNextAttemptAt: null,
      notifyAttemptCount: 0,
      notifyError: null,
      notifyProviderId: null,
      notifyIdempotencyKey: null,
    }
  }

  const notifyAtUtc = notifyFields.notifyAtUtc
  return {
    ...notifyFields,
    notifyStatus: NOTIFY_STATUS.PENDING,
    notifyStatusUpdatedAt: now,
    notifySubmittedAt: null,
    notifyFailedAt: null,
    notifyClaimedAt: null,
    notifyNextAttemptAt: null,
    notifyAttemptCount: 0,
    notifyError: null,
    notifyProviderId: null,
    notifyIdempotencyKey: reminderId
      ? buildNotifyIdempotencyKey(reminderId, notifyAtUtc)
      : null,
  }
}

export function dueReminderQuery(now = new Date(), staleMs = STALE_PROCESSING_MS) {
  const nowIso = now.toISOString()
  const staleIso = new Date(now.getTime() - staleMs).toISOString()
  return {
    emailNotifyEnabled: true,
    completed: false,
    notifyAtUtc: { $lte: nowIso },
    $or: [
      { notifyStatus: NOTIFY_STATUS.PENDING },
      {
        notifyStatus: NOTIFY_STATUS.RETRYING,
        notifyNextAttemptAt: { $lte: nowIso },
      },
      {
        notifyStatus: NOTIFY_STATUS.PROCESSING,
        notifyClaimedAt: { $lte: staleIso },
      },
    ],
  }
}

/**
 * Atomically claim the next due reminder → processing.
 * Returns the claimed document or null.
 */
export async function claimNextDueReminder(
  remindersCollection,
  now = new Date(),
  staleMs = STALE_PROCESSING_MS,
) {
  const result = await remindersCollection.findOneAndUpdate(
    dueReminderQuery(now, staleMs),
    {
      $set: {
        notifyStatus: NOTIFY_STATUS.PROCESSING,
        notifyStatusUpdatedAt: now,
        notifyClaimedAt: now,
      },
    },
    {
      sort: { notifyAtUtc: 1 },
      returnDocument: 'after',
    },
  )
  const doc = result?.value ?? result
  if (!doc || !doc._id) return null
  return doc
}

async function markSubmitted(remindersCollection, id, providerId, now) {
  await remindersCollection.updateOne(
    { _id: id },
    {
      $set: {
        notifyStatus: NOTIFY_STATUS.SUBMITTED,
        notifyStatusUpdatedAt: now,
        notifySubmittedAt: now,
        notifyFailedAt: null,
        notifyNextAttemptAt: null,
        notifyClaimedAt: null,
        notifyError: null,
        notifyProviderId: providerId || null,
      },
    },
  )
}

async function markFailed(remindersCollection, id, message, now, attemptCount) {
  await remindersCollection.updateOne(
    { _id: id },
    {
      $set: {
        notifyStatus: NOTIFY_STATUS.FAILED,
        notifyStatusUpdatedAt: now,
        notifyFailedAt: now,
        notifyNextAttemptAt: null,
        notifyClaimedAt: null,
        notifyAttemptCount: attemptCount,
        notifyError: safeNotifyError(message),
      },
    },
  )
}

async function markRetrying(
  remindersCollection,
  id,
  message,
  now,
  attemptCount,
  nextAttemptAt,
) {
  await remindersCollection.updateOne(
    { _id: id },
    {
      $set: {
        notifyStatus: NOTIFY_STATUS.RETRYING,
        notifyStatusUpdatedAt: now,
        notifyFailedAt: null,
        notifyClaimedAt: null,
        notifyAttemptCount: attemptCount,
        notifyNextAttemptAt: nextAttemptAt,
        notifyError: safeNotifyError(message),
      },
    },
  )
}

async function markSkipped(remindersCollection, id, message, now) {
  await remindersCollection.updateOne(
    { _id: id },
    {
      $set: {
        notifyStatus: NOTIFY_STATUS.SKIPPED,
        notifyStatusUpdatedAt: now,
        notifyClaimedAt: null,
        notifyNextAttemptAt: null,
        notifyError: safeNotifyError(message),
      },
    },
  )
}

function accountReminderEmailsEnabled(owner) {
  if (!owner) return false
  return owner.reminderEmailsEnabled !== false
}

function accountEmailsEnabledAt(owner) {
  if (!owner?.reminderEmailsEnabledAt) return null
  const ms = Date.parse(owner.reminderEmailsEnabledAt)
  if (!Number.isNaN(ms)) return new Date(ms)
  if (owner.reminderEmailsEnabledAt instanceof Date) {
    return owner.reminderEmailsEnabledAt
  }
  return null
}

/**
 * Process up to `limit` due reminders.
 * `sendEmail(...)` returns `{ ok: true, id }` or
 * `{ ok: false, error, name?, statusCode?, retryAfterSeconds?, retryable? }`.
 */
export async function processDueReminderEmails({
  remindersCollection,
  usersCollection,
  sendEmail,
  emailFrom,
  now = new Date(),
  limit = 25,
  staleMs = STALE_PROCESSING_MS,
  maxAttempts = MAX_NOTIFY_ATTEMPTS,
}) {
  const outcomes = []

  for (let i = 0; i < limit; i += 1) {
    const claimed = await claimNextDueReminder(remindersCollection, now, staleMs)
    if (!claimed) break

    const id = claimed._id
    try {
      const fresh = await remindersCollection.findOne({ _id: id })
      if (!fresh) {
        outcomes.push({ id: String(id), status: 'skipped_deleted' })
        continue
      }
      if (fresh.completed) {
        await markSkipped(
          remindersCollection,
          id,
          'Reminder was completed before the email was sent',
          now,
        )
        outcomes.push({ id: String(id), status: NOTIFY_STATUS.SKIPPED })
        continue
      }
      if (!fresh.emailNotifyEnabled) {
        await markSkipped(
          remindersCollection,
          id,
          'Reminder email notify was disabled before send',
          now,
        )
        outcomes.push({ id: String(id), status: NOTIFY_STATUS.SKIPPED })
        continue
      }

      const owner = await usersCollection.findOne({ _id: fresh.userId })
      if (!accountReminderEmailsEnabled(owner)) {
        await markSkipped(
          remindersCollection,
          id,
          'Account reminder emails are disabled',
          now,
        )
        outcomes.push({ id: String(id), status: NOTIFY_STATUS.SKIPPED })
        continue
      }

      const enabledAt = accountEmailsEnabledAt(owner)
      if (
        enabledAt &&
        fresh.notifyAtUtc &&
        Date.parse(fresh.notifyAtUtc) < enabledAt.getTime()
      ) {
        await markSkipped(
          remindersCollection,
          id,
          'Skipped: notification time was before reminder emails were re-enabled',
          now,
        )
        outcomes.push({ id: String(id), status: NOTIFY_STATUS.SKIPPED })
        continue
      }

      const to = typeof owner?.email === 'string' ? owner.email.trim() : ''
      if (!to) {
        await markFailed(
          remindersCollection,
          id,
          'Owner account email is missing',
          now,
          Number(fresh.notifyAttemptCount) || 0,
        )
        outcomes.push({ id: String(id), status: NOTIFY_STATUS.FAILED })
        continue
      }

      const priorAttempts = Number(fresh.notifyAttemptCount) || 0
      if (priorAttempts >= maxAttempts) {
        await markFailed(
          remindersCollection,
          id,
          fresh.notifyError || 'Maximum send attempts reached',
          now,
          priorAttempts,
        )
        outcomes.push({ id: String(id), status: NOTIFY_STATUS.FAILED })
        continue
      }

      const idempotencyKey =
        fresh.notifyIdempotencyKey ||
        buildNotifyIdempotencyKey(id, fresh.notifyAtUtc)

      if (!fresh.notifyIdempotencyKey) {
        await remindersCollection.updateOne(
          { _id: id },
          { $set: { notifyIdempotencyKey: idempotencyKey } },
        )
      }

      const attemptCount = priorAttempts + 1
      await remindersCollection.updateOne(
        { _id: id },
        { $set: { notifyAttemptCount: attemptCount } },
      )

      const subject = `Reminder: ${fresh.reason || 'PeoplesNote'}`
      const text = [
        `PeoplesNote reminder`,
        ``,
        `Reason: ${fresh.reason || '(none)'}`,
        `Due: ${fresh.dueDate || '(none)'}`,
        `Scheduled notify (UTC): ${fresh.notifyAtUtc || '(none)'}`,
        ``,
        `This message was submitted by the PeoplesNote scheduler.`,
        `Provider acceptance does not confirm inbox delivery.`,
      ].join('\n')

      let result
      try {
        result = await sendEmail({
          from: emailFrom,
          to,
          subject,
          text,
          idempotencyKey,
        })
      } catch (err) {
        result = {
          ok: false,
          error: err?.message || String(err),
          retryable: true,
        }
      }

      if (result?.ok) {
        await markSubmitted(remindersCollection, id, result.id, now)
        outcomes.push({
          id: String(id),
          status: NOTIFY_STATUS.SUBMITTED,
          providerId: result.id || null,
          attemptCount,
        })
        continue
      }

      const classified = classifyProviderFailure(result || {})
      if (classified.retryable && attemptCount < maxAttempts) {
        const delaySec = computeRetryDelaySeconds(
          attemptCount,
          classified.retryAfterSeconds,
        )
        const nextAttemptAt = new Date(now.getTime() + delaySec * 1000).toISOString()
        await markRetrying(
          remindersCollection,
          id,
          classified.message,
          now,
          attemptCount,
          nextAttemptAt,
        )
        outcomes.push({
          id: String(id),
          status: NOTIFY_STATUS.RETRYING,
          attemptCount,
          nextAttemptAt,
        })
        continue
      }

      await markFailed(
        remindersCollection,
        id,
        classified.message || 'Email provider rejected the request',
        now,
        attemptCount,
      )
      outcomes.push({
        id: String(id),
        status: NOTIFY_STATUS.FAILED,
        attemptCount,
      })
    } catch (err) {
      const attempts = Number(claimed.notifyAttemptCount) || 0
      await markFailed(remindersCollection, id, err, now, attempts)
      outcomes.push({ id: String(id), status: NOTIFY_STATUS.FAILED })
    }
  }

  return outcomes
}

/**
 * Starts a one-minute loop in this process. Returns a stop() function.
 * Skips a tick if the previous run is still in progress.
 */
export function startReminderEmailLoop({
  remindersCollection,
  usersCollection,
  sendEmail,
  emailFrom,
  isConfigured,
  intervalMs = 60_000,
  log = console,
}) {
  let stopped = false
  let running = false

  async function tick() {
    if (stopped || running) return
    if (typeof isConfigured === 'function' && !isConfigured()) return

    running = true
    try {
      const outcomes = await processDueReminderEmails({
        remindersCollection,
        usersCollection,
        sendEmail,
        emailFrom,
      })
      if (outcomes.length > 0) {
        log.log(
          `[reminder-email] processed ${outcomes.length}:`,
          outcomes.map((o) => `${o.id}:${o.status}`).join(', '),
        )
      }
    } catch (err) {
      log.error('[reminder-email] loop failed:', err.message || err)
    } finally {
      running = false
    }
  }

  const timer = setInterval(tick, intervalMs)
  const boot = setTimeout(tick, 5_000)

  return function stopReminderEmailLoop() {
    stopped = true
    clearInterval(timer)
    clearTimeout(boot)
  }
}

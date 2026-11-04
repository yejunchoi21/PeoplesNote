/**
 * In-process reminder email scheduler (learning-project style).
 *
 * Behavior
 * - Once per minute the Express process claims due, enabled, incomplete
 *   reminders with notifyStatus "pending" and sends via the email provider.
 * - Overlapping timer ticks in this process are skipped (run lock).
 * - Each reminder is claimed atomically (pending → processing) so two workers
 *   in the same DB cannot both send the same pending row.
 *
 * Failed / interrupted sends (no automatic retries in this milestone)
 * - "failed": stays failed. The minute loop will not pick it up again.
 * - "processing" after a crash / hard kill: stays processing. It is not
 *   reclaimed automatically, so it will not be resent until an operator
 *   resets notifyStatus to "pending" (or the schedule is changed, which
 *   resets status — see applyNotifyScheduleChange).
 * - Provider acceptance sets status to "submitted" only (not "delivered").
 *
 * Resend idempotency limits
 * - We pass Idempotency-Key = notifyIdempotencyKey (pn-reminder/<id>/<notifyAtUtc>).
 * - Resend dedupes the same key for ~24 hours with the same payload.
 * - Same key + different payload → 409; keys expire after 24h so a later
 *   manual retry with the same key may send again. This is a safety net for
 *   duplicate in-flight requests, not a substitute for our DB claim.
 */

export const NOTIFY_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUBMITTED: 'submitted',
  FAILED: 'failed',
}

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
    notifyError: null,
    notifyProviderId: null,
    notifyIdempotencyKey: reminderId
      ? buildNotifyIdempotencyKey(reminderId, notifyAtUtc)
      : null,
  }
}

export function dueReminderQuery(now = new Date()) {
  return {
    emailNotifyEnabled: true,
    completed: false,
    notifyStatus: NOTIFY_STATUS.PENDING,
    notifyAtUtc: { $lte: now.toISOString() },
  }
}

/**
 * Atomically claim the next due reminder (pending → processing).
 * Returns the claimed document or null.
 */
export async function claimNextDueReminder(remindersCollection, now = new Date()) {
  const result = await remindersCollection.findOneAndUpdate(
    dueReminderQuery(now),
    {
      $set: {
        notifyStatus: NOTIFY_STATUS.PROCESSING,
        notifyStatusUpdatedAt: now,
        notifyClaimedAt: now,
        notifyError: null,
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

async function markFailed(remindersCollection, id, message, now) {
  await remindersCollection.updateOne(
    { _id: id },
    {
      $set: {
        notifyStatus: NOTIFY_STATUS.FAILED,
        notifyStatusUpdatedAt: now,
        notifyFailedAt: now,
        notifyError: safeNotifyError(message),
      },
    },
  )
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
        notifyError: null,
        notifyProviderId: providerId || null,
      },
    },
  )
}

async function clearNotifyAfterSkip(remindersCollection, id, now) {
  // Completed / disabled after claim — do not send; clear active send state.
  await remindersCollection.updateOne(
    { _id: id },
    {
      $set: {
        notifyStatus: null,
        notifyStatusUpdatedAt: now,
        notifyClaimedAt: null,
        notifyError: null,
      },
    },
  )
}

/**
 * Process up to `limit` due reminders.
 * `sendEmail({ to, subject, text, idempotencyKey, from })` must return
 * `{ ok: true, id }` or `{ ok: false, error }` and must not throw for
 * provider soft failures (may throw for unexpected errors).
 */
export async function processDueReminderEmails({
  remindersCollection,
  usersCollection,
  sendEmail,
  emailFrom,
  now = new Date(),
  limit = 25,
}) {
  const outcomes = []

  for (let i = 0; i < limit; i += 1) {
    const claimed = await claimNextDueReminder(remindersCollection, now)
    if (!claimed) break

    const id = claimed._id
    try {
      // Re-read so we honor complete / disable / delete that happened after claim.
      const fresh = await remindersCollection.findOne({ _id: id })
      if (!fresh) {
        outcomes.push({ id: String(id), status: 'skipped_deleted' })
        continue
      }
      if (fresh.completed || !fresh.emailNotifyEnabled) {
        await clearNotifyAfterSkip(remindersCollection, id, now)
        outcomes.push({
          id: String(id),
          status: fresh.completed ? 'skipped_completed' : 'skipped_disabled',
        })
        continue
      }

      const owner = await usersCollection.findOne({ _id: fresh.userId })
      const to = typeof owner?.email === 'string' ? owner.email.trim() : ''
      if (!to) {
        await markFailed(
          remindersCollection,
          id,
          'Owner account email is missing',
          now,
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

      const result = await sendEmail({
        from: emailFrom,
        to,
        subject,
        text,
        idempotencyKey,
      })

      if (!result?.ok) {
        await markFailed(
          remindersCollection,
          id,
          result?.error || 'Email provider rejected the request',
          now,
        )
        outcomes.push({ id: String(id), status: NOTIFY_STATUS.FAILED })
        continue
      }

      await markSubmitted(remindersCollection, id, result.id, now)
      outcomes.push({
        id: String(id),
        status: NOTIFY_STATUS.SUBMITTED,
        providerId: result.id || null,
      })
    } catch (err) {
      await markFailed(remindersCollection, id, err, now)
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
  // First pass shortly after boot so local testing does not wait a full minute.
  const boot = setTimeout(tick, 5_000)

  return function stopReminderEmailLoop() {
    stopped = true
    clearInterval(timer)
    clearTimeout(boot)
  }
}

/**
 * Shared validation for optional email notification fields on reminders.
 * Existing reminders default to notifications disabled.
 */

const IANA_TIME_ZONE_RE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/

/** Loose check that a string looks like a real IANA zone id. */
export function isLikelyIanaTimeZone(value) {
  if (typeof value !== 'string') return false
  const tz = value.trim()
  if (!tz || tz.length > 64) return false
  if (tz === 'UTC') return true
  if (!IANA_TIME_ZONE_RE.test(tz)) return false
  try {
    // Throws RangeError for unknown zones in modern Node/Intl.
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function isValidNotifyDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
}

export function isValidNotifyTime(value) {
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value.trim())
}

export function isValidUtcIso(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  const ms = Date.parse(value)
  return !Number.isNaN(ms)
}

/**
 * Convert a wall-clock date+time in an IANA zone to a UTC ISO string.
 * Uses Intl iteration (no third-party timezone DB required).
 */
export function zonedLocalToUtcIso(dateStr, timeStr, timeZone) {
  const date = dateStr.trim()
  const time = timeStr.trim()
  const tz = timeZone.trim()
  if (!isValidNotifyDate(date) || !isValidNotifyTime(time) || !isLikelyIanaTimeZone(tz)) {
    return null
  }

  const [y, mo, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > 31 ||
    hh < 0 ||
    hh > 23 ||
    mm < 0 ||
    mm > 59
  ) {
    return null
  }

  const desiredAsUtc = Date.UTC(y, mo - 1, d, hh, mm, 0)
  let utcGuess = desiredAsUtc

  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utcGuess))

    const get = (type) => Number(parts.find((p) => p.type === type)?.value)
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    )
    utcGuess += desiredAsUtc - asUtc
  }

  return new Date(utcGuess).toISOString()
}

/**
 * Normalize notification fields from a request body.
 * Returns { ok: true, value } or { ok: false, message }.
 *
 * When emailNotifyEnabled is false/omitted → disabled defaults (preserves old rows).
 * When true → requires local date/time/zone OR a valid notifyAtUtc + zone.
 */
export function normalizeNotificationFields(body = {}) {
  const enabled = Boolean(body.emailNotifyEnabled)

  if (!enabled) {
    return {
      ok: true,
      value: {
        emailNotifyEnabled: false,
        notifyAtUtc: null,
        notifyTimeZone: null,
        notifyLocalDate: null,
        notifyLocalTime: null,
      },
    }
  }

  const notifyTimeZone =
    typeof body.notifyTimeZone === 'string' ? body.notifyTimeZone.trim() : ''
  if (!isLikelyIanaTimeZone(notifyTimeZone)) {
    return {
      ok: false,
      message: 'A valid IANA time zone is required when email notify is enabled',
    }
  }

  let notifyLocalDate =
    typeof body.notifyLocalDate === 'string' ? body.notifyLocalDate.trim() : ''
  let notifyLocalTime =
    typeof body.notifyLocalTime === 'string' ? body.notifyLocalTime.trim() : ''
  let notifyAtUtc =
    typeof body.notifyAtUtc === 'string' ? body.notifyAtUtc.trim() : ''

  if (notifyLocalDate || notifyLocalTime) {
    if (!isValidNotifyDate(notifyLocalDate) || !isValidNotifyTime(notifyLocalTime)) {
      return {
        ok: false,
        message:
          'Notification date (YYYY-MM-DD) and time (HH:MM) are required when email notify is enabled',
      }
    }
    const computed = zonedLocalToUtcIso(
      notifyLocalDate,
      notifyLocalTime,
      notifyTimeZone,
    )
    if (!computed) {
      return {
        ok: false,
        message: 'Could not convert notification date/time to UTC',
      }
    }
    notifyAtUtc = computed
  } else if (!isValidUtcIso(notifyAtUtc)) {
    return {
      ok: false,
      message:
        'Provide notifyAtUtc or notifyLocalDate + notifyLocalTime when email notify is enabled',
    }
  }

  return {
    ok: true,
    value: {
      emailNotifyEnabled: true,
      notifyAtUtc,
      notifyTimeZone,
      notifyLocalDate: notifyLocalDate || null,
      notifyLocalTime: notifyLocalTime || null,
    },
  }
}

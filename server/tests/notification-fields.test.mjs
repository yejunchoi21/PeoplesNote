import {
  isLikelyIanaTimeZone,
  isValidNotifyDate,
  isValidNotifyTime,
  normalizeNotificationFields,
  zonedLocalToUtcIso,
} from '../notificationFields.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(isValidNotifyDate('2026-11-03'), 'valid date')
assert(!isValidNotifyDate('11/03/2026'), 'reject slash date')
assert(isValidNotifyTime('09:30'), 'valid time')
assert(!isValidNotifyTime('9:30'), 'reject single-digit hour')

assert(isLikelyIanaTimeZone('America/New_York'), 'valid IANA zone')
assert(isLikelyIanaTimeZone('UTC'), 'UTC allowed')
assert(!isLikelyIanaTimeZone('Not/AZone'), 'reject fake zone')
assert(!isLikelyIanaTimeZone(''), 'reject empty zone')

const disabled = normalizeNotificationFields({})
assert(disabled.ok, 'missing notify fields defaults to disabled')
assert(disabled.value.emailNotifyEnabled === false, 'disabled by default')
assert(disabled.value.notifyAtUtc === null, 'no utc when disabled')

const disabledExplicit = normalizeNotificationFields({
  emailNotifyEnabled: false,
  notifyLocalDate: '2026-11-03',
  notifyLocalTime: '10:00',
  notifyTimeZone: 'UTC',
})
assert(
  disabledExplicit.value.emailNotifyEnabled === false,
  'explicit false stays disabled',
)
assert(
  disabledExplicit.value.notifyAtUtc === null,
  'disabled clears notify fields',
)

const missingZone = normalizeNotificationFields({
  emailNotifyEnabled: true,
  notifyLocalDate: '2026-11-03',
  notifyLocalTime: '10:00',
})
assert(!missingZone.ok, 'enabled requires timezone')

const missingWhen = normalizeNotificationFields({
  emailNotifyEnabled: true,
  notifyTimeZone: 'UTC',
})
assert(!missingWhen.ok, 'enabled requires date/time or utc')

const okLocal = normalizeNotificationFields({
  emailNotifyEnabled: true,
  notifyLocalDate: '2026-11-03',
  notifyLocalTime: '15:30',
  notifyTimeZone: 'UTC',
})
assert(okLocal.ok, 'enabled with local fields succeeds')
assert(okLocal.value.emailNotifyEnabled === true, 'enabled flag set')
assert(
  okLocal.value.notifyAtUtc === '2026-11-03T15:30:00.000Z',
  'UTC conversion for UTC zone',
)
assert(okLocal.value.notifyTimeZone === 'UTC', 'zone stored')

const ny = zonedLocalToUtcIso('2026-01-15', '12:00', 'America/New_York')
assert(typeof ny === 'string' && ny.endsWith('Z'), 'NY conversion returns ISO')
// Eastern Standard Time in January is UTC-5 → 17:00Z
assert(ny === '2026-01-15T17:00:00.000Z', 'NY winter offset applied')

console.log('notification-fields tests passed')

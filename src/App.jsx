import { useEffect, useState } from 'react'
import { api, setCsrfToken } from './api'
import AuthScreen from './AuthScreen'
import './App.css'

const CONTACTS_KEY = 'peoplesnote-contacts'
const CONTACTS_BACKUP_KEY = 'peoplesnote-contacts-backup'
const REMINDERS_KEY = 'peoplesnote-reminders'
const REMINDERS_BACKUP_KEY = 'peoplesnote-reminders-backup'
const FOLLOW_UP_OPTIONS = [7, 30, 60]
const API_CONTACTS = '/api/contacts'
const API_REMINDERS = '/api/reminders'

/** Compare ids safely (Mongo string ids vs older numeric local ids). */
function sameId(a, b) {
  return String(a) === String(b)
}

const NAV_ITEMS = [
  { id: 'people', label: 'People' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'tags', label: 'Tags' },
]

const EMPTY_FORM = {
  name: '',
  company: '',
  email: '',
  phone: '',
  tags: '',
  notes: '',
  followUpDays: '30',
}

const EMPTY_REMINDER_FORM = {
  reason: '',
  dueDate: '',
}

function todayISO() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + days)
  const yy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function getContactDueDate(contact) {
  if (!contact.lastContacted) return todayISO()
  const days = FOLLOW_UP_OPTIONS.includes(contact.followUpDays)
    ? contact.followUpDays
    : 30
  return addDays(contact.lastContacted, days)
}

function getContactDueStatus(contact) {
  const due = getContactDueDate(contact)
  const today = todayISO()
  if (due < today) return 'overdue'
  if (due === today) return 'due-today'
  return 'upcoming'
}

/** Bucket a reminder by its dueDate vs today. */
function getReminderStatus(reminder) {
  const today = todayISO()
  if (reminder.dueDate < today) return 'overdue'
  if (reminder.dueDate === today) return 'due-today'
  return 'upcoming'
}

function dueLabel(status) {
  if (status === 'overdue') return 'Overdue'
  if (status === 'due-today') return 'Today'
  return 'Upcoming'
}

function normalizeContact(contact) {
  const followUpDays = FOLLOW_UP_OPTIONS.includes(contact.followUpDays)
    ? contact.followUpDays
    : 30
  return {
    ...contact,
    id: contact.id ?? contact._id,
    lastContacted: contact.lastContacted || '',
    tags: Array.isArray(contact.tags) ? contact.tags : [],
    followUpDays,
  }
}

/**
 * Snapshot existing local contacts once. Never auto-import into Mongo,
 * and never delete the original key.
 */
function ensureContactsBackup() {
  try {
    if (localStorage.getItem(CONTACTS_BACKUP_KEY)) return
    const raw = localStorage.getItem(CONTACTS_KEY)
    if (raw) localStorage.setItem(CONTACTS_BACKUP_KEY, raw)
  } catch {
    // Ignore quota / private-mode failures — API is source of truth now.
  }
}

/** Read-only local contacts for reminder name lookup (not shown in People). */
function loadBackupContacts() {
  try {
    const raw =
      localStorage.getItem(CONTACTS_BACKUP_KEY) ||
      localStorage.getItem(CONTACTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(normalizeContact) : []
  } catch {
    return []
  }
}

function normalizeReminder(reminder) {
  return {
    ...reminder,
    id: reminder.id ?? reminder._id,
    contactId: String(reminder.contactId),
    reason: reminder.reason || '',
    dueDate: reminder.dueDate || '',
    completed: Boolean(reminder.completed),
  }
}

function readLocalReminders(key) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r) =>
        r &&
        typeof r.id !== 'undefined' &&
        typeof r.contactId !== 'undefined' &&
        typeof r.reason === 'string' &&
        typeof r.dueDate === 'string',
    )
  } catch {
    return []
  }
}

/**
 * Snapshot existing local reminders once. Never auto-import into Mongo,
 * and never delete the original key.
 */
function ensureRemindersBackup() {
  try {
    if (localStorage.getItem(REMINDERS_BACKUP_KEY)) return
    const raw = localStorage.getItem(REMINDERS_KEY)
    if (raw) localStorage.setItem(REMINDERS_BACKUP_KEY, raw)
  } catch {
    // Ignore quota / private-mode failures.
  }
}

function loadBackupReminders() {
  ensureRemindersBackup()
  const fromBackup = readLocalReminders(REMINDERS_BACKUP_KEY)
  if (fromBackup.length > 0) return fromBackup
  return readLocalReminders(REMINDERS_KEY)
}

function parseTags(tagsText) {
  return tagsText
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function initials(name) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function formatLastContacted(lastContacted) {
  return lastContacted ? lastContacted : 'Never contacted'
}

function sortByDueDate(a, b) {
  return a.dueDate.localeCompare(b.dueDate)
}

/**
 * Build tag stats from contacts: trim, skip blanks, merge case-insensitively.
 * Counts update automatically whenever the contacts array changes.
 */
function buildTagStats(contactList) {
  const map = new Map()

  for (const contact of contactList) {
    const seenOnContact = new Set()
    for (const raw of contact.tags || []) {
      const label = String(raw).trim()
      if (!label) continue
      const key = label.toLowerCase()
      // Same tag twice on one person (e.g. "Work" and "work") counts once.
      if (seenOnContact.has(key)) continue
      seenOnContact.add(key)

      const existing = map.get(key)
      if (existing) {
        existing.count += 1
      } else {
        map.set(key, { key, label, count: 1 })
      }
    }
  }

  return [...map.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  )
}

function contactHasTag(contact, tagKey) {
  return (contact.tags || []).some(
    (tag) => String(tag).trim().toLowerCase() === tagKey,
  )
}

function App() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [loggingOut, setLoggingOut] = useState(false)

  // People list comes from Mongo via the API (starts empty until fetch).
  const [contacts, setContacts] = useState([])
  const [backupContacts] = useState(() => {
    ensureContactsBackup()
    return loadBackupContacts()
  })
  const [reminders, setReminders] = useState([])
  const [backupReminders] = useState(() => loadBackupReminders())
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [selectedReminderId, setSelectedReminderId] = useState(null)
  const [activeNav, setActiveNav] = useState('people')
  const [formMode, setFormMode] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [reminderForm, setReminderForm] = useState(EMPTY_REMINDER_FORM)
  const [contactsLoading, setContactsLoading] = useState(false)
  const [contactsError, setContactsError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [savingContact, setSavingContact] = useState(false)
  const [deletingContact, setDeletingContact] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [remindersLoading, setRemindersLoading] = useState(false)
  const [remindersError, setRemindersError] = useState('')
  const [reminderSaveError, setReminderSaveError] = useState('')
  const [savingReminder, setSavingReminder] = useState(false)
  const [reminderBusyId, setReminderBusyId] = useState(null)
  const [importingReminders, setImportingReminders] = useState(false)
  const [importReport, setImportReport] = useState(null)
  // Normalized (lowercase) tag key, or null when browsing all tags.
  const [selectedTagKey, setSelectedTagKey] = useState(null)

  function clearAccountState() {
    setContacts([])
    setReminders([])
    setSearchQuery('')
    setSelectedId(null)
    setSelectedReminderId(null)
    setActiveNav('people')
    setFormMode(null)
    setForm(EMPTY_FORM)
    setReminderForm(EMPTY_REMINDER_FORM)
    setContactsError('')
    setSaveError('')
    setDeleteError('')
    setRemindersError('')
    setReminderSaveError('')
    setImportReport(null)
    setSelectedTagKey(null)
    setContactsLoading(false)
    setRemindersLoading(false)
  }

  // Restore session (HttpOnly cookie) — never reads tokens from localStorage.
  useEffect(() => {
    let cancelled = false
    async function restoreSession() {
      setAuthLoading(true)
      try {
        const res = await api('/api/auth/me')
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (data.csrfToken) setCsrfToken(data.csrfToken)
        setUser(data.user || null)
      } catch {
        if (!cancelled) setUser(null)
      } finally {
        if (!cancelled) setAuthLoading(false)
      }
    }
    restoreSession()
    return () => {
      cancelled = true
    }
  }, [])

  // Load contacts + reminders only after login.
  useEffect(() => {
    if (!user) return undefined
    let cancelled = false

    async function fetchContacts() {
      setContactsLoading(true)
      setContactsError('')
      try {
        const res = await api(API_CONTACTS)
        if (res.status === 401) {
          clearAccountState()
          setUser(null)
          return
        }
        if (!res.ok) {
          throw new Error('Could not load contacts from the server.')
        }
        const data = await res.json()
        if (cancelled) return
        const list = Array.isArray(data) ? data.map(normalizeContact) : []
        setContacts(list)
        setSelectedId((current) => current ?? list[0]?.id ?? null)
      } catch (err) {
        if (cancelled) return
        setContactsError(
          err.message || 'Could not load contacts from the server.',
        )
        setContacts([])
      } finally {
        if (!cancelled) setContactsLoading(false)
      }
    }

    async function fetchReminders() {
      setRemindersLoading(true)
      setRemindersError('')
      try {
        const res = await api(API_REMINDERS)
        if (res.status === 401) {
          clearAccountState()
          setUser(null)
          return
        }
        if (!res.ok) {
          throw new Error('Could not load reminders from the server.')
        }
        const data = await res.json()
        if (cancelled) return
        const list = Array.isArray(data) ? data.map(normalizeReminder) : []
        setReminders(list)
      } catch (err) {
        if (cancelled) return
        setRemindersError(
          err.message || 'Could not load reminders from the server.',
        )
        setReminders([])
      } finally {
        if (!cancelled) setRemindersLoading(false)
      }
    }

    fetchContacts()
    fetchReminders()
    return () => {
      cancelled = true
    }
  }, [user])

  async function handleLogout() {
    setLoggingOut(true)
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } catch {
      // Still clear local state even if the network call fails.
    } finally {
      setCsrfToken('')
      clearAccountState()
      setUser(null)
      setLoggingOut(false)
    }
  }

  if (authLoading) {
    return (
      <div className="auth-screen">
        <p className="status-banner status-banner--loading">Loading…</p>
      </div>
    )
  }

  if (!user) {
    return (
      <AuthScreen
        onAuthenticated={(nextUser) => {
          clearAccountState()
          setUser(nextUser)
        }}
      />
    )
  }

  const filteredContacts = contacts.filter((contact) => {
    const q = searchQuery.toLowerCase().trim()
    if (!q) return true
    return (
      contact.name.toLowerCase().includes(q) ||
      contact.company.toLowerCase().includes(q) ||
      contact.tags.some((tag) => tag.toLowerCase().includes(q))
    )
  })

  // Open reminders only — completed ones stay saved but leave the queues.
  const openReminders = reminders
    .filter((r) => !r.completed)
    .sort(sortByDueDate)

  const overdueReminders = openReminders.filter(
    (r) => getReminderStatus(r) === 'overdue',
  )
  const todayReminders = openReminders.filter(
    (r) => getReminderStatus(r) === 'due-today',
  )
  const upcomingReminders = openReminders.filter(
    (r) => getReminderStatus(r) === 'upcoming',
  )

  const needsAttentionCount = overdueReminders.length + todayReminders.length

  // Derived from current contacts — stays in sync on add / edit / delete.
  const tagStats = buildTagStats(contacts)
  const selectedTag =
    tagStats.find((tag) => tag.key === selectedTagKey) || null
  const taggedContacts = selectedTagKey
    ? contacts
        .filter((contact) => contactHasTag(contact, selectedTagKey))
        .sort((a, b) => a.name.localeCompare(b.name))
    : []

  const selectedContact =
    contacts.find((c) => sameId(c.id, selectedId)) || null

  const selectedReminder =
    openReminders.find((r) => sameId(r.id, selectedReminderId)) || null

  const selectedReminderContact = selectedReminder
    ? contacts.find((c) => sameId(c.id, selectedReminder.contactId)) ||
      backupContacts.find((c) => sameId(c.id, selectedReminder.contactId)) ||
      null
    : null

  const contactOpenReminders = selectedContact
    ? openReminders.filter((r) => sameId(r.contactId, selectedContact.id))
    : []

  const selectedDue = selectedContact
    ? {
        date: getContactDueDate(selectedContact),
        status: getContactDueStatus(selectedContact),
      }
    : null

  /** Resolve names from API contacts first, then local backup (for old reminders). */
  function contactName(contactId) {
    const fromApi = contacts.find((c) => sameId(c.id, contactId))
    if (fromApi) return fromApi.name
    const fromBackup = backupContacts.find((c) => sameId(c.id, contactId))
    if (fromBackup) return fromBackup.name
    return 'Unknown person'
  }

  function openAddForm() {
    setActiveNav('people')
    setForm(EMPTY_FORM)
    setFormMode('add')
    setSelectedReminderId(null)
    setSaveError('')
  }

  function openEditForm() {
    if (!selectedContact) return
    setForm({
      name: selectedContact.name,
      company: selectedContact.company,
      email: selectedContact.email,
      phone: selectedContact.phone,
      tags: selectedContact.tags.join(', '),
      notes: selectedContact.notes,
      followUpDays: String(selectedContact.followUpDays),
    })
    setFormMode('edit')
    setSaveError('')
    setDeleteError('')
  }

  function openReminderForm() {
    if (!selectedContact) return
    setReminderForm({
      reason: '',
      dueDate: todayISO(),
    })
    setFormMode('reminder')
    setReminderSaveError('')
  }

  function cancelForm() {
    setFormMode(null)
    setForm(EMPTY_FORM)
    setReminderForm(EMPTY_REMINDER_FORM)
    setSaveError('')
    setReminderSaveError('')
  }

  function handleFormChange(e) {
    const { name, value } = e.target
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  function handleReminderFormChange(e) {
    const { name, value } = e.target
    setReminderForm((prev) => ({ ...prev, [name]: value }))
  }

  async function handleFormSubmit(e) {
    e.preventDefault()
    const name = form.name.trim()
    if (!name) {
      setSaveError('Name is required.')
      return
    }

    const followUpDays = Number(form.followUpDays)
    const payload = {
      name,
      company: form.company.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      tags: parseTags(form.tags),
      notes: form.notes.trim(),
      followUpDays: FOLLOW_UP_OPTIONS.includes(followUpDays)
        ? followUpDays
        : 30,
    }

    if (formMode === 'add') {
      setSavingContact(true)
      setSaveError('')
      try {
        const res = await api(API_CONTACTS, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            lastContacted: todayISO(),
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(data.message || 'Could not save contact.')
        }
        // Only add to the list after the server confirms the save.
        const saved = normalizeContact(data)
        setContacts((prev) =>
          [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)),
        )
        setSelectedId(saved.id)
        setFormMode(null)
        setForm(EMPTY_FORM)
      } catch (err) {
        setSaveError(err.message || 'Could not save contact.')
      } finally {
        setSavingContact(false)
      }
      return
    }

    if (formMode === 'edit' && selectedContact) {
      setSavingContact(true)
      setSaveError('')
      try {
        // Keep lastContacted / reminders untouched — only profile fields change.
        const res = await api(`${API_CONTACTS}/${selectedContact.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            lastContacted: selectedContact.lastContacted || '',
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(data.message || 'Could not update contact.')
        }
        const updated = normalizeContact(data)
        setContacts((prev) =>
          prev
            .map((c) => (sameId(c.id, updated.id) ? updated : c))
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
        setSelectedId(updated.id)
        setFormMode(null)
        setForm(EMPTY_FORM)
      } catch (err) {
        setSaveError(err.message || 'Could not update contact.')
      } finally {
        setSavingContact(false)
      }
    }
  }

  async function handleReminderSubmit(e) {
    e.preventDefault()
    if (!selectedContact) return
    const reason = reminderForm.reason.trim()
    const dueDate = reminderForm.dueDate
    if (!reason || !dueDate) {
      setReminderSaveError('Reason and due date are required.')
      return
    }

    setSavingReminder(true)
    setReminderSaveError('')
    try {
      const res = await api(API_REMINDERS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: selectedContact.id,
          reason,
          dueDate,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.message || 'Could not save reminder.')
      }
      // Only add after the server confirms — completing later won't auto-create another.
      const saved = normalizeReminder(data)
      setReminders((prev) => [...prev, saved].sort(sortByDueDate))
      setFormMode(null)
      setReminderForm(EMPTY_REMINDER_FORM)
    } catch (err) {
      setReminderSaveError(err.message || 'Could not save reminder.')
    } finally {
      setSavingReminder(false)
    }
  }

  async function importLocalReminders() {
    if (importingReminders || backupReminders.length === 0) return
    setImportingReminders(true)
    setRemindersError('')
    setImportReport(null)
    try {
      const res = await api(`${API_REMINDERS}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reminders: backupReminders.map((r) => ({
            localId: r.id,
            contactId: r.contactId,
            reason: r.reason,
            dueDate: r.dueDate,
            completed: Boolean(r.completed),
          })),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.message || 'Could not import reminders.')
      }

      // Refresh from the server so the UI matches Mongo.
      const listRes = await api(API_REMINDERS)
      if (listRes.ok) {
        const list = await listRes.json()
        setReminders(
          Array.isArray(list) ? list.map(normalizeReminder) : [],
        )
      }

      setImportReport({
        imported: data.imported ?? 0,
        skippedDuplicates: data.skippedDuplicates ?? 0,
        missingContactLinks: Array.isArray(data.missingContactLinks)
          ? data.missingContactLinks
          : [],
      })
    } catch (err) {
      setRemindersError(err.message || 'Could not import reminders.')
    } finally {
      setImportingReminders(false)
    }
  }

  async function handleDelete() {
    if (!selectedContact || deletingContact) return

    const linkedCount = reminders.filter((r) =>
      sameId(r.contactId, selectedContact.id),
    ).length
    const reminderNote =
      linkedCount > 0
        ? ` ${linkedCount} linked reminder${linkedCount === 1 ? '' : 's'} will also be removed.`
        : ''
    const ok = window.confirm(
      `Delete ${selectedContact.name}? This cannot be undone.${reminderNote}`,
    )
    if (!ok) return

    setDeletingContact(true)
    setDeleteError('')
    const deletedId = selectedContact.id
    try {
      const res = await api(`${API_CONTACTS}/${deletedId}`, {
        method: 'DELETE',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.message || 'Could not delete contact.')
      }

      // Update UI only after the server confirms deletion.
      const next = contacts.filter((c) => !sameId(c.id, deletedId))
      setContacts(next)
      setReminders((prev) =>
        prev.filter((r) => !sameId(r.contactId, deletedId)),
      )
      setSelectedId(next[0]?.id ?? null)
      setSelectedReminderId(null)
      setFormMode(null)
    } catch (err) {
      setDeleteError(err.message || 'Could not delete contact.')
    } finally {
      setDeletingContact(false)
    }
  }

  function handleContactedToday() {
    if (!selectedContact) return
    setContacts((prev) =>
      prev.map((c) =>
        sameId(c.id, selectedContact.id)
          ? { ...c, lastContacted: todayISO() }
          : c,
      ),
    )
  }

  /** Mark done on the server — stays completed; no automatic next reminder. */
  async function completeReminder(reminderId) {
    if (reminderBusyId) return
    setReminderBusyId(reminderId)
    setRemindersError('')
    try {
      const res = await api(`${API_REMINDERS}/${reminderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.message || 'Could not complete reminder.')
      }
      const updated = normalizeReminder(data)
      setReminders((prev) =>
        prev.map((r) => (sameId(r.id, updated.id) ? updated : r)),
      )
      if (sameId(selectedReminderId, reminderId)) {
        setSelectedReminderId(null)
      }
    } catch (err) {
      setRemindersError(err.message || 'Could not complete reminder.')
    } finally {
      setReminderBusyId(null)
    }
  }

  /** Push due date to tomorrow on the server; reminder stays open. */
  async function snoozeReminder(reminderId) {
    if (reminderBusyId) return
    const tomorrow = addDays(todayISO(), 1)
    setReminderBusyId(reminderId)
    setRemindersError('')
    try {
      const res = await api(`${API_REMINDERS}/${reminderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dueDate: tomorrow }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.message || 'Could not snooze reminder.')
      }
      const updated = normalizeReminder(data)
      setReminders((prev) =>
        prev
          .map((r) => (sameId(r.id, updated.id) ? updated : r))
          .sort(sortByDueDate),
      )
    } catch (err) {
      setRemindersError(err.message || 'Could not snooze reminder.')
    } finally {
      setReminderBusyId(null)
    }
  }

  async function deleteReminder(reminderId) {
    if (reminderBusyId) return
    const ok = window.confirm(
      'Delete this reminder? This cannot be undone.',
    )
    if (!ok) return

    setReminderBusyId(reminderId)
    setRemindersError('')
    try {
      const res = await api(`${API_REMINDERS}/${reminderId}`, {
        method: 'DELETE',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.message || 'Could not delete reminder.')
      }
      setReminders((prev) => prev.filter((r) => !sameId(r.id, reminderId)))
      if (sameId(selectedReminderId, reminderId)) {
        setSelectedReminderId(null)
      }
    } catch (err) {
      setRemindersError(err.message || 'Could not delete reminder.')
    } finally {
      setReminderBusyId(null)
    }
  }

  function selectContact(id) {
    setSelectedId(id)
    setSelectedReminderId(null)
    setFormMode(null)
    setDeleteError('')
    setSaveError('')
  }

  function selectReminder(reminder) {
    setSelectedReminderId(reminder.id)
    setSelectedId(reminder.contactId)
    setFormMode(null)
  }

  function handleNavClick(id) {
    setActiveNav(id)
    setFormMode(null)
    if (id === 'reminders') {
      const first =
        overdueReminders[0] || todayReminders[0] || upcomingReminders[0]
      setSelectedReminderId(first?.id ?? null)
      if (first) setSelectedId(first.contactId)
      setSelectedTagKey(null)
    } else if (id === 'tags') {
      setSelectedReminderId(null)
      setSelectedTagKey(null)
    } else {
      setSelectedReminderId(null)
      setSelectedTagKey(null)
    }
  }

  function selectTag(tagKey) {
    setSelectedTagKey(tagKey)
    setSelectedReminderId(null)
    setFormMode(null)
  }

  function clearSelectedTag() {
    setSelectedTagKey(null)
  }

  function openContactFromTags(contactId) {
    selectContact(contactId)
    // Stay on Tags so the list context remains; detail pane shows the profile.
  }

  function listTitle() {
    if (activeNav === 'reminders') return 'Reminders'
    if (activeNav === 'tags') {
      if (selectedTag) return selectedTag.label
      if (selectedTagKey) return selectedTagKey
      return 'Tags'
    }
    return 'People'
  }

  function renderReminderGroup(title, items, status) {
    if (items.length === 0) return null
    return (
      <div className="reminder-group" key={title}>
        <h3 className="reminder-group-title">
          {title}
          <span className="reminder-group-count">{items.length}</span>
        </h3>
        <ul className="contact-list reminder-group-list">
          {items.map((reminder) => (
            <li key={reminder.id}>
              <button
                type="button"
                className={
                  selectedReminderId === reminder.id
                    ? 'contact-row is-selected'
                    : 'contact-row'
                }
                onClick={() => selectReminder(reminder)}
              >
                <span className="avatar" aria-hidden="true">
                  {initials(contactName(reminder.contactId))}
                </span>
                <span className="contact-meta">
                  <span className="contact-name">
                    {contactName(reminder.contactId)}
                  </span>
                  <span className="contact-sub">
                    {reminder.reason} · {reminder.dueDate}
                  </span>
                </span>
                <span className={`due-badge due-badge--${status}`}>
                  {dueLabel(status)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            PN
          </span>
          <span className="brand-name">PeoplesNote</span>
        </div>

        <nav className="sidebar-nav" aria-label="Main">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={
                activeNav === item.id ? 'nav-item is-active' : 'nav-item'
              }
              onClick={() => handleNavClick(item.id)}
            >
              {item.label}
              {item.id === 'reminders' && needsAttentionCount > 0 && (
                <span className="nav-count">{needsAttentionCount}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <p className="sidebar-user" title={user.email}>
            {user.email}
          </p>
          <button
            type="button"
            className="btn btn-ghost sidebar-logout"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      </aside>

      <section className="list-pane" aria-label="Contacts">
        <header className="list-header">
          <div className="list-title-row">
            <h1>{listTitle()}</h1>
            {activeNav === 'people' && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={openAddForm}
                disabled={contactsLoading}
              >
                Add person
              </button>
            )}
            {activeNav === 'tags' && selectedTagKey && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={clearSelectedTag}
              >
                All tags
              </button>
            )}
          </div>

          {activeNav === 'reminders' ? (
            <p className="list-subtitle">
              Overdue, today, and upcoming · earliest first
            </p>
          ) : activeNav === 'tags' ? (
            <p className="list-subtitle">
              {selectedTagKey
                ? selectedTag
                  ? `${selectedTag.count} contact${selectedTag.count === 1 ? '' : 's'} · click a person to open their profile`
                  : 'This tag is no longer used on any contact'
                : 'Tags from your contacts · click one to filter'}
            </p>
          ) : (
            <label className="search">
              <span className="visually-hidden">Search contacts</span>
              <input
                type="search"
                placeholder="Search name, company, or tag…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                disabled={contactsLoading}
              />
            </label>
          )}
        </header>

        {(activeNav === 'people' || activeNav === 'tags') &&
          contactsLoading && (
            <p className="status-banner status-banner--loading">
              Loading contacts…
            </p>
          )}
        {(activeNav === 'people' || activeNav === 'tags') && contactsError && (
          <p className="status-banner status-banner--error" role="alert">
            {contactsError}
          </p>
        )}

        {activeNav === 'tags' ? (
          contactsLoading ? null : (
            <ul className="contact-list">
              {contactsError ? (
                <li className="empty">
                  Tags unavailable until contacts load from the server.
                </li>
              ) : selectedTagKey ? (
                taggedContacts.length === 0 ? (
                  <li className="empty">
                    No contacts currently use “{selectedTag?.label || selectedTagKey}”.
                  </li>
                ) : (
                  taggedContacts.map((contact) => (
                    <li key={contact.id}>
                      <button
                        type="button"
                        className={
                          selectedContact &&
                          sameId(selectedContact.id, contact.id)
                            ? 'contact-row is-selected'
                            : 'contact-row'
                        }
                        onClick={() => openContactFromTags(contact.id)}
                      >
                        <span className="avatar" aria-hidden="true">
                          {initials(contact.name)}
                        </span>
                        <span className="contact-meta">
                          <span className="contact-name">{contact.name}</span>
                          <span className="contact-sub">
                            {contact.company || 'No company'}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))
                )
              ) : tagStats.length === 0 ? (
                <li className="empty">
                  {contacts.length === 0
                    ? 'No people yet — add someone and give them tags.'
                    : 'No tags yet — add tags when editing a contact.'}
                </li>
              ) : (
                tagStats.map((tag) => (
                  <li key={tag.key}>
                    <button
                      type="button"
                      className="contact-row tag-row"
                      onClick={() => selectTag(tag.key)}
                    >
                      <span className="tag tag-row-label">{tag.label}</span>
                      <span className="tag-row-count">
                        {tag.count}{' '}
                        {tag.count === 1 ? 'contact' : 'contacts'}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )
        ) : activeNav === 'reminders' ? (
          <div className="reminders-board">
            {remindersLoading && (
              <p className="status-banner status-banner--loading">
                Loading reminders…
              </p>
            )}
            {remindersError && (
              <p className="status-banner status-banner--error" role="alert">
                {remindersError}
              </p>
            )}
            {backupReminders.length > 0 && (
              <div className="import-panel">
                <p className="list-subtitle">
                  Local backup found ({backupReminders.length}). Import is
                  optional and won’t create duplicates.
                </p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={importLocalReminders}
                  disabled={importingReminders || remindersLoading}
                >
                  {importingReminders
                    ? 'Importing…'
                    : 'Import local reminders'}
                </button>
              </div>
            )}
            {importReport && (
              <div className="import-report" role="status">
                <p>
                  Imported {importReport.imported}, skipped{' '}
                  {importReport.skippedDuplicates} duplicate
                  {importReport.skippedDuplicates === 1 ? '' : 's'}.
                </p>
                {importReport.missingContactLinks.length > 0 && (
                  <p>
                    {importReport.missingContactLinks.length} reminder
                    {importReport.missingContactLinks.length === 1
                      ? ''
                      : 's'}{' '}
                    skipped — linked contact missing in the database.
                  </p>
                )}
              </div>
            )}
            {!remindersLoading && openReminders.length === 0 ? (
              <p className="empty">
                No open reminders. Add one from a contact’s profile.
              </p>
            ) : (
              !remindersLoading && (
                <>
                  {renderReminderGroup('Overdue', overdueReminders, 'overdue')}
                  {renderReminderGroup('Today', todayReminders, 'due-today')}
                  {renderReminderGroup(
                    'Upcoming',
                    upcomingReminders,
                    'upcoming',
                  )}
                </>
              )
            )}
          </div>
        ) : contactsLoading ? null : (
          <ul className="contact-list">
            {filteredContacts.length === 0 ? (
              <li className="empty">
                {contactsError
                  ? 'Contacts unavailable until the server responds.'
                  : contacts.length === 0
                    ? 'No people yet — add someone.'
                    : `No contacts match “${searchQuery}”`}
              </li>
            ) : (
              filteredContacts.map((contact) => (
                <li key={contact.id}>
                  <button
                    type="button"
                    className={
                      selectedContact && sameId(selectedContact.id, contact.id)
                        ? 'contact-row is-selected'
                        : 'contact-row'
                    }
                    onClick={() => selectContact(contact.id)}
                  >
                    <span className="avatar" aria-hidden="true">
                      {initials(contact.name)}
                    </span>
                    <span className="contact-meta">
                      <span className="contact-name">{contact.name}</span>
                      <span className="contact-sub">{contact.company}</span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </section>

      <main className="detail-pane" aria-label="Contact details">
        {formMode === 'reminder' && selectedContact ? (
          <form className="contact-form" onSubmit={handleReminderSubmit}>
            <h2>Add reminder</h2>
            <p className="form-context">For {selectedContact.name}</p>

            <label>
              Reason
              <input
                name="reason"
                value={reminderForm.reason}
                onChange={handleReminderFormChange}
                placeholder="e.g. Check in about the proposal"
                required
                autoFocus
              />
            </label>

            <label>
              Due date
              <input
                name="dueDate"
                type="date"
                value={reminderForm.dueDate}
                onChange={handleReminderFormChange}
                required
              />
            </label>

            {reminderSaveError && (
              <p className="status-banner status-banner--error" role="alert">
                {reminderSaveError}
              </p>
            )}

            <div className="form-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={savingReminder}
              >
                {savingReminder ? 'Saving…' : 'Save reminder'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={cancelForm}
                disabled={savingReminder}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : formMode === 'add' || formMode === 'edit' ? (
          <form className="contact-form" onSubmit={handleFormSubmit}>
            <h2>{formMode === 'add' ? 'Add person' : 'Edit person'}</h2>

            <label>
              Name
              <input
                name="name"
                value={form.name}
                onChange={handleFormChange}
                required
                autoFocus
              />
            </label>

            <label>
              Company
              <input
                name="company"
                value={form.company}
                onChange={handleFormChange}
              />
            </label>

            <label>
              Email
              <input
                name="email"
                type="email"
                value={form.email}
                onChange={handleFormChange}
              />
            </label>

            <label>
              Phone
              <input
                name="phone"
                type="tel"
                value={form.phone}
                onChange={handleFormChange}
              />
            </label>

            <label>
              Follow-up every
              <select
                name="followUpDays"
                value={form.followUpDays}
                onChange={handleFormChange}
              >
                {FOLLOW_UP_OPTIONS.map((days) => (
                  <option key={days} value={days}>
                    {days} days
                  </option>
                ))}
              </select>
            </label>

            <label>
              Tags
              <input
                name="tags"
                value={form.tags}
                onChange={handleFormChange}
                placeholder="work, friend (comma-separated)"
              />
            </label>

            <label>
              Notes
              <textarea
                name="notes"
                rows={4}
                value={form.notes}
                onChange={handleFormChange}
              />
            </label>

            {saveError && (
              <p className="status-banner status-banner--error" role="alert">
                {saveError}
              </p>
            )}

            <div className="form-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={savingContact}
              >
                {savingContact
                  ? 'Saving…'
                  : formMode === 'add'
                    ? 'Save person'
                    : 'Save changes'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={cancelForm}
                disabled={savingContact}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : activeNav === 'reminders' && selectedReminder ? (
          <>
            <header className="detail-header">
              <div className="detail-avatar" aria-hidden="true">
                {initials(
                  selectedReminderContact?.name ||
                    contactName(selectedReminder.contactId),
                )}
              </div>
              <div className="detail-heading">
                <h2>
                  {selectedReminderContact?.name ||
                    contactName(selectedReminder.contactId)}
                </h2>
                <p className="detail-company">Reminder</p>
              </div>
            </header>

            <dl className="detail-fields">
              <div>
                <dt>Reason</dt>
                <dd>{selectedReminder.reason}</dd>
              </div>
              <div>
                <dt>Due</dt>
                <dd className="due-line">
                  <span>{selectedReminder.dueDate}</span>
                  <span
                    className={`due-badge due-badge--${getReminderStatus(selectedReminder)}`}
                  >
                    {dueLabel(getReminderStatus(selectedReminder))}
                  </span>
                </dd>
              </div>
            </dl>

            {remindersError && (
              <p className="status-banner status-banner--error" role="alert">
                {remindersError}
              </p>
            )}

            <div className="reminder-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => completeReminder(selectedReminder.id)}
                disabled={Boolean(reminderBusyId)}
              >
                {sameId(reminderBusyId, selectedReminder.id)
                  ? 'Working…'
                  : 'Mark complete'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => snoozeReminder(selectedReminder.id)}
                disabled={Boolean(reminderBusyId)}
              >
                Snooze until tomorrow
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => deleteReminder(selectedReminder.id)}
                disabled={Boolean(reminderBusyId)}
              >
                Delete
              </button>
              {selectedReminderContact && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setActiveNav('people')
                    setSelectedId(selectedReminderContact.id)
                    setSelectedReminderId(null)
                  }}
                  disabled={Boolean(reminderBusyId)}
                >
                  Open contact
                </button>
              )}
            </div>
            <p className="contacted-hint">
              Completing ends this reminder — it will not create another
              automatically.
            </p>
          </>
        ) : selectedContact ? (
          <>
            <header className="detail-header">
              <div className="detail-avatar" aria-hidden="true">
                {initials(selectedContact.name)}
              </div>
              <div className="detail-heading">
                <h2>{selectedContact.name}</h2>
                <p className="detail-company">{selectedContact.company}</p>
              </div>
              <div className="detail-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={openEditForm}
                  disabled={deletingContact}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={handleDelete}
                  disabled={deletingContact}
                >
                  {deletingContact ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </header>

            {deleteError && (
              <p className="status-banner status-banner--error" role="alert">
                {deleteError}
              </p>
            )}

            <dl className="detail-fields">
              <div>
                <dt>Email</dt>
                <dd>{selectedContact.email || '—'}</dd>
              </div>
              <div>
                <dt>Phone</dt>
                <dd>{selectedContact.phone || '—'}</dd>
              </div>
              <div>
                <dt>Last contacted</dt>
                <dd>{formatLastContacted(selectedContact.lastContacted)}</dd>
              </div>
              <div>
                <dt>Follow-up every</dt>
                <dd>{selectedContact.followUpDays} days</dd>
              </div>
              <div>
                <dt>Cadence next due</dt>
                <dd className="due-line">
                  <span>{selectedDue.date}</span>
                  <span
                    className={`due-badge due-badge--${selectedDue.status}`}
                  >
                    {dueLabel(selectedDue.status)}
                  </span>
                </dd>
              </div>
            </dl>

            <div className="contacted-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleContactedToday}
              >
                Contacted today
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={openReminderForm}
              >
                Add reminder
              </button>
              <p className="contacted-hint">
                Reminders are one-shot tasks with a reason and due date. Cadence
                follow-ups stay separate.
              </p>
            </div>

            {contactOpenReminders.length > 0 && (
              <section className="profile-reminders">
                <h3>Open reminders</h3>
                <ul className="profile-reminder-list">
                  {contactOpenReminders.map((reminder) => (
                    <li key={reminder.id} className="profile-reminder-item">
                      <div>
                        <p className="profile-reminder-reason">
                          {reminder.reason}
                        </p>
                        <p className="profile-reminder-due">
                          Due {reminder.dueDate}
                          <span
                            className={`due-badge due-badge--${getReminderStatus(reminder)}`}
                          >
                            {dueLabel(getReminderStatus(reminder))}
                          </span>
                        </p>
                      </div>
                      <div className="profile-reminder-actions">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => completeReminder(reminder.id)}
                          disabled={Boolean(reminderBusyId)}
                        >
                          Complete
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => snoozeReminder(reminder.id)}
                          disabled={Boolean(reminderBusyId)}
                        >
                          Snooze
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {selectedContact.tags.length > 0 && (
              <div className="detail-tags">
                {selectedContact.tags.map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                  </span>
                ))}
              </div>
            )}

            <section className="detail-notes">
              <h3>Notes</h3>
              <p>{selectedContact.notes || 'No notes yet.'}</p>
            </section>
          </>
        ) : (
          <p className="empty">
            {activeNav === 'reminders'
              ? 'Select a reminder, or add one from a contact’s profile.'
              : 'No contact selected. Add a person or pick one from the list.'}
          </p>
        )}
      </main>
    </div>
  )
}

export default App

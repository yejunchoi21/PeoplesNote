import { useEffect, useState } from 'react'
import './App.css'

const STORAGE_KEY = 'peoplesnote-contacts'
const FOLLOW_UP_OPTIONS = [7, 30, 60]

/**
 * Seed data used only when localStorage is empty (first visit).
 * followUpDays = how often you want to reconnect (7 / 30 / 60).
 */
const SAMPLE_CONTACTS = [
  {
    id: 1,
    name: 'Maya Chen',
    email: 'maya.chen@example.com',
    phone: '(555) 214-8801',
    company: 'Northwind Labs',
    tags: ['work', 'mentor'],
    notes: 'Met at React meetup. Prefers async updates.',
    lastContacted: '2026-10-12',
    followUpDays: 30,
  },
  {
    id: 2,
    name: 'Jordan Blake',
    email: 'jordan.blake@example.com',
    phone: '(555) 903-4412',
    company: 'Freelance',
    tags: ['friend'],
    notes: 'Coffee next time they are in town.',
    lastContacted: '2026-09-28',
    followUpDays: 60,
  },
  {
    id: 3,
    name: 'Sam Ortiz',
    email: 'sam.ortiz@example.com',
    phone: '(555) 677-0199',
    company: 'Bright Harbor',
    tags: ['client', 'follow-up'],
    notes: 'Sent proposal draft. Waiting on feedback.',
    lastContacted: '2026-10-20',
    followUpDays: 7,
  },
  {
    id: 4,
    name: 'Priya Nair',
    email: 'priya.nair@example.com',
    phone: '(555) 330-7620',
    company: 'Civic Studio',
    tags: ['work'],
    notes: 'Introduced me to the design team.',
    lastContacted: '2026-08-15',
    followUpDays: 30,
  },
  {
    id: 5,
    name: 'Alex Rivera',
    email: 'alex.rivera@example.com',
    phone: '(555) 118-5543',
    company: 'Independent',
    tags: ['friend', 'college'],
    notes: 'Birthday in November. Loves hiking.',
    lastContacted: '',
    followUpDays: 60,
  },
]

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

/** Local calendar date as YYYY-MM-DD (avoids UTC off-by-one). */
function todayISO() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Add days to a YYYY-MM-DD string; returns another YYYY-MM-DD. */
function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + days)
  const yy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/**
 * Next follow-up due date.
 * No last-contact → due today (treat as never contacted).
 */
function getDueDate(contact) {
  if (!contact.lastContacted) return todayISO()
  const days = FOLLOW_UP_OPTIONS.includes(contact.followUpDays)
    ? contact.followUpDays
    : 30
  return addDays(contact.lastContacted, days)
}

function getDueStatus(contact) {
  const due = getDueDate(contact)
  const today = todayISO()
  if (due < today) return 'overdue'
  if (due === today) return 'due-today'
  return 'upcoming'
}

/** Ensure older saved contacts get a valid followUpDays. */
function normalizeContact(contact) {
  const followUpDays = FOLLOW_UP_OPTIONS.includes(contact.followUpDays)
    ? contact.followUpDays
    : 30
  return {
    ...contact,
    lastContacted: contact.lastContacted || '',
    tags: Array.isArray(contact.tags) ? contact.tags : [],
    followUpDays,
  }
}

function loadContacts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return SAMPLE_CONTACTS.map(normalizeContact)
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return SAMPLE_CONTACTS.map(normalizeContact)
    return parsed.map(normalizeContact)
  } catch {
    return SAMPLE_CONTACTS.map(normalizeContact)
  }
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

function dueLabel(status) {
  if (status === 'overdue') return 'Overdue'
  if (status === 'due-today') return 'Due today'
  return 'Upcoming'
}

function App() {
  const [contacts, setContacts] = useState(loadContacts)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedId, setSelectedId] = useState(
    () => loadContacts()[0]?.id ?? null,
  )
  const [activeNav, setActiveNav] = useState('people')
  const [formMode, setFormMode] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)

  // Same persistence path as before — reminders just add fields on each contact.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts))
  }, [contacts])

  const filteredContacts = contacts.filter((contact) => {
    const q = searchQuery.toLowerCase().trim()
    if (!q) return true
    return (
      contact.name.toLowerCase().includes(q) ||
      contact.company.toLowerCase().includes(q) ||
      contact.tags.some((tag) => tag.toLowerCase().includes(q))
    )
  })

  // Overdue + due today, earliest due date first.
  const reminderContacts = contacts
    .filter((c) => {
      const status = getDueStatus(c)
      return status === 'overdue' || status === 'due-today'
    })
    .sort((a, b) => getDueDate(a).localeCompare(getDueDate(b)))

  const listContacts =
    activeNav === 'reminders' ? reminderContacts : filteredContacts

  const selectedContact =
    contacts.find((c) => c.id === selectedId) || null

  const selectedDue = selectedContact
    ? {
        date: getDueDate(selectedContact),
        status: getDueStatus(selectedContact),
      }
    : null

  function openAddForm() {
    setActiveNav('people')
    setForm(EMPTY_FORM)
    setFormMode('add')
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
  }

  function cancelForm() {
    setFormMode(null)
    setForm(EMPTY_FORM)
  }

  function handleFormChange(e) {
    const { name, value } = e.target
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  function handleFormSubmit(e) {
    e.preventDefault()
    const name = form.name.trim()
    if (!name) return

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
      const newContact = {
        ...payload,
        id: Date.now(),
        lastContacted: todayISO(),
      }
      setContacts((prev) => [...prev, newContact])
      setSelectedId(newContact.id)
    } else if (formMode === 'edit' && selectedContact) {
      setContacts((prev) =>
        prev.map((c) =>
          c.id === selectedContact.id ? { ...c, ...payload } : c,
        ),
      )
    }

    setFormMode(null)
    setForm(EMPTY_FORM)
  }

  function handleDelete() {
    if (!selectedContact) return
    const ok = window.confirm(
      `Delete ${selectedContact.name}? This cannot be undone.`,
    )
    if (!ok) return

    const next = contacts.filter((c) => c.id !== selectedContact.id)
    setContacts(next)
    setSelectedId(next[0]?.id ?? null)
    setFormMode(null)
  }

  /** Sets lastContacted to today → next due becomes today + interval. */
  function handleContactedToday() {
    if (!selectedContact) return
    setContacts((prev) =>
      prev.map((c) =>
        c.id === selectedContact.id
          ? { ...c, lastContacted: todayISO() }
          : c,
      ),
    )
  }

  function selectContact(id) {
    setSelectedId(id)
    setFormMode(null)
  }

  function handleNavClick(id) {
    setActiveNav(id)
    setFormMode(null)
    if (id === 'reminders' && reminderContacts[0]) {
      setSelectedId(reminderContacts[0].id)
    }
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
              {item.id === 'reminders' && reminderContacts.length > 0 && (
                <span className="nav-count">{reminderContacts.length}</span>
              )}
            </button>
          ))}
        </nav>

        <p className="sidebar-hint">Saved in this browser (localStorage)</p>
      </aside>

      <section className="list-pane" aria-label="Contacts">
        <header className="list-header">
          <div className="list-title-row">
            <h1>{activeNav === 'reminders' ? 'Reminders' : 'People'}</h1>
            {activeNav !== 'reminders' && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={openAddForm}
              >
                Add person
              </button>
            )}
          </div>

          {activeNav === 'reminders' ? (
            <p className="list-subtitle">
              Overdue and due today · earliest first
            </p>
          ) : activeNav === 'tags' ? (
            <p className="list-subtitle">Tags view coming soon</p>
          ) : (
            <label className="search">
              <span className="visually-hidden">Search contacts</span>
              <input
                type="search"
                placeholder="Search name, company, or tag…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </label>
          )}
        </header>

        <ul className="contact-list">
          {activeNav === 'tags' ? (
            <li className="empty">Tag browsing is not built yet.</li>
          ) : listContacts.length === 0 ? (
            <li className="empty">
              {activeNav === 'reminders'
                ? 'You’re all caught up — nothing due today.'
                : contacts.length === 0
                  ? 'No people yet — add someone.'
                  : `No contacts match “${searchQuery}”`}
            </li>
          ) : (
            listContacts.map((contact) => {
              const status = getDueStatus(contact)
              return (
                <li key={contact.id}>
                  <button
                    type="button"
                    className={
                      selectedContact?.id === contact.id
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
                      <span className="contact-sub">
                        {activeNav === 'reminders'
                          ? `Due ${getDueDate(contact)} · every ${contact.followUpDays}d`
                          : contact.company}
                      </span>
                    </span>
                    {activeNav === 'reminders' && (
                      <span className={`due-badge due-badge--${status}`}>
                        {dueLabel(status)}
                      </span>
                    )}
                  </button>
                </li>
              )
            })
          )}
        </ul>
      </section>

      <main className="detail-pane" aria-label="Contact details">
        {formMode ? (
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

            <div className="form-actions">
              <button type="submit" className="btn btn-primary">
                {formMode === 'add' ? 'Save person' : 'Save changes'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={cancelForm}
              >
                Cancel
              </button>
            </div>
          </form>
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
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={handleDelete}
                >
                  Delete
                </button>
              </div>
            </header>

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
                <dt>Next due</dt>
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
              <p className="contacted-hint">
                Sets last contact to today and pushes the next due date forward.
              </p>
            </div>

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
            No contact selected. Add a person or pick one from the list.
          </p>
        )}
      </main>
    </div>
  )
}

export default App

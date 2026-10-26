import { useEffect, useState } from 'react'
import './App.css'

const STORAGE_KEY = 'peoplesnote-contacts'

/**
 * Seed data used only when localStorage is empty (first visit).
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
  },
  {
    id: 5,
    name: 'Alex Rivera',
    email: 'alex.rivera@example.com',
    phone: '(555) 118-5543',
    company: 'Independent',
    tags: ['friend', 'college'],
    notes: 'Birthday in November. Loves hiking.',
    lastContacted: '2026-07-02',
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
}

/** Read contacts from localStorage, or fall back to sample data. */
function loadContacts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return SAMPLE_CONTACTS
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : SAMPLE_CONTACTS
  } catch {
    return SAMPLE_CONTACTS
  }
}

/** Turn "work, mentor" into ['work', 'mentor']. */
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

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function App() {
  // Lazy initializer: runs once on mount — loads from localStorage.
  const [contacts, setContacts] = useState(loadContacts)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedId, setSelectedId] = useState(
    () => loadContacts()[0]?.id ?? null,
  )
  const [activeNav, setActiveNav] = useState('people')

  // null = viewing detail; 'add' | 'edit' = show the form
  const [formMode, setFormMode] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)

  // Whenever contacts change, write them to localStorage.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts))
  }, [contacts])

  // Search: name, company, or tag only (not email/phone).
  const filteredContacts = contacts.filter((contact) => {
    const q = searchQuery.toLowerCase().trim()
    if (!q) return true
    return (
      contact.name.toLowerCase().includes(q) ||
      contact.company.toLowerCase().includes(q) ||
      contact.tags.some((tag) => tag.toLowerCase().includes(q))
    )
  })

  const selectedContact =
    contacts.find((c) => c.id === selectedId) || null

  function openAddForm() {
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

    const payload = {
      name,
      company: form.company.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      tags: parseTags(form.tags),
      notes: form.notes.trim(),
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

  function selectContact(id) {
    setSelectedId(id)
    setFormMode(null)
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
              onClick={() => setActiveNav(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <p className="sidebar-hint">Saved in this browser (localStorage)</p>
      </aside>

      <section className="list-pane" aria-label="Contacts">
        <header className="list-header">
          <div className="list-title-row">
            <h1>People</h1>
            <button
              type="button"
              className="btn btn-primary"
              onClick={openAddForm}
            >
              Add person
            </button>
          </div>
          <label className="search">
            <span className="visually-hidden">Search contacts</span>
            <input
              type="search"
              placeholder="Search name, company, or tag…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </label>
        </header>

        <ul className="contact-list">
          {filteredContacts.length === 0 ? (
            <li className="empty">
              {contacts.length === 0
                ? 'No people yet — add someone.'
                : `No contacts match “${searchQuery}”`}
            </li>
          ) : (
            filteredContacts.map((contact) => (
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
                    <span className="contact-sub">{contact.company}</span>
                  </span>
                </button>
              </li>
            ))
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
                <dd>{selectedContact.lastContacted || '—'}</dd>
              </div>
            </dl>

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

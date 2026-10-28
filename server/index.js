import 'dotenv/config'
import express from 'express'
import { MongoClient, ObjectId } from 'mongodb'

const PORT = Number(process.env.PORT) || 3001
const HOST = process.env.HOST || '127.0.0.1'
const MONGODB_URI = process.env.MONGODB_URI

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI. Copy .env.example to .env and set it.')
  process.exit(1)
}

const app = express()
const client = new MongoClient(MONGODB_URI)

app.use(express.json())

function contactsCollection() {
  return client.db().collection('contacts')
}

function remindersCollection() {
  return client.db().collection('reminders')
}

/** Turn a Mongo document into the shape the React app expects. */
function serializeContact(doc) {
  const { _id, ...rest } = doc
  return {
    id: String(_id),
    ...rest,
  }
}

function serializeReminder(doc) {
  const { _id, ...rest } = doc
  return {
    id: String(_id),
    ...rest,
  }
}

/** Returns an ObjectId or null when the id is missing/invalid. */
function parseObjectId(id) {
  if (typeof id !== 'string' || !ObjectId.isValid(id)) return null
  return new ObjectId(id)
}

function normalizeIncomingContact(body = {}) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const followUpDays = [7, 30, 60].includes(Number(body.followUpDays))
    ? Number(body.followUpDays)
    : 30

  return {
    name,
    company: typeof body.company === 'string' ? body.company.trim() : '',
    email: typeof body.email === 'string' ? body.email.trim() : '',
    phone: typeof body.phone === 'string' ? body.phone.trim() : '',
    tags: Array.isArray(body.tags)
      ? body.tags.map(String).map((t) => t.trim()).filter(Boolean)
      : [],
    notes: typeof body.notes === 'string' ? body.notes.trim() : '',
    lastContacted:
      typeof body.lastContacted === 'string' ? body.lastContacted : '',
    followUpDays,
  }
}

function normalizeIncomingReminder(body = {}) {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  const dueDate = typeof body.dueDate === 'string' ? body.dueDate.trim() : ''
  const contactId =
    body.contactId === undefined || body.contactId === null
      ? ''
      : String(body.contactId).trim()

  return {
    contactId,
    reason,
    dueDate,
    completed: Boolean(body.completed),
  }
}

async function contactExists(contactId) {
  const objectId = parseObjectId(contactId)
  if (!objectId) return false
  const count = await contactsCollection().countDocuments(
    { _id: objectId },
    { limit: 1 },
  )
  return count > 0
}

app.get('/api/health', async (_req, res) => {
  try {
    await client.db().command({ ping: 1 })
    res.json({
      ok: true,
      message: 'MongoDB is reachable',
    })
  } catch (err) {
    console.error('Health check failed:', err.message)
    res.status(503).json({
      ok: false,
      message: 'MongoDB is not reachable',
    })
  }
})

app.get('/api/contacts', async (_req, res) => {
  try {
    const docs = await contactsCollection()
      .find({})
      .sort({ name: 1 })
      .toArray()
    res.json(docs.map(serializeContact))
  } catch (err) {
    console.error('GET /api/contacts failed:', err.message)
    res.status(500).json({
      ok: false,
      message: 'Failed to load contacts',
    })
  }
})

app.post('/api/contacts', async (req, res) => {
  try {
    const contact = normalizeIncomingContact(req.body)

    if (!contact.name) {
      return res.status(400).json({
        ok: false,
        message: 'Name is required',
      })
    }

    const doc = {
      ...contact,
      createdAt: new Date(),
    }

    const result = await contactsCollection().insertOne(doc)
    res.status(201).json(
      serializeContact({
        _id: result.insertedId,
        ...doc,
      }),
    )
  } catch (err) {
    console.error('POST /api/contacts failed:', err.message)
    res.status(500).json({
      ok: false,
      message: 'Failed to create contact',
    })
  }
})

app.put('/api/contacts/:id', async (req, res) => {
  try {
    const objectId = parseObjectId(req.params.id)
    if (!objectId) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid contact id',
      })
    }

    const contact = normalizeIncomingContact(req.body)
    if (!contact.name) {
      return res.status(400).json({
        ok: false,
        message: 'Name is required',
      })
    }

    const result = await contactsCollection().findOneAndUpdate(
      { _id: objectId },
      {
        $set: {
          ...contact,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    )

    const updated = result?.value ?? result
    if (!updated || !updated._id) {
      return res.status(404).json({
        ok: false,
        message: 'Contact not found',
      })
    }

    res.json(serializeContact(updated))
  } catch (err) {
    console.error('PUT /api/contacts/:id failed:', err.message)
    res.status(500).json({
      ok: false,
      message: 'Failed to update contact',
    })
  }
})

app.delete('/api/contacts/:id', async (req, res) => {
  try {
    const objectId = parseObjectId(req.params.id)
    if (!objectId) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid contact id',
      })
    }

    const result = await contactsCollection().deleteOne({ _id: objectId })
    if (result.deletedCount === 0) {
      return res.status(404).json({
        ok: false,
        message: 'Contact not found',
      })
    }

    // Cascade: remove reminders that still point at this contact.
    const reminderCleanup = await remindersCollection().deleteMany({
      contactId: req.params.id,
    })

    res.json({
      ok: true,
      message: 'Contact deleted',
      id: req.params.id,
      deletedReminders: reminderCleanup.deletedCount,
    })
  } catch (err) {
    console.error('DELETE /api/contacts/:id failed:', err.message)
    res.status(500).json({
      ok: false,
      message: 'Failed to delete contact',
    })
  }
})

app.get('/api/reminders', async (_req, res) => {
  try {
    const docs = await remindersCollection()
      .find({})
      .sort({ dueDate: 1 })
      .toArray()
    res.json(docs.map(serializeReminder))
  } catch (err) {
    console.error('GET /api/reminders failed:', err.message)
    res.status(500).json({
      ok: false,
      message: 'Failed to load reminders',
    })
  }
})

app.post('/api/reminders', async (req, res) => {
  try {
    const reminder = normalizeIncomingReminder(req.body)

    if (!reminder.reason) {
      return res.status(400).json({
        ok: false,
        message: 'Reason is required',
      })
    }
    if (!reminder.dueDate) {
      return res.status(400).json({
        ok: false,
        message: 'Due date is required',
      })
    }
    if (!parseObjectId(reminder.contactId)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid contact id',
      })
    }
    if (!(await contactExists(reminder.contactId))) {
      return res.status(400).json({
        ok: false,
        message: 'Contact not found for this reminder',
      })
    }

    const doc = {
      ...reminder,
      completed: false,
      createdAt: new Date(),
    }

    const result = await remindersCollection().insertOne(doc)
    res.status(201).json(
      serializeReminder({
        _id: result.insertedId,
        ...doc,
      }),
    )
  } catch (err) {
    console.error('POST /api/reminders failed:', err.message)
    res.status(500).json({
      ok: false,
      message: 'Failed to create reminder',
    })
  }
})

/**
 * One-time / bulk import from a browser backup.
 * Dedupes by importedLocalId or contactId+reason+dueDate.
 * Skips rows whose contactId is missing in Mongo and reports them.
 */
app.post('/api/reminders/import', async (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.reminders) ? req.body.reminders : []
    let imported = 0
    let skippedDuplicates = 0
    const missingContactLinks = []
    const created = []

    for (const raw of incoming) {
      const localId =
        raw?.localId !== undefined && raw?.localId !== null
          ? String(raw.localId)
          : raw?.id !== undefined && raw?.id !== null
            ? String(raw.id)
            : ''
      const reminder = normalizeIncomingReminder(raw)

      if (!reminder.reason || !reminder.dueDate) {
        missingContactLinks.push({
          localId,
          contactId: reminder.contactId,
          reason: reminder.reason,
          dueDate: reminder.dueDate,
          issue: 'invalid_reminder',
        })
        continue
      }

      if (
        !parseObjectId(reminder.contactId) ||
        !(await contactExists(reminder.contactId))
      ) {
        missingContactLinks.push({
          localId,
          contactId: reminder.contactId,
          reason: reminder.reason,
          dueDate: reminder.dueDate,
          issue: 'missing_contact',
        })
        continue
      }

      const duplicateQuery = localId
        ? {
            $or: [
              { importedLocalId: localId },
              {
                contactId: reminder.contactId,
                reason: reminder.reason,
                dueDate: reminder.dueDate,
              },
            ],
          }
        : {
            contactId: reminder.contactId,
            reason: reminder.reason,
            dueDate: reminder.dueDate,
          }

      const existing = await remindersCollection().findOne(duplicateQuery)
      if (existing) {
        skippedDuplicates += 1
        continue
      }

      const doc = {
        contactId: reminder.contactId,
        reason: reminder.reason,
        dueDate: reminder.dueDate,
        completed: Boolean(raw.completed),
        importedLocalId: localId || undefined,
        createdAt: new Date(),
        importedAt: new Date(),
      }

      const result = await remindersCollection().insertOne(doc)
      const saved = serializeReminder({ _id: result.insertedId, ...doc })
      created.push(saved)
      imported += 1
    }

    res.json({
      ok: true,
      imported,
      skippedDuplicates,
      missingContactLinks,
      created,
    })
  } catch (err) {
    console.error('POST /api/reminders/import failed:', err.message)
    res.status(500).json({
      ok: false,
      message: 'Failed to import reminders',
    })
  }
})

app.patch('/api/reminders/:id', async (req, res) => {
  try {
    const objectId = parseObjectId(req.params.id)
    if (!objectId) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid reminder id',
      })
    }

    const updates = {}
    if (typeof req.body?.reason === 'string') {
      const reason = req.body.reason.trim()
      if (!reason) {
        return res.status(400).json({
          ok: false,
          message: 'Reason is required',
        })
      }
      updates.reason = reason
    }
    if (typeof req.body?.dueDate === 'string') {
      const dueDate = req.body.dueDate.trim()
      if (!dueDate) {
        return res.status(400).json({
          ok: false,
          message: 'Due date is required',
        })
      }
      updates.dueDate = dueDate
    }
    if (typeof req.body?.completed === 'boolean') {
      updates.completed = req.body.completed
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        ok: false,
        message: 'No valid fields to update',
      })
    }

    updates.updatedAt = new Date()

    const result = await remindersCollection().findOneAndUpdate(
      { _id: objectId },
      { $set: updates },
      { returnDocument: 'after' },
    )

    const updated = result?.value ?? result
    if (!updated || !updated._id) {
      return res.status(404).json({
        ok: false,
        message: 'Reminder not found',
      })
    }

    res.json(serializeReminder(updated))
  } catch (err) {
    console.error('PATCH /api/reminders/:id failed:', err.message)
    res.status(500).json({
      ok: false,
      message: 'Failed to update reminder',
    })
  }
})

app.delete('/api/reminders/:id', async (req, res) => {
  try {
    const objectId = parseObjectId(req.params.id)
    if (!objectId) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid reminder id',
      })
    }

    const result = await remindersCollection().deleteOne({ _id: objectId })
    if (result.deletedCount === 0) {
      return res.status(404).json({
        ok: false,
        message: 'Reminder not found',
      })
    }

    res.json({
      ok: true,
      message: 'Reminder deleted',
      id: req.params.id,
    })
  } catch (err) {
    console.error('DELETE /api/reminders/:id failed:', err.message)
    res.status(500).json({
      ok: false,
      message: 'Failed to delete reminder',
    })
  }
})

async function start() {
  try {
    await client.connect()
    await client.db().command({ ping: 1 })
    console.log('Connected to MongoDB')

    app.listen(PORT, HOST, () => {
      console.log(`PeoplesNote API listening on http://${HOST}:${PORT}`)
    })
  } catch (err) {
    console.error('Failed to start server:', err.message)
    process.exit(1)
  }
}

start()

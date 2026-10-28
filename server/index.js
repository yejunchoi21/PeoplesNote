import 'dotenv/config'
import crypto from 'crypto'
import bcrypt from 'bcrypt'
import MongoStore from 'connect-mongo'
import express from 'express'
import rateLimit from 'express-rate-limit'
import session from 'express-session'
import { MongoClient, ObjectId } from 'mongodb'

const PORT = Number(process.env.PORT) || 3001
const HOST = process.env.HOST || '127.0.0.1'
const MONGODB_URI = process.env.MONGODB_URI
const SESSION_SECRET = process.env.SESSION_SECRET
const NODE_ENV = process.env.NODE_ENV || 'development'
const IS_PROD = NODE_ENV === 'production'
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 12

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI. Copy .env.example to .env and set it.')
  process.exit(1)
}
if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
  console.error('Missing or weak SESSION_SECRET. Set a long random value in .env.')
  process.exit(1)
}

const app = express()
const client = new MongoClient(MONGODB_URI)

app.set('trust proxy', 1)
app.use(express.json({ limit: '100kb' }))

function db() {
  return client.db()
}
function usersCollection() {
  return db().collection('users')
}
function contactsCollection() {
  return db().collection('contacts')
}
function remindersCollection() {
  return db().collection('reminders')
}

function parseObjectId(id) {
  if (typeof id !== 'string' || !ObjectId.isValid(id)) return null
  return new ObjectId(id)
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function serializeUser(doc) {
  return {
    id: String(doc._id),
    email: doc.email,
  }
}

function serializeContact(doc) {
  const { _id, userId: _userId, ...rest } = doc
  return {
    id: String(_id),
    ...rest,
  }
}

function serializeReminder(doc) {
  const { _id, userId: _userId, ...rest } = doc
  return {
    id: String(_id),
    ...rest,
  }
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

function sessionUserId(req) {
  return parseObjectId(req.session.userId)
}

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex')
  }
  return req.session.csrfToken
}

function requireAuth(req, res, next) {
  if (!req.session?.userId || !sessionUserId(req)) {
    return res.status(401).json({
      ok: false,
      message: 'Authentication required',
    })
  }
  next()
}

function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  const expected = req.session?.csrfToken
  const provided = req.get('x-csrf-token')
  if (!expected || !provided || expected !== provided) {
    return res.status(403).json({
      ok: false,
      message: 'Invalid or missing CSRF token',
    })
  }
  next()
}

async function getOwnedContact(contactId, userId) {
  const objectId = parseObjectId(contactId)
  if (!objectId || !userId) return null
  return contactsCollection().findOne({ _id: objectId, userId })
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    message: 'Too many login attempts. Try again later.',
  },
})

async function ensureIndexes() {
  await usersCollection().createIndex(
    { email: 1 },
    { unique: true, name: 'users_email_unique' },
  )
  await contactsCollection().createIndex(
    { userId: 1 },
    { name: 'contacts_userId' },
  )
  await remindersCollection().createIndex(
    { userId: 1 },
    { name: 'reminders_userId' },
  )
  await remindersCollection().createIndex(
    { userId: 1, contactId: 1 },
    { name: 'reminders_user_contact' },
  )
}

async function start() {
  await client.connect()
  await client.db().command({ ping: 1 })
  await ensureIndexes()
  console.log('Connected to MongoDB')

  app.use(
    session({
      name: 'peoplesnote.sid',
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: MongoStore.create({
        client,
        collectionName: 'sessions',
        ttl: 60 * 60 * 24 * 14,
      }),
      cookie: {
        httpOnly: true,
        secure: IS_PROD,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 14,
      },
    }),
  )

  // Public health check (no auth)
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

  // Issue / refresh CSRF token (creates a session if needed)
  app.get('/api/auth/csrf', (req, res) => {
    const csrfToken = ensureCsrfToken(req)
    res.json({ csrfToken })
  })

  app.get('/api/auth/me', (req, res) => {
    if (!req.session?.userId) {
      return res.json({ user: null, csrfToken: ensureCsrfToken(req) })
    }
    usersCollection()
      .findOne({ _id: sessionUserId(req) })
      .then((user) => {
        if (!user) {
          req.session.destroy(() => {})
          return res.json({ user: null, csrfToken: ensureCsrfToken(req) })
        }
        res.json({
          user: serializeUser(user),
          csrfToken: ensureCsrfToken(req),
        })
      })
      .catch((err) => {
        console.error('GET /api/auth/me failed:', err.message)
        res.status(500).json({ ok: false, message: 'Failed to load session' })
      })
  })

  app.post('/api/auth/signup', requireCsrf, async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email)
      const password =
        typeof req.body?.password === 'string' ? req.body.password : ''

      if (!isValidEmail(email)) {
        return res.status(400).json({
          ok: false,
          message: 'Enter a valid email address',
        })
      }
      if (password.length < 8) {
        return res.status(400).json({
          ok: false,
          message: 'Password must be at least 8 characters',
        })
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
      const doc = {
        email,
        passwordHash,
        createdAt: new Date(),
      }

      let result
      try {
        result = await usersCollection().insertOne(doc)
      } catch (err) {
        if (err?.code === 11000) {
          return res.status(409).json({
            ok: false,
            message: 'An account with that email already exists',
          })
        }
        throw err
      }

      req.session.userId = String(result.insertedId)
      ensureCsrfToken(req)

      res.status(201).json({
        ok: true,
        user: { id: String(result.insertedId), email },
        csrfToken: req.session.csrfToken,
      })
    } catch (err) {
      console.error('POST /api/auth/signup failed:', err.message)
      res.status(500).json({
        ok: false,
        message: 'Failed to create account',
      })
    }
  })

  app.post('/api/auth/login', loginLimiter, requireCsrf, async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email)
      const password =
        typeof req.body?.password === 'string' ? req.body.password : ''

      if (!email || !password) {
        return res.status(400).json({
          ok: false,
          message: 'Email and password are required',
        })
      }

      const user = await usersCollection().findOne({ email })
      // Timing stand-in only — not a real account password.
      const DUMMY_PASSWORD_HASH =
        '$2b$12$aQI2f2tXMXC99284XWQgbuT/r1t.OAyPY1MYaQk1kXRvmGcDn.XCu'
      let match = false
      try {
        match = await bcrypt.compare(
          password,
          user?.passwordHash || DUMMY_PASSWORD_HASH,
        )
      } catch {
        match = false
      }

      if (!user || !match) {
        return res.status(401).json({
          ok: false,
          message: 'Invalid email or password',
        })
      }

      req.session.userId = String(user._id)
      ensureCsrfToken(req)

      res.json({
        ok: true,
        user: serializeUser(user),
        csrfToken: req.session.csrfToken,
      })
    } catch (err) {
      console.error('POST /api/auth/login failed:', err.message)
      res.status(500).json({
        ok: false,
        message: 'Failed to log in',
      })
    }
  })

  app.post('/api/auth/logout', requireCsrf, (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        console.error('Logout failed:', err.message)
        return res.status(500).json({
          ok: false,
          message: 'Failed to log out',
        })
      }
      res.clearCookie('peoplesnote.sid')
      res.json({ ok: true })
    })
  })

  // —— Protected data routes ——
  app.use('/api/contacts', requireAuth, requireCsrf)
  app.use('/api/reminders', requireAuth, requireCsrf)

  app.get('/api/contacts', async (req, res) => {
    try {
      const userId = sessionUserId(req)
      const docs = await contactsCollection()
        .find({ userId })
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
      const userId = sessionUserId(req)
      const contact = normalizeIncomingContact(req.body)

      if (!contact.name) {
        return res.status(400).json({
          ok: false,
          message: 'Name is required',
        })
      }

      const doc = {
        ...contact,
        userId,
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
      const userId = sessionUserId(req)
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
        { _id: objectId, userId },
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
      const userId = sessionUserId(req)
      const objectId = parseObjectId(req.params.id)
      if (!objectId) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid contact id',
        })
      }

      const result = await contactsCollection().deleteOne({
        _id: objectId,
        userId,
      })
      if (result.deletedCount === 0) {
        return res.status(404).json({
          ok: false,
          message: 'Contact not found',
        })
      }

      const reminderCleanup = await remindersCollection().deleteMany({
        userId,
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

  app.get('/api/reminders', async (req, res) => {
    try {
      const userId = sessionUserId(req)
      const docs = await remindersCollection()
        .find({ userId })
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
      const userId = sessionUserId(req)
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

      const ownedContact = await getOwnedContact(reminder.contactId, userId)
      if (!ownedContact) {
        return res.status(400).json({
          ok: false,
          message: 'Contact not found for this reminder',
        })
      }

      const doc = {
        ...reminder,
        userId,
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

  app.post('/api/reminders/import', async (req, res) => {
    try {
      const userId = sessionUserId(req)
      const incoming = Array.isArray(req.body?.reminders)
        ? req.body.reminders
        : []
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

        const ownedContact = await getOwnedContact(reminder.contactId, userId)
        if (!ownedContact) {
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
              userId,
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
              userId,
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
          userId,
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
      const userId = sessionUserId(req)
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
        { _id: objectId, userId },
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
      const userId = sessionUserId(req)
      const objectId = parseObjectId(req.params.id)
      if (!objectId) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid reminder id',
        })
      }

      const result = await remindersCollection().deleteOne({
        _id: objectId,
        userId,
      })
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

  app.listen(PORT, HOST, () => {
    console.log(`PeoplesNote API listening on http://${HOST}:${PORT}`)
  })
}

start().catch((err) => {
  console.error('Failed to start server:', err.message)
  process.exit(1)
})

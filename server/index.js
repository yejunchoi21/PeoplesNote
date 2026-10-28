import 'dotenv/config'
import express from 'express'
import { MongoClient } from 'mongodb'

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

/** Turn a Mongo document into the shape the React app expects. */
function serializeContact(doc) {
  const { _id, ...rest } = doc
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

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

app.get('/api/health', async (_req, res) => {
  try {
    // ping fails if MongoDB is down or unreachable
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

async function start() {
  try {
    await client.connect()
    // Verify the connection once at startup
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

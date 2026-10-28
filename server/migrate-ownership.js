/**
 * Explicit one-time migration: assign orphan contacts/reminders (no userId)
 * to an existing account. Does NOT run on signup.
 *
 * Usage:
 *   node migrate-ownership.js you@example.com
 */
import 'dotenv/config'
import { MongoClient } from 'mongodb'

const MONGODB_URI = process.env.MONGODB_URI
const emailArg = process.argv[2]

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

async function main() {
  if (!MONGODB_URI) {
    console.error('Missing MONGODB_URI in .env')
    process.exit(1)
  }
  if (!emailArg) {
    console.error('Usage: node migrate-ownership.js <account-email>')
    process.exit(1)
  }

  const email = normalizeEmail(emailArg)
  const client = new MongoClient(MONGODB_URI)

  try {
    await client.connect()
    const db = client.db()
    const user = await db.collection('users').findOne({ email })
    if (!user) {
      console.error(`No user found for email: ${email}`)
      process.exit(1)
    }

    const orphanFilter = {
      $or: [{ userId: { $exists: false } }, { userId: null }],
    }

    const contacts = await db
      .collection('contacts')
      .updateMany(orphanFilter, { $set: { userId: user._id } })
    const reminders = await db
      .collection('reminders')
      .updateMany(orphanFilter, { $set: { userId: user._id } })

    console.log(`Assigned orphan data to ${email} (${user._id})`)
    console.log(`  contacts updated:  ${contacts.modifiedCount}`)
    console.log(`  reminders updated: ${reminders.modifiedCount}`)
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})

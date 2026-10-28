/**
 * Removes leftover automated-test accounts and their data.
 * Safe: only deletes users whose emails match known test patterns.
 *
 * Patterns:
 *   alice_<digits>@example.com
 *   bob_<digits>@example.com
 *   iso_a_<digits>@example.com
 *   iso_b_<digits>@example.com
 *
 * Usage:
 *   node cleanup-test-accounts.js
 *   node cleanup-test-accounts.js --dry-run
 */
import 'dotenv/config'
import { MongoClient } from 'mongodb'

const dryRun = process.argv.includes('--dry-run')
const MONGODB_URI = process.env.MONGODB_URI

const TEST_EMAIL =
  /^(alice_|bob_|iso_a_|iso_b_)\d+@example\.com$/i

async function main() {
  if (!MONGODB_URI) {
    console.error('Missing MONGODB_URI in .env')
    process.exit(1)
  }

  const client = new MongoClient(MONGODB_URI)
  try {
    await client.connect()
    const db = client.db()
    const users = await db.collection('users').find({}).toArray()
    const testUsers = users.filter((u) => TEST_EMAIL.test(u.email || ''))

    if (testUsers.length === 0) {
      console.log('No matching test accounts found.')
      return
    }

    console.log(
      `${dryRun ? 'Would remove' : 'Removing'} ${testUsers.length} test account(s):`,
    )
    for (const u of testUsers) {
      console.log(`  - ${u.email}`)
    }

    if (dryRun) return

    const ids = testUsers.map((u) => u._id)
    const contacts = await db
      .collection('contacts')
      .deleteMany({ userId: { $in: ids } })
    const reminders = await db
      .collection('reminders')
      .deleteMany({ userId: { $in: ids } })
    const deletedUsers = await db
      .collection('users')
      .deleteMany({ _id: { $in: ids } })

    console.log(`Deleted users:     ${deletedUsers.deletedCount}`)
    console.log(`Deleted contacts:  ${contacts.deletedCount}`)
    console.log(`Deleted reminders: ${reminders.deletedCount}`)
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})

// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const previous = process.cwd(), temp = mkdtempSync(path.join(os.tmpdir(), 'sparkwright-account-init-'))
process.chdir(temp)
process.env.AUTH_SECRET = randomBytes(48).toString('hex')
const { initializeOwner } = await import('../scripts/init-account')
const { db } = await import('../server/db')
const { comparePassword } = await import('../server/auth')
after(async () => {
  db.close(); process.chdir(previous)
  assert.ok(path.resolve(temp).startsWith(path.join(os.tmpdir(), 'sparkwright-account-init-')))
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(error => {
    if (!['EBUSY', 'EPERM'].includes(error.code) || readdirSync(temp).length) throw error
  })
})

test('fresh installation creates only the operator account, stores a hash, and refuses overwrite', async () => {
  await assert.rejects(initializeOwner({ email: 'invalid', name: 'Owner', password: 'short' }))
  assert.equal((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n, 0)
  const password = 'Fixture-Only-Password-2026'
  const id = await initializeOwner({ email: 'LOCAL@EXAMPLE.INVALID', name: 'Local owner', password })
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, any>
  assert.equal(owner.email, 'local@example.invalid')
  assert.equal(owner.role, 'owner')
  assert.ok(owner.email_verified_at)
  assert.notEqual(owner.password_hash, password)
  assert.ok(comparePassword(password, owner.password_hash))
  await assert.rejects(initializeOwner({ email: 'other@example.invalid', name: 'Other owner', password }), /已有账号/)
  assert.equal((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n, 1)
})

// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

// In-process fixture only: the executable server never loads this helper.
export function testMailbox() {
  process.env.EMAIL_VERIFICATION_SECRET = randomBytes(32).toString('base64')
  const codes = new Map<string, string>()
  let address = 1
  return {
    options: { enabled: true, mailer: { ready() {}, async send(email: string, code: string) { codes.set(email, code) } } },
    async proof(app: FastifyInstance, email: string) {
      const sent = await app.inject({ method: 'POST', url: '/api/auth/register/send-code', remoteAddress: `127.45.0.${address++}`, payload: { email } })
      assert.equal(sent.statusCode, 200, 'Isolated verification send failed')
      return { verificationId: sent.json().verificationId, code: codes.get(email.trim().toLowerCase())! }
    },
  }
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

const PORT = 4996

let server: Server
let client: Client

function signUp(email: string, name: string) {
  return client.req('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: server.base },
    body: JSON.stringify({ email, password: 'password12345', name }),
  })
}

beforeAll(async () => {
  server = await startServer(PORT, { SIGNUP_EMAILS: 'Owner@Example.com, second@partner.test' })
  client = new Client(server)
}, 70_000)

afterAll(() => server?.stop())

describe('signup exact-email allowlist', () => {
  it('allows a listed address, case-insensitively', async () => {
    const res = await signUp('owner@example.COM', 'Owner')
    expect(res.status, await res.text()).toBe(200)
  })

  it('rejects another address on a listed address’s domain without revealing the list', async () => {
    const email = 'stranger@example.com'
    const res = await signUp(email, 'Stranger')
    expect(res.status).toBe(400)
    const { message } = await res.json()
    expect(message).toMatch(/^Sign up is restricted/)
    expect(message).not.toContain('example.com')
    expect(message).not.toContain('partner.test')

    const exists = await client.post('/api/account-exists', { email })
    expect(await exists.json()).toEqual({ exists: false })
  })
})

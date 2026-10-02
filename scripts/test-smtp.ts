// SPDX-License-Identifier: MPL-2.0
import net from 'node:net'
import { once } from 'node:events'

// Local SMTP wire fixture. No message/credential is printed or saved to disk.
export async function testSmtp() {
  const messages = new Map<string, { code: string; text: string; from: string; recipients: string[]; subject: string }>()
  const sockets = new Set<net.Socket>()
  const behavior = { reject: false, holdGreeting: false }
  const decode = (text: string) => Buffer.from(text.replace(/=\r\n/g, '').replace(/=([A-F0-9]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8')
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    let buffer = '', data: string[] | null = null, from = '', recipients: string[] = []
    if (!behavior.holdGreeting) socket.write('220 test.invalid SMTP fixture\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        if (data) {
          if (line !== '.') { data.push(line.startsWith('..') ? line.slice(1) : line); continue }
          const raw = data.join('\r\n'), split = raw.indexOf('\r\n\r\n'), body = raw.slice(split + 4)
          const text = /^Content-Transfer-Encoding: base64\r?$/mi.test(raw.slice(0, split)) ? Buffer.from(body, 'base64').toString('utf8') : decode(body)
          const subjectRaw = /^Subject: (.*(?:\r\n[ \t].*)*)/m.exec(raw)?.[1].replace(/\r\n[ \t]+/g, '') || ''
          const subject = subjectRaw.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, encoded) => Buffer.from(encoded, 'base64').toString('utf8')).replace(/=\?UTF-8\?Q\?([^?]+)\?=/gi, (_, encoded) => decode(encoded.replace(/_/g, ' '))).trim()
          for (const email of recipients) messages.set(email, { code: /验证码是：(\d{6})/.exec(text)?.[1] || '', text, from, recipients: [...recipients], subject })
          data = null; socket.write('250 accepted fixture\r\n'); continue
        }
        if (/^EHLO|^HELO/i.test(line)) socket.write('250-test.invalid\r\n250 AUTH PLAIN\r\n')
        else if (/^AUTH PLAIN/i.test(line)) socket.write('235 authenticated fixture\r\n')
        else if (/^MAIL FROM:/i.test(line)) { from = /<([^>]+)>/.exec(line)?.[1] || ''; recipients = []; socket.write('250 sender accepted\r\n') }
        else if (/^RCPT TO:/i.test(line)) {
          if (behavior.reject) socket.write('550 rejected fixture\r\n')
          else { recipients.push(/<([^>]+)>/.exec(line)?.[1] || ''); socket.write('250 recipient accepted\r\n') }
        } else if (/^DATA$/i.test(line)) { data = []; socket.write('354 send data\r\n') }
        else if (/^QUIT$/i.test(line)) socket.end('221 bye\r\n')
        else socket.write('250 ok\r\n')
      }
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { port: (server.address() as net.AddressInfo).port, messages, behavior,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())) } }
}

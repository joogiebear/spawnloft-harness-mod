#!/usr/bin/env node
// Talks to a running harness: node scripts/probe.mjs <gameDir> <token> [op ...]
// Default ops: hello status screenshot quit. Each op may carry JSON args: 'chat:{"text":"hi"}'.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'

const [gameDir, token, ...ops] = process.argv.slice(2)
if (!gameDir || !token) {
  console.error('usage: probe.mjs <gameDir> <token> [op[:jsonArgs] ...]')
  process.exit(2)
}
const info = JSON.parse(fs.readFileSync(path.join(gameDir, 'spawnloft-harness.json'), 'utf8'))
const plan = ops.length ? ops : ['hello', 'status', 'screenshot', 'quit']
const sock = net.connect({ host: '127.0.0.1', port: info.port })
const rl = readline.createInterface({ input: sock })
const pending = new Map()
let id = 0
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  console.log('<', line)
  const p = pending.get(msg.id)
  if (p) { pending.delete(msg.id); p(msg) }
})
const send = (op, args = {}) => new Promise((resolve) => {
  const req = { id: ++id, op, ...args }
  pending.set(req.id, resolve)
  const text = JSON.stringify(req)
  console.log('>', text)
  sock.write(text + '\n')
})
sock.on('connect', async () => {
  const first = plan[0] === 'hello' ? plan.shift() : 'hello'
  await send(first, { token })
  for (const item of plan) {
    const i = item.indexOf(':')
    const op = i === -1 ? item : item.slice(0, i)
    const args = i === -1 ? {} : JSON.parse(item.slice(i + 1))
    await send(op, args)
  }
  sock.end()
})
sock.on('error', (e) => { console.error(e.message); process.exit(1) })

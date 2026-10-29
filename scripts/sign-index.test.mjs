// node --test scripts/ : the signing script, with keys made here (no private key is checked in).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { addRow, removeRow, revokeKey, signIndex, verifyIndex, validate, format, signedBytes, spkiOf, publishedSerial, INDEX_FILE, SIG_FILE } from './sign-index.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-index-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

function keyFile(name) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  const file = path.join(scratch, `${name}.pem`)
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return { file, spki: spkiOf(privateKey) }
}
const primary = keyFile('primary')
const spare = keyFile('spare')
const known = [{ name: 'primary', spki: primary.spki }, { name: 'spare', spki: spare.spki }]

let repos = 0
function repo() {
  const dir = path.join(scratch, `repo-${++repos}`)
  fs.mkdirSync(dir)
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'user.name', 't')
  return { dir, commit: () => { git('add', '-A'); git('commit', '-qm', 'x') } }
}
const jar = path.join(scratch, 'spawnloft-harness-0.1.0+1.21.11.jar')
fs.writeFileSync(jar, 'not really a jar')
const jarHash = crypto.createHash('sha256').update('not really a jar').digest('hex')
const offline = { offline: true }

test('add hashes the jar it is given and builds the row; a second row for the same id is refused', () => {
  const { dir } = repo()
  const r = addRow(dir, { minecraft: ['1.21.11'], version: '0.1.0', tag: 'v0.1.0-mc1.21.11', jar })
  assert.equal(r.sha256, jarHash)
  assert.deepEqual(r.row, { minecraft: ['1.21.11'], version: '0.1.0', tag: 'v0.1.0-mc1.21.11', file: 'spawnloft-harness-0.1.0+1.21.11.jar', sha256: jarHash })
  assert.throws(() => addRow(dir, { minecraft: ['1.21.11'], version: '0.1.1', tag: 'v0.1.1-mc1.21.11', jar }), /listed twice/)
  assert.throws(() => addRow(dir, { minecraft: ['26.3'], version: '0.2.0', tag: 'v0.2.0-mc26.3/..', jar }), /tag/)
  assert.throws(() => addRow(dir, { minecraft: ['26.3'], version: '0.2.0', tag: 'v0.2.0-mc26.3' }), /--jar/)
  // the file is left as it was by a refused add
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8')).rows.length, 1)
})

test('sign gives the next serial above what is committed, in the file and published, and verify accepts it', async () => {
  const { dir, commit } = repo()
  addRow(dir, { minecraft: ['1.21.11'], version: '0.1.0', tag: 'v0.1.0-mc1.21.11', jar })
  const first = await signIndex(dir, { key: primary.file, ...offline })
  assert.equal(first.serial, 1)
  assert.deepEqual(verifyIndex(dir, { knownKeys: known }), { serial: 1, keyName: 'primary', rows: 1 })

  // signed again before committing (a typo fixed): never the same serial twice
  const again = await signIndex(dir, { key: primary.file, ...offline })
  assert.equal(again.serial, 2)
  commit()
  assert.equal((await signIndex(dir, { key: primary.file, ...offline })).serial, 3)
  // a published list ahead of everything local wins
  const ahead = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ serial: 10 }) })
  assert.equal((await signIndex(dir, { key: primary.file, fetchImpl: ahead })).serial, 11)
  const none = async () => ({ ok: false, status: 404, text: async () => 'Not Found' })
  assert.equal(await publishedSerial(none), 0)
  const down = async () => { throw new Error('offline') }
  await assert.rejects(signIndex(dir, { key: primary.file, fetchImpl: down }), /could not read a usable serial.*--offline/)
  // a published serial nothing can follow, or one that is not a serial, is unreadable, not a crash
  for (const serial of [Number.MAX_SAFE_INTEGER, -1, 1.5, '12']) {
    const odd = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ serial }) })
    assert.equal(await publishedSerial(odd), null)
  }
  const huge = async () => ({ ok: true, status: 200, text: async () => ' '.repeat(300 * 1024) + '{"serial":1}' })
  assert.equal(await publishedSerial(huge), null)
  await assert.rejects(signIndex(dir, { key: primary.file, serial: 5, ...offline }), /not above 11/)

  // the written bytes are the script's own formatting, and the .sig is over the domain-prefixed bytes
  const bytes = fs.readFileSync(path.join(dir, INDEX_FILE))
  assert.equal(bytes.toString(), format(JSON.parse(bytes)))
  const sig = Buffer.from(fs.readFileSync(path.join(dir, SIG_FILE), 'utf8').trim(), 'base64')
  const pub = crypto.createPublicKey({ key: Buffer.from(primary.spki, 'base64'), format: 'der', type: 'spki' })
  assert.ok(crypto.verify(null, signedBytes(bytes), pub, sig))
  assert.ok(!crypto.verify(null, bytes, pub, sig))
})

test('verify refuses a key SpawnLoft does not know, an edited file and a reformatted one', async () => {
  const { dir } = repo()
  addRow(dir, { minecraft: ['1.21.11'], version: '0.1.0', tag: 'v0.1.0-mc1.21.11', jar })
  const stranger = keyFile('stranger')
  const r = await signIndex(dir, { key: stranger.file, ...offline })
  assert.equal(r.keyName, null)
  assert.throws(() => verifyIndex(dir, { knownKeys: known }), /do not upload/)

  await signIndex(dir, { key: spare.file, ...offline })
  assert.equal(verifyIndex(dir, { knownKeys: known }).keyName, 'spare')
  const file = path.join(dir, INDEX_FILE)
  const good = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, good.replace('"0.1.0"', '"0.1.1"'))
  assert.throws(() => verifyIndex(dir, { knownKeys: known }), /does not verify/)
  fs.writeFileSync(file, good)
  fs.writeFileSync(path.join(dir, SIG_FILE), 'deadbeef\n')
  assert.throws(() => verifyIndex(dir, { knownKeys: known }), /not one base64/)
})

test('remove and revoke edit the list; the signing key cannot be the one revoked', async () => {
  const { dir } = repo()
  addRow(dir, { minecraft: ['1.21.11'], version: '0.1.0', tag: 'v0.1.0-mc1.21.11', jar })
  addRow(dir, { minecraft: ['26.3'], version: '0.2.0', tag: 'v0.2.0-mc26.3', sha256: 'ab'.repeat(32) })
  removeRow(dir, { minecraft: ['26.3'] })
  assert.throws(() => removeRow(dir, { minecraft: ['26.3'] }), /no row lists/)
  revokeKey(dir, { spki: primary.spki })
  await assert.rejects(signIndex(dir, { key: primary.file, ...offline }), /revokes the key it is being signed with/)
  await signIndex(dir, { key: spare.file, ...offline })
  const doc = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'))
  assert.deepEqual(doc.revoke, [primary.spki])
  assert.deepEqual(doc.rows.map((r) => r.minecraft[0]), ['1.21.11'])
})

test('a key inside the checkout or readable by others is refused', async () => {
  const { dir } = repo()
  addRow(dir, { minecraft: ['1.21.11'], version: '0.1.0', tag: 'v0.1.0-mc1.21.11', jar })
  const inside = path.join(dir, 'key.pem')
  fs.copyFileSync(primary.file, inside)
  await assert.rejects(signIndex(dir, { key: inside, ...offline }), /inside the checkout/)
  if (process.platform !== 'win32') {
    const loose = path.join(scratch, 'loose.pem')
    fs.copyFileSync(primary.file, loose)
    fs.chmodSync(loose, 0o644)
    await assert.rejects(signIndex(dir, { key: loose, ...offline }), /readable by other users/)
  }
})

test('the command line refuses to run below the top of the checkout', () => {
  const { dir, commit } = repo()
  fs.writeFileSync(path.join(dir, 'README.md'), 'x')
  commit()
  fs.mkdirSync(path.join(dir, 'scripts'))
  const script = path.join(import.meta.dirname, 'sign-index.mjs')
  let out = ''
  try {
    execFileSync(process.execPath, [script, 'verify'], { cwd: path.join(dir, 'scripts'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    out = err.stderr
  }
  assert.match(out, /^sign-index: run this from the top of the checkout/)
})

test('validate holds the same rules SpawnLoft reads with', () => {
  const row = { minecraft: ['26.3'], version: '0.2.0', tag: 'v0.2.0-mc26.3', file: 'spawnloft-harness-0.2.0+26.3.jar', sha256: 'ab'.repeat(32) }
  const doc = (extra) => ({ format: 1, serial: 1, rows: [row], ...extra })
  assert.ok(validate(doc()))
  for (const [extra, why] of [
    [{ format: 2 }, /format/],
    [{ rows: [{ ...row, minecraft: ['26.3.'] }] }, /minecraft/],
    [{ rows: [{ ...row, file: 'evil.jar' }] }, /file/],
    [{ rows: [{ ...row, sha256: 'AB'.repeat(32) }] }, /sha256/],
    [{ revoke: ['not a key!'] }, /revoke/],
  ]) assert.throws(() => validate(doc(extra)), why)
})

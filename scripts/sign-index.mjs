#!/usr/bin/env node
// The signed list of harness builds that SpawnLoft reads (harness-index.json and its .sig, both
// uploaded to this repo's `index` release). Run on the signing machine, in a checkout of main:
//
//   node scripts/sign-index.mjs add --minecraft 26.3 --version 0.2.0 --tag v0.2.0-mc26.3 --jar <the jar you tested>
//   node scripts/sign-index.mjs remove --minecraft 26.3
//   node scripts/sign-index.mjs revoke --spki <base64>      (a key SpawnLoft should stop trusting)
//   node scripts/sign-index.mjs sign [--key <pem>] [--serial N] [--offline]
//   node scripts/sign-index.mjs verify
//
// add, remove and revoke only edit harness-index.json. sign gives it the next serial and signs the
// exact bytes it writes; verify checks the pair against the two public keys SpawnLoft carries, so a
// key SpawnLoft does not know is caught before anything is uploaded. The private key is read once
// and never printed. The rules below are copied from SpawnLoft's src/client-harness-index.mjs; keep
// the two in step.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The public keys SpawnLoft trusts (SPKI DER, base64), generated 2026-10-29.
export const KNOWN_KEYS = [
  { name: 'primary', spki: 'MCowBQYDK2VwAyEA4gftri3viZzfRIT7o+lr5ndac+Kd9/KKSIoTFba/DGc=' },
  { name: 'spare', spki: 'MCowBQYDK2VwAyEA7eDiBj6m+d/4AgWLqJEo0QfG4Q6QJHxRgvN7mrR851c=' },
]
export const SIGNATURE_DOMAIN = 'spawnloft-harness-index/1\n'
export const PUBLISHED_URL = 'https://github.com/joogiebear/spawnloft-harness-mod/releases/download/index/harness-index.json'
export const INDEX_FILE = 'harness-index.json'
export const SIG_FILE = 'harness-index.json.sig'
export const DEFAULT_KEY = path.join(os.homedir(), '.spawnloft-signing', 'harness-index-ed25519.pem')

const MAX_ROWS = 100
const MAX_REVOKE = 8
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/
const TAG_RE = /^v[0-9A-Za-z][0-9A-Za-z.-]{0,39}-mc[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const FILE_RE = /^spawnloft-harness-[0-9A-Za-z][0-9A-Za-z.-]{0,39}\+[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.jar$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SIG_RE = /^[A-Za-z0-9+/]{86}==$/
const SPKI_RE = /^[A-Za-z0-9+/]{40,120}={0,2}$/

export class SignError extends Error {}
const fail = (msg) => { throw new SignError(msg) }

// SpawnLoft's isSafeVersionId
function isSafeVersionId(id) {
  return typeof id === 'string' && id === id.trim() && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(id) && !id.includes('..') && !/[. ]$/.test(id)
}

export function validate(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) fail('not a JSON object')
  if (doc.format !== 1) fail(`format must be 1, not ${JSON.stringify(doc.format)}`)
  if (!Number.isSafeInteger(doc.serial) || doc.serial < 0) fail('serial is not a whole number')
  if (!Array.isArray(doc.rows) || doc.rows.length > MAX_ROWS) fail(`rows must be a list of at most ${MAX_ROWS}`)
  const seen = new Set()
  doc.rows.forEach((r, i) => {
    const bad = (field, why) => fail(`row ${i + 1}: ${field} ${why}`)
    if (!Array.isArray(r.minecraft) || r.minecraft.length === 0 || r.minecraft.length > 20) bad('minecraft', 'must be a list of 1 to 20 version ids')
    for (const id of r.minecraft) {
      if (!isSafeVersionId(id)) bad('minecraft', `has an id SpawnLoft would not use (${JSON.stringify(id)})`)
      if (seen.has(id)) fail(`Minecraft ${id} is listed twice`)
      seen.add(id)
    }
    if (!VERSION_RE.test(r.version ?? '')) bad('version', 'is not a mod version')
    if (!TAG_RE.test(r.tag ?? '')) bad('tag', 'is not a harness release tag')
    if (!FILE_RE.test(r.file ?? '')) bad('file', 'is not a harness jar name')
    if (!SHA256_RE.test(r.sha256 ?? '')) bad('sha256', 'is not 64 lowercase hex digits')
  })
  if (doc.revoke !== undefined && (!Array.isArray(doc.revoke) || doc.revoke.length > MAX_REVOKE || !doc.revoke.every((k) => SPKI_RE.test(k)))) {
    fail(`revoke must be a list of at most ${MAX_REVOKE} public keys`)
  }
  return doc
}

// The one way the file is written: fixed key order, two-space indent, trailing newline. The bytes
// signed are these bytes.
export function format(doc) {
  const out = { format: 1, serial: doc.serial, generated: doc.generated ?? null }
  if (doc.revoke?.length) out.revoke = doc.revoke
  out.rows = doc.rows.map((r) => ({ minecraft: r.minecraft, version: r.version, tag: r.tag, file: r.file, sha256: r.sha256 }))
  return `${JSON.stringify(out, null, 2)}\n`
}

export const signedBytes = (bytes) => Buffer.concat([Buffer.from(SIGNATURE_DOMAIN), bytes])

export function spkiOf(key) {
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
}

function readDoc(dir) {
  const p = path.join(dir, INDEX_FILE)
  if (!fs.existsSync(p)) return { format: 1, serial: 0, generated: null, rows: [] }
  try {
    return validate(JSON.parse(fs.readFileSync(p, 'utf8')))
  } catch (err) {
    fail(`${INDEX_FILE}: ${err.message}`)
  }
}

function writeDoc(dir, doc) {
  fs.writeFileSync(path.join(dir, INDEX_FILE), format(validate(doc)))
}

export function addRow(dir, { minecraft, version, tag, jar = null, sha256 = null, file = null }) {
  const ids = [].concat(minecraft ?? [])
  if (!ids.length) fail('--minecraft is required')
  if (!version) fail('--version is required')
  if (!tag) fail('--tag is required')
  let hash = sha256?.toLowerCase() ?? null
  if (jar) hash = crypto.createHash('sha256').update(fs.readFileSync(jar)).digest('hex')
  if (!hash) fail('--jar <the jar you tested> (or --sha256) is required')
  const doc = readDoc(dir)
  doc.rows.push({ minecraft: ids, version, tag, file: file ?? `spawnloft-harness-${version}+${ids[0]}.jar`, sha256: hash })
  writeDoc(dir, doc)
  return { sha256: hash, row: doc.rows.at(-1) }
}

export function removeRow(dir, { minecraft }) {
  const ids = [].concat(minecraft ?? [])
  const doc = readDoc(dir)
  const before = JSON.stringify(doc.rows)
  doc.rows = doc.rows.map((r) => ({ ...r, minecraft: r.minecraft.filter((id) => !ids.includes(id)) })).filter((r) => r.minecraft.length)
  if (JSON.stringify(doc.rows) === before) fail(`no row lists ${ids.join(', ')}`)
  writeDoc(dir, doc)
}

export function revokeKey(dir, { spki }) {
  if (!SPKI_RE.test(spki ?? '')) fail('--spki must be a base64 public key')
  const doc = readDoc(dir)
  doc.revoke = [...new Set([...(doc.revoke ?? []), spki])]
  writeDoc(dir, doc)
}

function committedSerial(dir) {
  try {
    const text = execFileSync('git', ['show', `HEAD:${INDEX_FILE}`], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return Number(JSON.parse(text).serial) || 0
  } catch {
    return 0
  }
}

// The serial of the list SpawnLoft reads now; 0 when none is published; null when it could not
// be read or its serial is not one a next serial can follow (sign then refuses unless --offline,
// so a re-sign cannot reuse a published serial). Not signature-checked: it only raises the floor.
const PUBLISHED_MAX_BYTES = 256 * 1024
export async function publishedSerial(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(PUBLISHED_URL, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'spawnloft-harness sign-index' } })
    if (res.status === 404) return 0
    if (!res.ok) return null
    const text = await res.text()
    if (text.length > PUBLISHED_MAX_BYTES) return null
    const serial = JSON.parse(text).serial
    return Number.isSafeInteger(serial) && serial >= 0 && serial < Number.MAX_SAFE_INTEGER ? serial : null
  } catch {
    return null
  }
}

function readPrivateKey(keyPath, dir) {
  const real = fs.realpathSync(keyPath)
  const repo = fs.realpathSync(dir)
  if (real === repo || real.startsWith(repo + path.sep)) fail(`the private key ${keyPath} is inside the checkout; keep it outside, see the README`)
  if (process.platform !== 'win32' && (fs.statSync(real).mode & 0o077)) fail(`${keyPath} is readable by other users; chmod 600 it first`)
  return crypto.createPrivateKey(fs.readFileSync(real))
}

// Gives the list the next serial, writes it, and signs the written bytes.
export async function signIndex(dir, { key = DEFAULT_KEY, serial = null, offline = false, now = new Date(), fetchImpl } = {}) {
  const doc = readDoc(dir)
  const privateKey = readPrivateKey(key, dir)
  const spki = spkiOf(privateKey)
  if (doc.revoke?.includes(spki)) fail('the list revokes the key it is being signed with; sign with the other key')
  const published = offline ? 0 : await publishedSerial(fetchImpl)
  if (published === null) fail(`could not read a usable serial from the published list (${PUBLISHED_URL}) to pick one above it; try again. If it is unreachable, or what is published there is not a list you signed, use --offline and see "If a private key is lost or leaks" in the README`)
  const next = Math.max(committedSerial(dir), doc.serial, published) + 1
  if (!Number.isSafeInteger(next)) fail(`the next serial would be ${next}, which is past what SpawnLoft can read; see "If a private key is lost or leaks" in the README`)
  if (serial !== null && serial < next) fail(`--serial ${serial} is not above ${next - 1}, the highest serial committed, in the file or published`)
  doc.serial = serial ?? next
  doc.generated = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  writeDoc(dir, doc)
  const bytes = fs.readFileSync(path.join(dir, INDEX_FILE))
  const sig = crypto.sign(null, signedBytes(bytes), privateKey).toString('base64')
  fs.writeFileSync(path.join(dir, SIG_FILE), `${sig}\n`)
  const known = KNOWN_KEYS.find((k) => k.spki === spki)
  return { serial: doc.serial, spki, keyName: known?.name ?? null, published }
}

// Checks the pair on disk the way SpawnLoft will: { serial, keyName }. Throws when the signature
// does not verify with a key SpawnLoft knows.
export function verifyIndex(dir, { knownKeys = KNOWN_KEYS } = {}) {
  const bytes = fs.readFileSync(path.join(dir, INDEX_FILE))
  const sigLine = fs.readFileSync(path.join(dir, SIG_FILE), 'utf8').replace(/[\r\n\t ]+$/, '')
  if (!SIG_RE.test(sigLine)) fail(`${SIG_FILE} is not one base64 Ed25519 signature`)
  const sig = Buffer.from(sigLine, 'base64')
  const key = knownKeys.find((k) => crypto.verify(null, signedBytes(bytes), crypto.createPublicKey({ key: Buffer.from(k.spki, 'base64'), format: 'der', type: 'spki' }), sig))
  if (!key) fail('the signature does not verify with either key SpawnLoft trusts: do not upload this')
  const doc = validate(JSON.parse(bytes.toString('utf8')))
  if (bytes.toString('utf8') !== format(doc)) fail(`${INDEX_FILE} is not in the script's own formatting; run sign again`)
  if (doc.serial < 1) fail('the list has never been signed')
  return { serial: doc.serial, keyName: key.name, rows: doc.rows.length }
}

function args(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const name = a.slice(2)
    if (name === 'offline') { out.offline = true; continue }
    const value = argv[++i]
    if (value === undefined) fail(`${a} needs a value`)
    out[name] = name === 'minecraft' ? [...(out.minecraft ?? []), value] : value
  }
  return out
}

// Run from the top of the checkout: the list's path, the committed serial and the check that the
// key is outside the checkout all count from there.
function checkoutRoot() {
  let top
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    fail('run this inside a checkout of spawnloft-harness-mod')
  }
  if (fs.realpathSync(top) !== fs.realpathSync(process.cwd())) fail(`run this from the top of the checkout (${top}), not from a folder inside it`)
  return top
}

async function main(argv) {
  const a = args(argv)
  const dir = checkoutRoot()
  switch (a._[0]) {
    case 'add': {
      const { sha256, row } = addRow(dir, { minecraft: a.minecraft, version: a.version, tag: a.tag, jar: a.jar, sha256: a.sha256, file: a.file })
      console.log(`added ${row.file} for ${row.minecraft.join(', ')}, sha256 ${sha256}`)
      break
    }
    case 'remove':
      removeRow(dir, { minecraft: a.minecraft })
      console.log(`removed ${a.minecraft.join(', ')}`)
      break
    case 'revoke':
      revokeKey(dir, { spki: a.spki })
      console.log(`the next signed list revokes ${a.spki}`)
      break
    case 'sign': {
      const r = await signIndex(dir, { key: a.key ?? DEFAULT_KEY, serial: a.serial === undefined ? null : Number(a.serial), offline: Boolean(a.offline) })
      console.log(`signed serial ${r.serial} (published: ${r.published}) with ${r.keyName ? `the ${r.keyName} key` : 'a key SpawnLoft does NOT know'}: ${r.spki}`)
      if (!r.keyName) process.exitCode = 1
      break
    }
    case 'verify': {
      const r = verifyIndex(dir)
      console.log(`ok: serial ${r.serial}, ${r.rows} row(s), verifies with the ${r.keyName} key`)
      break
    }
    default:
      console.log('usage: node scripts/sign-index.mjs add|remove|revoke|sign|verify (see the top of this file)')
      process.exitCode = 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`sign-index: ${err instanceof SignError ? '' : 'unexpected error: '}${err.message}`)
    process.exitCode = 1
  })
}

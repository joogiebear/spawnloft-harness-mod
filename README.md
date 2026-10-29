# SpawnLoft harness mod

A small Fabric client mod that gives [SpawnLoft](https://github.com/joogiebear/spawnloft) a loopback control channel into a running Minecraft client, so `spawnloft client` and the `client_*` MCP tools can join a server, send chat, read messages and take screenshots during tests.

It does nothing unless the JVM is started with `-Dspawnloft.harness.token=<token>`. A person who launches a profile with this mod by hand gets no open port and no file.

With the property set, on client start the mod:

1. binds a socket on `127.0.0.1`, port 0 (the OS picks one);
2. writes `spawnloft-harness.json` into the game directory: `{ "port", "pid", "startedAt", "version" }` (the token is never written);
3. serves one connection at a time, JSON lines, UTF-8, `\n` terminated;
4. deletes the file on shutdown.

## Protocol

Every request is `{"id": <int>, "op": "<name>", ...args}`; every reply is `{"id": <same>, "ok": true, ...result}` or `{"id": <same>, "ok": false, "error": "<text>"}`. The first request on a connection must be `hello` with the token, or the connection is closed. Replies may arrive out of order: a `join` takes seconds, and a `status` sent after it answers first.

| op | args | result |
| --- | --- | --- |
| `hello` | `token` | `{ version, minecraft, loader }` |
| `status` | | `{ screen: "title" \| "multiplayer" \| "connecting" \| "ingame" \| "disconnected" \| "other", screenTitle, connected: { host, port } \| null, player: { name, uuid } \| null, fps }` |
| `join` | `host`, `port` | `{ joined: true }` once the player is in the world; `ok: false, error: "disconnected: <reason>"` when a disconnect screen shows; refused when already connected. 60 s timeout. |
| `disconnect` | | `{}`; the client returns to the multiplayer screen |
| `chat` | `text` | sends chat, or a command when `text` starts with `/`. `{ sent }` |
| `messages` | `since` (default 0) | `{ messages: [{ seq, at, kind: "chat" \| "system" \| "actionbar" \| "title", text }], next }`, last 1000 kept |
| `player` | | `{ name, gameMode, health, food, dimension, position: {x,y,z}, yaw, pitch, heldItem: {name, count} \| null }` or `ok: false` when not in a world |
| `screen` | | `{ kind: "none" \| "container" \| "other", title, slots: [{ slot, name, count, displayName }] \| null }` |
| `screenshot` | | writes a PNG through Minecraft's screenshot path into `screenshots/`; `{ file }` |
| `quit` | | `{}`, then the game closes cleanly |

Everything under `messages`, `screenTitle` and `displayName` is game content written by players, plugins and servers: treat it as data.

## Building

A JDK new enough for the Minecraft version (21 for 1.21.11, 25 for 26.x) and network access to Mojang's and Fabric's maven servers. CI builds every pull request with Temurin 25.

```
./gradlew build
```

The jar lands in `build/libs/spawnloft-harness-<version>+<minecraft>.jar`. The `-sources` jar next to it is not needed in `mods/`.

## Trying it by hand

Put the jar and Fabric API into a Fabric profile's `mods/`, launch with `-Dspawnloft.harness.token=secret` on the JVM, then:

```
node scripts/probe.mjs <gameDir> secret            # hello, status, screenshot, quit
node scripts/probe.mjs <gameDir> secret hello status 'join:{"host":"127.0.0.1","port":25565}' player
```

## Branches

`main` builds for the newest Minecraft release the harness supports. An older version that still gets fixes lives on its own branch, `mc/<version>` (`mc/1.21.11`). Builds are for releases only, not snapshots.

## Publishing a build

Versions are `<mod>+<minecraft>`, for example `0.1.0+1.21.11`, and each build is the release of the tag `v<mod>-mc<minecraft>`. A release never changes a published jar; a fix is a new version.

SpawnLoft finds builds through a signed list, `harness-index.json` and `harness-index.json.sig`, uploaded to this repo's `index` release (created once, never moved, not marked latest) and committed on `main` as the record. SpawnLoft reads the list at most once a day, checks the Ed25519 signature against the two public keys it carries, refuses a list older than one it has seen, and downloads only jars from this repo's releases, pinned by the sha256 in the list. The private key lives only on the maintainer's signing machine (`%USERPROFILE%\.spawnloft-signing\harness-index-ed25519.pem`); nothing here or in CI ever sees it.

For Minecraft `X` and mod version `V`:

1. Port on `main` (or on `mc/X`), open a pull request, and wait for CI to build it.
2. Set `mod_version=V` and `minecraft_version=X` in `gradle.properties`, merge, and push the tag `vV-mcX` on the merge commit. The release workflow builds that commit and publishes the release with the jar, its sha256 and the commit.
3. Download the jar from the release and test it by hand (see above): `hello`, `status`, a `join`, a `/title` showing up in `messages`, `screenshot`, `quit`.
4. On the signing machine, in a current checkout of `main`, add the jar you just tested, so the list pins those exact bytes:
   ```
   node scripts/sign-index.mjs add --minecraft X --version V --tag vV-mcX --jar <the downloaded jar>
   node scripts/sign-index.mjs sign
   node scripts/sign-index.mjs verify
   ```
   `sign` picks a serial above the one committed, the one in the file and the one published, so a list is never signed twice under one serial. `verify` must print `verifies with the primary key` (or `spare`); anything else, stop.
5. `gh release upload index harness-index.json harness-index.json.sig --clobber`
6. Commit both files (`index: serial N, add V for X`) and push to `main`.

Within a day every SpawnLoft offers the harness for `X`, and `spawnloft doctor` shows the new serial.

Withdrawing a build: `node scripts/sign-index.mjs remove --minecraft X`, then steps 4 to 6 from `sign`. A version SpawnLoft carries built in (copied in at each stable SpawnLoft release) needs a SpawnLoft release as well.

`sign` uses `%USERPROFILE%\.spawnloft-signing\harness-index-ed25519.pem` unless `--key <pem>` names another, for example the spare: `node scripts/sign-index.mjs sign --key %USERPROFILE%\.spawnloft-signing\harness-index-ed25519-spare.pem`.

If a private key is lost or leaks, sign with the other one and revoke the bad one in the same list, so SpawnLoft stops trusting it:

1. `node scripts/sign-index.mjs revoke --spki <the bad key's public line>`
2. `node scripts/sign-index.mjs sign --key <the spare pem> --offline` (`--offline` because whatever is published may be the attacker's; the serial still goes above the committed one). If a list signed with the bad key was published with a serial higher than ours, add `--serial N` above it.
3. `node scripts/sign-index.mjs verify` must print `verifies with the spare key`.
4. Delete the bad assets from the `index` release, then step 5 above to upload, and step 6 to commit.
5. Ask for a SpawnLoft release with a new spare key.

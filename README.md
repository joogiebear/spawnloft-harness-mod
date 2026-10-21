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

Java 21 and network access to Mojang's and Fabric's maven servers.

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

## Releases

Each GitHub release carries one jar per Minecraft version it was built for, with its sha256 in the release notes. `versions.json` lists the versions. SpawnLoft pins the url and sha256 of each jar it downloads in `src/client-harness.mjs`, so a release never changes a published jar; a fix is a new version.

Versions are `<mod>+<minecraft>`, for example `0.1.0+1.21.11`.

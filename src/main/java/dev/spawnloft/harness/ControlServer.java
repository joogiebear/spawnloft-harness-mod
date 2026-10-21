package dev.spawnloft.harness;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.loader.api.FabricLoader;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;

/**
 * Loopback JSON-lines server. One connection at a time; the first line must
 * be {@code hello} with the right token or the connection is closed. Requests
 * other than {@code hello} are handed to {@link Ops}, which answers through a
 * {@link Reply} from whatever thread finishes the work.
 */
public final class ControlServer {
	public static final String FILE_NAME = "spawnloft-harness.json";
	private static final Gson GSON = new Gson();

	private final String token;
	private final String version;
	private final Path gameDir;
	private final Path file;
	private final Ops ops;
	private final ServerSocket socket;
	private final Thread thread;
	private volatile boolean closed = false;
	private volatile Connection current;

	public ControlServer(String token, String version, Path gameDir, Ops ops) throws IOException {
		this.token = token;
		this.version = version;
		this.gameDir = gameDir;
		this.file = gameDir.resolve(FILE_NAME);
		this.ops = ops;
		this.socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
		this.thread = new Thread(this::acceptLoop, "spawnloft-harness");
		this.thread.setDaemon(true);
	}

	public int port() {
		return socket.getLocalPort();
	}

	public void start() {
		writeFile();
		thread.start();
	}

	private void writeFile() {
		JsonObject o = new JsonObject();
		o.addProperty("port", port());
		o.addProperty("pid", ProcessHandle.current().pid());
		o.addProperty("startedAt", Instant.now().toString());
		o.addProperty("version", version);
		try {
			Path tmp = gameDir.resolve(FILE_NAME + ".tmp");
			Files.writeString(tmp, GSON.toJson(o) + "\n", StandardCharsets.UTF_8);
			Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			HarnessMod.LOGGER.error("harness: could not write {}", file, e);
		}
	}

	/** Idempotent: deletes the file, closes the socket and the live connection. */
	public void close() {
		if (closed) return;
		closed = true;
		try {
			Files.deleteIfExists(file);
		} catch (IOException ignored) {
		}
		Connection c = current;
		if (c != null) c.close();
		try {
			socket.close();
		} catch (IOException ignored) {
		}
	}

	private void acceptLoop() {
		while (!closed) {
			Socket s;
			try {
				s = socket.accept();
			} catch (IOException e) {
				if (!closed) HarnessMod.LOGGER.warn("harness: accept failed", e);
				return;
			}
			Connection c = new Connection(s);
			current = c;
			try {
				c.serve();
			} catch (IOException e) {
				if (!closed) HarnessMod.LOGGER.debug("harness: connection ended: {}", e.toString());
			} finally {
				c.close();
				if (current == c) current = null;
				ops.onConnectionClosed();
			}
		}
	}

	/** One accepted socket. {@link #send} may be called from any thread. */
	public final class Connection {
		private final Socket s;
		private final OutputStream out;
		private volatile boolean open = true;

		Connection(Socket s) {
			this.s = s;
			OutputStream o = null;
			try {
				s.setTcpNoDelay(true);
				o = s.getOutputStream();
			} catch (IOException e) {
				open = false;
			}
			this.out = o;
		}

		void serve() throws IOException {
			BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
			boolean greeted = false;
			String line;
			while (open && (line = in.readLine()) != null) {
				if (line.isBlank()) continue;
				JsonObject req;
				long id;
				String op;
				try {
					JsonElement parsed = JsonParser.parseString(line);
					req = parsed.getAsJsonObject();
					id = req.get("id").getAsLong();
					op = req.get("op").getAsString();
				} catch (RuntimeException e) {
					if (!greeted) return; // garbage before hello: drop the connection
					JsonObject err = new JsonObject();
					err.addProperty("id", -1);
					err.addProperty("ok", false);
					err.addProperty("error", "bad request: expected {\"id\": int, \"op\": string}");
					send(err);
					continue;
				}
				Reply reply = new Reply(id, this);
				if (!greeted) {
					if (!"hello".equals(op) || !constantTimeEquals(token, optString(req, "token"))) {
						return; // close without a word, as the plan says
					}
					greeted = true;
					reply.ok(helloResult());
					continue;
				}
				if ("hello".equals(op)) {
					reply.ok(helloResult());
					continue;
				}
				ops.dispatch(op, req, reply);
			}
		}

		private JsonObject helloResult() {
			JsonObject hello = new JsonObject();
			hello.addProperty("version", version);
			hello.addProperty("minecraft", modVersion("minecraft"));
			hello.addProperty("loader", modVersion("fabricloader"));
			return hello;
		}

		public void send(JsonObject o) {
			if (!open) return;
			byte[] bytes = (GSON.toJson(o) + "\n").getBytes(StandardCharsets.UTF_8);
			synchronized (this) {
				try {
					out.write(bytes);
					out.flush();
				} catch (IOException e) {
					open = false;
				}
			}
		}

		void close() {
			open = false;
			try {
				s.close();
			} catch (IOException ignored) {
			}
		}
	}

	private static String optString(JsonObject o, String key) {
		JsonElement e = o.get(key);
		return e == null || e.isJsonNull() ? null : e.getAsString();
	}

	private static boolean constantTimeEquals(String a, String b) {
		if (a == null || b == null) return false;
		byte[] x = a.getBytes(StandardCharsets.UTF_8);
		byte[] y = b.getBytes(StandardCharsets.UTF_8);
		return java.security.MessageDigest.isEqual(x, y);
	}

	private static String modVersion(String id) {
		return FabricLoader.getInstance().getModContainer(id)
				.map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("unknown");
	}
}

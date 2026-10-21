package dev.spawnloft.harness;

import com.google.gson.JsonObject;

import java.util.concurrent.atomic.AtomicBoolean;

/** One answer slot for one request. Thread-safe; answers only once. */
public final class Reply {
	private final long id;
	private final ControlServer.Connection connection;
	private final AtomicBoolean done = new AtomicBoolean(false);

	Reply(long id, ControlServer.Connection connection) {
		this.id = id;
		this.connection = connection;
	}

	public void ok(JsonObject result) {
		if (!done.compareAndSet(false, true)) return;
		JsonObject o = result == null ? new JsonObject() : result;
		o.addProperty("id", id);
		o.addProperty("ok", true);
		connection.send(o);
	}

	public void ok() {
		ok(new JsonObject());
	}

	public void error(String message) {
		if (!done.compareAndSet(false, true)) return;
		JsonObject o = new JsonObject();
		o.addProperty("id", id);
		o.addProperty("ok", false);
		o.addProperty("error", message);
		connection.send(o);
	}

	public boolean isDone() {
		return done.get();
	}
}

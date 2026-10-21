package dev.spawnloft.harness;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.time.Instant;
import java.util.ArrayDeque;

/** Ring buffer of the last N game messages, each with a growing sequence number. */
public final class Messages {
	public record Entry(long seq, Instant at, String kind, String text) {}

	private final int capacity;
	private final ArrayDeque<Entry> ring = new ArrayDeque<>();
	private long next = 1;

	public Messages(int capacity) {
		this.capacity = capacity;
	}

	public synchronized void add(String kind, String text) {
		ring.addLast(new Entry(next++, Instant.now(), kind, text));
		while (ring.size() > capacity) {
			ring.removeFirst();
		}
	}

	/** Everything with seq > since, plus the seq to pass next time. */
	public synchronized JsonObject since(long since) {
		JsonArray list = new JsonArray();
		for (Entry e : ring) {
			if (e.seq() <= since) continue;
			JsonObject o = new JsonObject();
			o.addProperty("seq", e.seq());
			o.addProperty("at", e.at().toString());
			o.addProperty("kind", e.kind());
			o.addProperty("text", e.text());
			list.add(o);
		}
		JsonObject out = new JsonObject();
		out.add("messages", list);
		out.addProperty("next", next - 1);
		return out;
	}
}

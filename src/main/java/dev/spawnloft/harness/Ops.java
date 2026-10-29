package dev.spawnloft.harness;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.spawnloft.harness.mixin.DisconnectedScreenAccessor;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.LevelLoadingScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.screens.multiplayer.JoinMultiplayerScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;

import java.io.File;
import java.time.format.DateTimeFormatter;
import java.time.LocalDateTime;

/**
 * One method per protocol op. {@link #dispatch} is called on the socket
 * reader thread and moves the work onto the render thread; replies go out
 * through {@link Reply} from whichever thread finishes.
 */
public final class Ops {
	private static final long JOIN_TIMEOUT_MS = 60_000;

	private final Messages messages;

	// Written and read on the render thread only.
	private Reply pendingJoin;
	private long pendingJoinDeadline;
	private boolean joinedFlag;

	public Ops(Messages messages) {
		this.messages = messages;
	}

	public void dispatch(String op, JsonObject req, Reply reply) {
		Minecraft client = Minecraft.getInstance();
		if (client == null) {
			reply.error("client not ready");
			return;
		}
		client.execute(() -> {
			try {
				switch (op) {
					case "status" -> reply.ok(status(client));
					case "join" -> join(client, req, reply);
					case "disconnect" -> disconnect(client, reply);
					case "chat" -> chat(client, req, reply);
					case "messages" -> reply.ok(messages.since(optLong(req, "since", 0)));
					case "player" -> player(client, reply);
					case "screen" -> reply.ok(screen(client));
					case "screenshot" -> screenshot(client, reply);
					case "quit" -> {
						reply.ok();
						client.stop();
					}
					default -> reply.error("unknown op: " + op);
				}
			} catch (RuntimeException e) {
				HarnessMod.LOGGER.warn("harness: op {} failed", op, e);
				reply.error(op + " failed: " + e);
			}
		});
	}

	/** Render thread, every tick: settle a pending join. */
	public void onEndTick(Minecraft client) {
		if (pendingJoin == null) return;
		if (joinedFlag && client.player != null && client.level != null) {
			JsonObject o = new JsonObject();
			o.addProperty("joined", true);
			Reply r = pendingJoin;
			pendingJoin = null;
			r.ok(o);
			return;
		}
		if (client.gui.screen() instanceof DisconnectedScreen d) {
			Reply r = pendingJoin;
			pendingJoin = null;
			r.error("disconnected: " + disconnectReason(d));
			return;
		}
		if (System.currentTimeMillis() > pendingJoinDeadline) {
			Reply r = pendingJoin;
			pendingJoin = null;
			r.error("join timed out after " + (JOIN_TIMEOUT_MS / 1000) + " s");
		}
	}

	/** Render thread, from ClientPlayConnectionEvents.JOIN. */
	public void onJoined() {
		joinedFlag = true;
	}

	/** Render thread, from the Gui mixin. */
	public void recordTitle(String text) {
		messages.add("title", text);
	}

	/** Socket reader thread: a dropped connection abandons its pending join. */
	public void onConnectionClosed() {
		Minecraft client = Minecraft.getInstance();
		if (client != null) client.execute(() -> pendingJoin = null);
	}

	// ---- ops ----

	private JsonObject status(Minecraft client) {
		JsonObject o = new JsonObject();
		Screen s = client.gui.screen();
		String kind;
		if (client.level == null) {
			if (s instanceof TitleScreen) kind = "title";
			else if (s instanceof JoinMultiplayerScreen) kind = "multiplayer";
			else if (s instanceof ConnectScreen) kind = "connecting";
			else if (s instanceof DisconnectedScreen) kind = "disconnected";
			else kind = "other";
		} else {
			if (s instanceof LevelLoadingScreen) kind = "connecting";
			else if (s instanceof DisconnectedScreen) kind = "disconnected";
			else kind = "ingame";
		}
		o.addProperty("screen", kind);
		o.addProperty("screenTitle", s == null ? "" : s.getTitle().getString());
		ServerData server = client.getCurrentServer();
		if (server != null && client.level != null) {
			JsonObject c = new JsonObject();
			ServerAddress addr = ServerAddress.parseString(server.ip);
			c.addProperty("host", addr.getHost());
			c.addProperty("port", addr.getPort());
			o.add("connected", c);
		} else {
			o.add("connected", null);
		}
		if (client.player != null) {
			JsonObject p = new JsonObject();
			p.addProperty("name", client.player.getName().getString());
			p.addProperty("uuid", client.player.getUUID().toString());
			o.add("player", p);
		} else {
			o.add("player", null);
		}
		o.addProperty("fps", client.getFps());
		return o;
	}

	private void join(Minecraft client, JsonObject req, Reply reply) {
		if (client.level != null || client.getConnection() != null) {
			reply.error("already connected; call disconnect first");
			return;
		}
		if (pendingJoin != null) {
			reply.error("a join is already in progress");
			return;
		}
		String host = optString(req, "host");
		int port = (int) optLong(req, "port", 25565);
		if (host == null || host.isBlank()) {
			reply.error("join needs host");
			return;
		}
		ServerAddress address = new ServerAddress(host, port);
		ServerData data = new ServerData("SpawnLoft", host + ":" + port, ServerData.Type.OTHER);
		joinedFlag = false;
		pendingJoin = reply;
		pendingJoinDeadline = System.currentTimeMillis() + JOIN_TIMEOUT_MS;
		Screen parent = client.gui.screen() == null ? new TitleScreen() : client.gui.screen();
		ConnectScreen.startConnecting(parent, client, address, data, false, null);
	}

	private void disconnect(Minecraft client, Reply reply) {
		if (client.level != null) {
			client.level.disconnect(Component.literal("Disconnected by SpawnLoft"));
		}
		client.disconnectWithProgressScreen();
		client.gui.setScreen(new JoinMultiplayerScreen(new TitleScreen()));
		reply.ok();
	}

	private void chat(Minecraft client, JsonObject req, Reply reply) {
		String text = optString(req, "text");
		if (text == null || text.isBlank()) {
			reply.error("chat needs text");
			return;
		}
		if (client.player == null || client.player.connection == null) {
			reply.error("not in a world");
			return;
		}
		if (text.startsWith("/")) {
			client.player.connection.sendCommand(text.substring(1));
		} else {
			client.player.connection.sendChat(text);
		}
		JsonObject o = new JsonObject();
		o.addProperty("sent", text);
		reply.ok(o);
	}

	private void player(Minecraft client, Reply reply) {
		var p = client.player;
		if (p == null || client.level == null) {
			reply.error("not in a world");
			return;
		}
		JsonObject o = new JsonObject();
		o.addProperty("name", p.getName().getString());
		o.addProperty("gameMode", client.gameMode == null ? "unknown" : client.gameMode.getPlayerMode().getName());
		o.addProperty("health", p.getHealth());
		o.addProperty("food", p.getFoodData().getFoodLevel());
		o.addProperty("dimension", client.level.dimension().identifier().toString());
		JsonObject pos = new JsonObject();
		pos.addProperty("x", p.getX());
		pos.addProperty("y", p.getY());
		pos.addProperty("z", p.getZ());
		o.add("position", pos);
		o.addProperty("yaw", p.getYRot());
		o.addProperty("pitch", p.getXRot());
		var held = p.getMainHandItem();
		if (held == null || held.isEmpty()) {
			o.add("heldItem", null);
		} else {
			JsonObject h = new JsonObject();
			h.addProperty("name", BuiltInRegistries.ITEM.getKey(held.getItem()).toString());
			h.addProperty("count", held.getCount());
			o.add("heldItem", h);
		}
		reply.ok(o);
	}

	private JsonObject screen(Minecraft client) {
		JsonObject o = new JsonObject();
		Screen s = client.gui.screen();
		if (s == null) {
			o.addProperty("kind", "none");
			o.addProperty("title", "");
			o.add("slots", null);
			return o;
		}
		o.addProperty("title", s.getTitle().getString());
		if (s instanceof AbstractContainerScreen<?> container) {
			o.addProperty("kind", "container");
			JsonArray slots = new JsonArray();
			for (var slot : container.getMenu().slots) {
				var stack = slot.getItem();
				if (stack == null || stack.isEmpty()) continue;
				JsonObject e = new JsonObject();
				e.addProperty("slot", slot.index);
				e.addProperty("name", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
				e.addProperty("count", stack.getCount());
				e.addProperty("displayName", stack.getHoverName().getString());
				slots.add(e);
			}
			o.add("slots", slots);
		} else {
			o.addProperty("kind", "other");
			o.add("slots", null);
		}
		return o;
	}

	private void screenshot(Minecraft client, Reply reply) {
		String name = "spawnloft-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd_HH.mm.ss.SSS")) + ".png";
		File dir = client.gameDirectory;
		File target = new File(new File(dir, "screenshots"), name);
		Screenshot.grab(dir, name, client.gameRenderer.mainRenderTarget(), 1, message -> {
			if (target.isFile()) {
				JsonObject o = new JsonObject();
				o.addProperty("file", target.getAbsolutePath());
				reply.ok(o);
			} else {
				reply.error("screenshot failed: " + message.getString());
			}
		});
	}

	// ---- helpers ----

	private static String disconnectReason(DisconnectedScreen d) {
		try {
			var details = ((DisconnectedScreenAccessor) d).spawnloft$details();
			if (details != null && details.reason() != null) return details.reason().getString();
		} catch (RuntimeException ignored) {
		}
		return d.getTitle().getString();
	}

	private static String optString(JsonObject o, String key) {
		JsonElement e = o.get(key);
		return e == null || e.isJsonNull() ? null : e.getAsString();
	}

	private static long optLong(JsonObject o, String key, long fallback) {
		JsonElement e = o.get(key);
		return e == null || e.isJsonNull() ? fallback : e.getAsLong();
	}
}

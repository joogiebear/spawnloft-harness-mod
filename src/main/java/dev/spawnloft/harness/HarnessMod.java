package dev.spawnloft.harness;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Entry point. With no {@code -Dspawnloft.harness.token=...} on the JVM this
 * class returns at once: no socket, no file, no event handlers. With it, the
 * control server starts on a daemon thread and the game events feed the
 * message ring and the pending join.
 */
public final class HarnessMod implements ClientModInitializer {
	public static final String MOD_ID = "spawnloft-harness";
	public static final String TOKEN_PROPERTY = "spawnloft.harness.token";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	/** Null when the mod is idle. Read by the mixins. */
	public static volatile Ops OPS;

	@Override
	public void onInitializeClient() {
		String token = System.getProperty(TOKEN_PROPERTY);
		if (token == null || token.isBlank()) {
			return;
		}
		String version = FabricLoader.getInstance().getModContainer(MOD_ID)
				.map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("unknown");
		Messages messages = new Messages(1000);
		Ops ops = new Ops(messages);
		ControlServer server;
		try {
			server = new ControlServer(token, version, FabricLoader.getInstance().getGameDir(), ops);
		} catch (Exception e) {
			LOGGER.error("harness: could not open the control channel", e);
			return;
		}
		OPS = ops;
		server.start();

		ClientTickEvents.END_CLIENT_TICK.register(ops::onEndTick);
		ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> ops.onJoined());
		ClientReceiveMessageEvents.GAME.register((message, overlay) ->
				messages.add(overlay ? "actionbar" : "system", message.getString()));
		ClientReceiveMessageEvents.CHAT.register((message, signed, sender, params, at) ->
				messages.add("chat", message.getString()));
		ClientLifecycleEvents.CLIENT_STOPPING.register(client -> server.close());
		Runtime.getRuntime().addShutdownHook(new Thread(server::close, "spawnloft-harness-shutdown"));
		LOGGER.info("harness: control channel on 127.0.0.1:{}", server.port());
	}
}

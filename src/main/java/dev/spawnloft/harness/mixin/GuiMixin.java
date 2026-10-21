package dev.spawnloft.harness.mixin;

import dev.spawnloft.harness.HarnessMod;
import net.minecraft.client.gui.Gui;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Records title text shown with /title into the message ring. */
@Mixin(Gui.class)
public abstract class GuiMixin {
	@Inject(method = "setTitle", at = @At("HEAD"))
	private void spawnloft$onSetTitle(Component title, CallbackInfo ci) {
		var ops = HarnessMod.OPS;
		if (ops != null && title != null) {
			ops.recordTitle(title.getString());
		}
	}
}

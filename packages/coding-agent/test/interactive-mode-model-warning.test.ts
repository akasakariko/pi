import { stripVTControlCharacters } from "node:util";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { InteractiveMode, type InteractiveModeOptions } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

vi.mock("../src/utils/version-check.ts", () => ({ checkForNewPiVersion: async () => undefined }));
vi.mock("../src/core/crash-log.ts", () => ({ takeUnnotifiedCrash: () => undefined }));

initTheme("dark");

// #10812: the existing startup warning path must render the fallback once, before accepting input.
describe("interactive default model warning", () => {
	test("renders the configured and replacement models once in the transcript", async () => {
		const warning =
			"Could not use default model deepseek/deepseek-v4-flash (not found). Using deepseek/deepseek-v4-pro";
		const stop = new Error("stop at interactive input");
		const chatContainer = new Container();
		const context = {
			options: { modelFallbackMessage: warning } satisfies InteractiveModeOptions,
			version: "test",
			chatContainer,
			ui: { requestRender: vi.fn() },
			session: { modelRuntime: { getError: () => undefined }, prompt: vi.fn() },
			init: vi.fn(async () => {}),
			checkForPackageUpdates: async () => [],
			checkTmuxKeyboardSetup: async () => undefined,
			updateTerminalTitle: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
			showWarning: InteractiveMode.prototype.showWarning,
			getUserInput: vi.fn(async () => {
				throw stop;
			}),
		};

		await expect(InteractiveMode.prototype.run.call(context as unknown as InteractiveMode)).rejects.toBe(stop);

		const transcript = chatContainer.render(160).map(stripVTControlCharacters).join("\n");
		expect(transcript.split("Warning:")).toHaveLength(2);
		expect(transcript).toContain(warning);
		expect(context.getUserInput).toHaveBeenCalledOnce();
		expect(context.session.prompt).not.toHaveBeenCalled();
	});
});

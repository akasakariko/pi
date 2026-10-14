import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { findInitialModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSessionOptions } from "../src/main.ts";
import { createTestResourceLoader } from "./utilities.ts";

const flash: Model<"openai-completions"> = {
	id: "deepseek-flash",
	name: "Flash",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};
const pro = { ...flash, id: "deepseek-v4-pro", name: "Pro" };
const defaultSettings = { defaultProvider: "deepseek", defaultModel: "deepseek-v4-flash" };
const missingWarning =
	"Could not use default model deepseek/deepseek-v4-flash (not found). Using deepseek/deepseek-v4-pro";

// Regression coverage for #10812: an unusable saved default must not silently select another model.
describe("saved default model fallback", () => {
	let cwd: string;
	let modelRuntime: ModelRuntime;

	beforeEach(async () => {
		cwd = mkdtempSync(join(tmpdir(), "pi-default-model-"));
		modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		vi.spyOn(modelRuntime, "getModels").mockReturnValue([flash, pro]);
		vi.spyOn(modelRuntime, "getModel").mockImplementation((provider, id) =>
			[flash, pro].find((model) => model.provider === provider && model.id === id),
		);
		vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue([flash, pro]);
		vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(cwd, { recursive: true, force: true });
	});

	function resolve(overrides: Partial<Parameters<typeof findInitialModel>[0]> = {}) {
		return findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: defaultSettings.defaultProvider,
			defaultModelId: defaultSettings.defaultModel,
			modelRuntime,
			...overrides,
		});
	}

	async function openSession(overrides: Partial<CreateAgentSessionOptions> = {}) {
		return createAgentSession({
			cwd,
			agentDir: cwd,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(defaultSettings),
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader: createTestResourceLoader(),
			noTools: "all",
			...overrides,
		});
	}

	// #10812: enabledModels selects a model before the SDK default resolver runs.
	describe("CLI scoped startup", () => {
		test("returns one warning without adding it to print, JSON or RPC diagnostics", async () => {
			const settingsManager = SettingsManager.inMemory({
				...defaultSettings,
				enabledModels: ["deepseek/deepseek-v4-pro:high"],
			});
			const result = buildSessionOptions(
				parseArgs([]),
				[{ model: pro, thinkingLevel: "high" }],
				false,
				modelRuntime,
				settingsManager,
			);
			expect(result.options.model).toBe(pro);
			expect(result.options.thinkingLevel).toBe("high");
			expect(result.modelFallbackMessage).toBe(missingWarning);
			expect(result.diagnostics).toEqual([]);
			const { session, modelFallbackMessage } = await openSession(result.options);
			try {
				expect(session.model).toBe(pro);
				expect(modelFallbackMessage).toBeUndefined();
			} finally {
				session.dispose();
			}
		});

		test("warns when the default provider has no authentication", () => {
			vi.mocked(modelRuntime.hasConfiguredAuth).mockReturnValue(false);
			const replacement = { ...pro, provider: "other" };
			const result = buildSessionOptions(
				parseArgs([]),
				[{ model: replacement }],
				false,
				modelRuntime,
				SettingsManager.inMemory({ ...defaultSettings, defaultModel: flash.id }),
			);
			expect(result.options.model).toBe(replacement);
			expect(result.modelFallbackMessage).toBe(
				"Could not use default model deepseek/deepseek-flash (no authentication configured). Using other/deepseek-v4-pro",
			);
		});

		test.each([
			["--model", "deepseek/deepseek-flash"],
			["--provider", "deepseek", "--model", "deepseek-flash"],
			["--models", "deepseek/deepseek-v4-pro"],
		])("does not warn for explicit model selection: %j", (...args) => {
			const result = buildSessionOptions(
				parseArgs(args),
				[{ model: pro }],
				false,
				modelRuntime,
				SettingsManager.inMemory(defaultSettings),
			);
			expect(result.modelFallbackMessage).toBeUndefined();
			expect(result.options.model).toBe(args[0] === "--models" ? pro : flash);
		});

		test.each([true, false])("does not warn for a valid default, in scope: %s", (inScope) => {
			const result = buildSessionOptions(
				parseArgs([]),
				inScope ? [{ model: pro }, { model: flash }] : [{ model: pro }],
				false,
				modelRuntime,
				SettingsManager.inMemory({ ...defaultSettings, defaultModel: flash.id }),
			);
			expect(result.modelFallbackMessage).toBeUndefined();
			expect(result.options.model).toBe(inScope ? flash : pro);
		});

		test("leaves restored sessions to the SDK", () => {
			const result = buildSessionOptions(
				parseArgs([]),
				[{ model: pro }],
				true,
				modelRuntime,
				SettingsManager.inMemory(defaultSettings),
			);
			expect(result.options.model).toBeUndefined();
			expect(result.modelFallbackMessage).toBeUndefined();
		});

		test("does not warn when there is no saved default", () => {
			const result = buildSessionOptions(
				parseArgs([]),
				[{ model: pro }],
				false,
				modelRuntime,
				SettingsManager.inMemory(),
			);
			expect(result.options.model).toBe(pro);
			expect(result.modelFallbackMessage).toBeUndefined();
		});
	});

	test("names the missing default and the provider-default replacement", async () => {
		const result = await resolve();
		expect(result.model).toBe(pro);
		expect(result.fallbackMessage).toBe(missingWarning);
	});

	test("warns when falling back to the first available model", async () => {
		vi.mocked(modelRuntime.getAvailableSnapshot).mockReturnValue([flash]);
		const result = await resolve();
		expect(result.model).toBe(flash);
		expect(result.fallbackMessage).toBe(
			"Could not use default model deepseek/deepseek-v4-flash (not found). Using deepseek/deepseek-flash",
		);
	});

	test("warns about a removed provider", async () => {
		const result = await resolve({ defaultProvider: "removed", defaultModelId: "old" });
		expect(result.fallbackMessage).toBe(
			"Could not use default model removed/old (not found). Using deepseek/deepseek-v4-pro",
		);
	});

	test("distinguishes missing authentication from a missing model", async () => {
		vi.mocked(modelRuntime.hasConfiguredAuth).mockReturnValue(false);
		const replacement = { ...pro, provider: "other" };
		vi.mocked(modelRuntime.getAvailableSnapshot).mockReturnValue([replacement]);
		const result = await resolve({ defaultModelId: flash.id });
		expect(result.model).toBe(replacement);
		expect(result.fallbackMessage).toBe(
			"Could not use default model deepseek/deepseek-flash (no authentication configured). Using other/deepseek-v4-pro",
		);
	});

	test("warns for scoped fallback without changing its thinking level", async () => {
		const result = await resolve({ scopedModels: [{ model: pro, thinkingLevel: "high" }] });
		expect(result.model).toBe(pro);
		expect(result.thinkingLevel).toBe("high");
		expect(result.fallbackMessage).toBe(missingWarning);
	});

	test("does not warn about a valid default outside the selected scope", async () => {
		const result = await resolve({ defaultModelId: flash.id, scopedModels: [{ model: pro }] });
		expect(result.model).toBe(pro);
		expect(result.fallbackMessage).toBeUndefined();
	});

	test("does not warn for an explicit CLI model", async () => {
		const result = await resolve({ cliProvider: flash.provider, cliModel: flash.id });
		expect(result.model).toBe(flash);
		expect(result.fallbackMessage).toBeUndefined();
	});

	test("keeps a valid saved default and its thinking level", async () => {
		const result = await resolve({ defaultModelId: flash.id, defaultThinkingLevel: "high" });
		expect(result.model).toBe(flash);
		expect(result.thinkingLevel).toBe("high");
		expect(result.fallbackMessage).toBeUndefined();
	});

	test.each([
		{ defaultProvider: undefined },
		{ defaultModelId: undefined },
		{ defaultProvider: undefined, defaultModelId: undefined },
	])("does not warn for incomplete or absent defaults: %j", async (overrides) => {
		expect((await resolve(overrides)).fallbackMessage).toBeUndefined();
	});

	test("reports the invalid default even without an available replacement", async () => {
		vi.mocked(modelRuntime.getAvailableSnapshot).mockReturnValue([]);
		const result = await resolve();
		expect(result.model).toBeUndefined();
		expect(result.fallbackMessage).toBe("Could not use default model deepseek/deepseek-v4-flash (not found)");
	});

	test("propagates the warning through the SDK without changing the saved default", async () => {
		const settingsManager = SettingsManager.inMemory(defaultSettings);
		const { session, modelFallbackMessage } = await openSession({ settingsManager });
		try {
			expect(session.model).toBe(pro);
			expect(modelFallbackMessage).toBe(missingWarning);
			expect(settingsManager.getDefaultModel()).toBe(defaultSettings.defaultModel);
			expect(session.sessionManager.getBranch()).toContainEqual(
				expect.objectContaining({ type: "model_change", provider: pro.provider, modelId: pro.id }),
			);
		} finally {
			session.dispose();
		}
	});

	test("combines an invalid default with the no-models guidance", async () => {
		vi.mocked(modelRuntime.getAvailableSnapshot).mockReturnValue([]);
		const { session, modelFallbackMessage } = await openSession();
		try {
			expect(modelFallbackMessage).toContain("Could not use default model deepseek/deepseek-v4-flash (not found)");
			expect(modelFallbackMessage).toContain("No models available");
			expect(modelFallbackMessage).not.toContain("Using");
		} finally {
			session.dispose();
		}
	});

	test("does not warn when the SDK caller explicitly selects a model", async () => {
		const { session, modelFallbackMessage } = await openSession({ model: flash });
		try {
			expect(session.model).toBe(flash);
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	test.each([flash.id, "removed-session-model"])("preserves session restoration behavior for %s", async (id) => {
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendModelChange(flash.provider, id);
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const { session, modelFallbackMessage } = await openSession({ sessionManager });
		try {
			if (id === flash.id) {
				expect(session.model).toBe(flash);
				expect(modelFallbackMessage).toBeUndefined();
			} else {
				expect(session.model).toBe(pro);
				expect(modelFallbackMessage).toBe(
					"Could not restore model deepseek/removed-session-model. Using deepseek/deepseek-v4-pro",
				);
			}
		} finally {
			session.dispose();
		}
	});
});

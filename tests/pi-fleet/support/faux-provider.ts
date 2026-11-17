// Test-only pi extension: a faux model provider ("faux/faux-1") whose every reply waits until
// the file named by $PI_FLEET_TEST_GATE exists, so a test can observe the `running` state.
//
// Session-title requests (fleet/title.ts, recognised by TITLE_MARKER in the request) skip the
// gate and are answered from $PI_FLEET_TEST_TITLE: a title text (default "Faux session title"),
// `fail` (an error reply) or `hang` (never answers until aborted). Each one is logged as a JSON
// line {model, context} to $PI_FLEET_TEST_TITLE_LOG when set. $PI_FLEET_TEST_CHEAP=1 adds a
// cheaper "faux/faux-mini" model, which the title picker should prefer.
import { appendFileSync, existsSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TITLE_MARKER = "pi-fleet session title";

export default function (pi: ExtensionAPI) {
	const models: { id: string; cost?: any }[] = [{ id: "faux-1" }];
	if (process.env.PI_FLEET_TEST_CHEAP === "1") models.push({ id: "faux-mini", cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 } });
	const faux = fauxProvider({ provider: "faux", models });
	const reply = async (context: unknown, options: any, _state: unknown, model: any) => {
		faux.appendResponses([reply as any]);
		const text = JSON.stringify(context);
		if (text.includes(TITLE_MARKER)) {
			const log = process.env.PI_FLEET_TEST_TITLE_LOG;
			if (log) appendFileSync(log, JSON.stringify({ model: `${model?.provider}/${model?.id}`, context }) + "\n");
			const answer = process.env.PI_FLEET_TEST_TITLE ?? "Faux session title";
			if (answer === "fail") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "faux title failure" });
			if (answer === "hang") {
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) return resolve();
					options?.signal?.addEventListener("abort", () => resolve());
				});
				return fauxAssistantMessage("", { stopReason: "aborted" });
			}
			return fauxAssistantMessage(answer);
		}
		const gate = process.env.PI_FLEET_TEST_GATE;
		while (gate && !existsSync(gate)) await new Promise((r) => setTimeout(r, 50));
		return fauxAssistantMessage("done: the faux model answered");
	};
	faux.setResponses([reply as any]);
	pi.registerProvider(faux.provider as any);
}

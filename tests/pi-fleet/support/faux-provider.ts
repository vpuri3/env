// Test-only pi extension: a faux model provider ("faux/faux-1") whose every reply waits until
// the file named by $PI_FLEET_TEST_GATE exists, so a test can observe the `running` state.
import { existsSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const reply = async () => {
		const gate = process.env.PI_FLEET_TEST_GATE;
		while (gate && !existsSync(gate)) await new Promise((r) => setTimeout(r, 50));
		faux.appendResponses([reply]);
		return fauxAssistantMessage("done: the faux model answered");
	};
	faux.setResponses([reply]);
	pi.registerProvider(faux.provider as any);
}

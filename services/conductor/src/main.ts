// conductor: Atelier's agent orchestrator (blueprint doc 07), v0 — runs one
// scribe task against a room and exits.
//
//   pnpm --filter @atelier/conductor exec tsx src/main.ts \
//     --room graphdemo --goal "document greet"
//
// Zero tokens: the scripted provider is the only one wired. The real
// Anthropic provider drops in behind the same ModelProvider interface.
import { parseArgs } from "node:util";
import { ScriptedProvider } from "./gateway.js";
import { HttpIntel } from "./intel.js";
import { runScribe } from "./run.js";

const { values } = parseArgs({
  allowPositionals: true, // tolerate the `--` separator pnpm forwards
  options: {
    room: { type: "string" },
    goal: { type: "string" },
    relay: { type: "string", default: "ws://localhost:8787" },
    intel: { type: "string", default: "http://localhost:8789" },
    "log-dir": { type: "string", default: "./data/agent-runs" },
    "type-delay": { type: "string", default: "120" },
    // Human-in-the-loop gate is ON by default; --no-approval opts out.
    "no-approval": { type: "boolean", default: false },
    "approval-timeout": { type: "string", default: "120000" },
  },
});

if (!values.room || !values.goal) {
  console.error('usage: conductor --room <room> --goal "document <symbol>" [--relay ws://…] [--intel http://…]');
  process.exit(2);
}

const serviceToken = process.env.RELAY_SERVICE_SECRET;

if (!values["no-approval"]) {
  console.log("[conductor] approval gate ON — waiting for a human to approve in the IDE");
}

const state = await runScribe({
  relayUrl: values.relay!,
  room: values.room,
  goal: values.goal,
  provider: new ScriptedProvider(),
  intel: new HttpIntel(values.intel!),
  ...(serviceToken ? { serviceToken } : {}),
  logDir: values["log-dir"]!,
  typeDelayMs: Number(values["type-delay"]),
  requireApproval: !values["no-approval"],
  approvalTimeoutMs: Number(values["approval-timeout"]),
});

console.log(
  `[conductor] run ${state.runId}: ${state.status}` +
    (state.decidedBy ? ` (decided by ${state.decidedBy})` : "") +
    (state.error ? ` — ${state.error}` : "") +
    ` (goal: ${state.goal}; steps: ${state.steps.join("→")}; events: ${state.events})`,
);
if (state.patchedFiles.length > 0) {
  console.log(`[conductor] patched: ${state.patchedFiles.join(", ")}`);
}
// Exit codes: 0 applied, 2 rejected by a human (a valid outcome), 1 failed.
process.exit(state.status === "applied" ? 0 : state.status === "rejected" ? 2 : 1);

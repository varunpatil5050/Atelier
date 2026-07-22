// conductor: Atelier's agent orchestrator (blueprint doc 07), v0.
//
//   # scribe — a one-shot task that proposes a doc comment:
//   pnpm --filter @atelier/conductor exec tsx src/main.ts \
//     --room graphdemo --goal "document greet"
//
//   # reviewer — a long-running agent that scores proposals as they appear:
//   pnpm --filter @atelier/conductor exec tsx src/main.ts \
//     --room graphdemo --role reviewer
//
// Zero tokens: the scripted provider is the only one wired. The real
// Anthropic provider drops in behind the same ModelProvider interface.
import { parseArgs } from "node:util";
import { ScriptedProvider } from "./gateway.js";
import { HttpIntel } from "./intel.js";
import { runScribe } from "./run.js";
import { runPlan } from "./plan.js";
import { startReviewer } from "./review.js";
import { runTester } from "./tester.js";
import { runDebugger } from "./debug.js";

const { values } = parseArgs({
  allowPositionals: true, // tolerate the `--` separator pnpm forwards
  options: {
    room: { type: "string" },
    role: { type: "string", default: "scribe" }, // scribe | reviewer | planner | tester | debugger
    goal: { type: "string" },
    cmd: { type: "string" }, // tester: the command to run
    cwd: { type: "string", default: "." }, // tester: working directory
    "test-timeout": { type: "string", default: "60000" },
    relay: { type: "string", default: "ws://localhost:8787" },
    intel: { type: "string", default: "http://localhost:8789" },
    "log-dir": { type: "string", default: "./data/agent-runs" },
    "type-delay": { type: "string", default: "120" },
    // Human-in-the-loop gate is ON by default; --no-approval opts out.
    "no-approval": { type: "boolean", default: false },
    "approval-timeout": { type: "string", default: "120000" },
  },
});

const serviceToken = process.env.RELAY_SERVICE_SECRET;

if (!values.room) {
  console.error('usage: conductor --room <room> [--role scribe|reviewer|planner|tester] [--goal "…"] [--cmd "…"]');
  process.exit(2);
}

if (values.role === "debugger") {
  if (!values["no-approval"]) {
    console.log("[conductor] approval gate ON — approve the fix in the IDE");
  }
  const state = await runDebugger({
    relayUrl: values.relay!,
    room: values.room,
    provider: new ScriptedProvider(),
    intel: new HttpIntel(values.intel!),
    ...(serviceToken ? { serviceToken } : {}),
    requireApproval: !values["no-approval"],
    approvalTimeoutMs: Number(values["approval-timeout"]),
    logger: (m) => console.log(m),
  });
  console.log(
    `[conductor] debug ${state.runId}: ${state.status}` +
      (state.fn ? ` (${state.fn})` : "") +
      (state.error ? ` — ${state.error}` : ""),
  );
  process.exit(state.status === "applied" || state.status === "proposed" ? 0 : 1);
}

if (values.role === "tester") {
  if (!values.cmd) {
    console.error('usage: conductor --room <room> --role tester --cmd "npm test" [--cwd <dir>]');
    process.exit(2);
  }
  const state = await runTester({
    relayUrl: values.relay!,
    room: values.room,
    cmd: values.cmd,
    cwd: values.cwd!,
    ...(serviceToken ? { serviceToken } : {}),
    timeoutMs: Number(values["test-timeout"]),
    logger: (m) => console.log(m),
  });
  console.log(`[conductor] test ${state.runId}: ${state.status} (exit ${state.exitCode})`);
  process.exit(state.status === "pass" ? 0 : 1);
}

if (values.role === "planner") {
  if (!values.goal) {
    console.error('usage: conductor --room <room> --role planner --goal "document all" | "document <file>" | "document <symbol>"');
    process.exit(2);
  }
  if (!values["no-approval"]) {
    console.log("[conductor] approval gate ON — approve each task in the IDE");
  }
  const result = await runPlan({
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
    logger: (m) => console.log(m),
  });
  console.log(
    `[conductor] plan ${result.runId}: ${result.status} ` +
      `(goal: ${result.goal}; scope: ${result.directive.scope}; tasks: ${result.tasks.length}; ` +
      `applied ${result.applied}, rejected ${result.rejected}, failed ${result.failed})`,
  );
  process.exit(result.status === "completed" && result.failed === 0 ? 0 : 1);
} else if (values.role === "reviewer") {
  // Long-running: watch the room's proposals and score them until interrupted.
  const handle = await startReviewer({
    relayUrl: values.relay!,
    room: values.room,
    provider: new ScriptedProvider(),
    intel: new HttpIntel(values.intel!),
    ...(serviceToken ? { serviceToken } : {}),
    logger: (m) => console.log(m),
  });
  console.log(`[conductor] reviewer watching room "${values.room}" — Ctrl-C to stop`);
  const shutdown = () => {
    console.log(`[conductor] reviewer stopping (${handle.reviewedCount()} reviewed)`);
    handle.stop();
    setTimeout(() => process.exit(0), 400);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
  if (!values.goal) {
    console.error('usage: conductor --room <room> --goal "document <symbol>"');
    process.exit(2);
  }
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
}

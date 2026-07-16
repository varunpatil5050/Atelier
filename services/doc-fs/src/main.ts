// doc-fs: bridges a room's CRDT file map to a workspace directory.
//
//   pnpm --filter @atelier/doc-fs dev -- --room demo --dir ./my-workspace
//   pnpm --filter @atelier/doc-fs dev -- --room demo --dir ./ws --clone https://github.com/user/repo
import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { AtelierProvider, WsConnection } from "@atelier/client";
import { DocFsSync } from "./DocFsSync.js";

const { values } = parseArgs({
  allowPositionals: true, // tolerate the `--` separator pnpm forwards
  options: {
    room: { type: "string" },
    relay: { type: "string", default: "ws://localhost:8787" },
    dir: { type: "string", default: "." },
    clone: { type: "string" },
  },
});

// Service secret authenticates to an auth-enforced relay (doc-fs connects as a
// regular participant via the service secret). Empty in tokenless dev mode.
const serviceToken = process.env.RELAY_SERVICE_SECRET;

if (!values.room) {
  console.error("usage: doc-fs --room <room> [--dir <path>] [--relay <ws url>] [--clone <git url>]");
  process.exit(2);
}
const room = values.room;
const dir = path.resolve(values.dir!);

function log(msg: string, extra?: Record<string, unknown>): void {
  console.log(`[doc-fs] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
}

async function main(): Promise<void> {
  await fs.mkdir(dir, { recursive: true });

  if (values.clone) {
    const entries = await fs.readdir(dir);
    if (entries.length === 0) {
      log("cloning", { url: values.clone, dir });
      const res = spawnSync("git", ["clone", values.clone, "."], { cwd: dir, stdio: "inherit" });
      if (res.status !== 0) {
        console.error("[doc-fs] git clone failed");
        process.exit(1);
      }
    } else {
      log("directory not empty; skipping clone", { dir });
    }
  }

  const conn = new WsConnection(`${values.relay!.replace(/\/$/, "")}/ws`);
  const provider = new AtelierProvider(
    conn,
    room,
    { id: `doc-fs-${randomUUID().slice(0, 8)}`, name: "doc-fs", color: "#8b93a1" },
    serviceToken ? { getToken: () => serviceToken } : {},
  );
  provider.awareness.setLocalStateField("user", {
    id: "doc-fs",
    name: "doc-fs",
    color: "#8b93a1",
  });

  const sync = new DocFsSync({ provider, dir, log });
  conn.connect();
  await sync.start();
  log("ready", { room, relay: values.relay });

  const shutdown = async (): Promise<void> => {
    log("shutting down");
    await sync.stop();
    provider.destroy();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[doc-fs] fatal:", err);
  process.exit(1);
});

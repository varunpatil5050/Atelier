import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { AtelierProvider, WsConnection } from "@atelier/client";
import { DocFsSync } from "./DocFsSync.js";

/**
 * Full-stack integration: real Go relay + DocFsSync on a real directory +
 * a plain protocol client, exercising both sync directions.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let relayProc: ChildProcess;
let relayPort: number;
let workDir: string;
const cleanups: Array<() => Promise<void> | void> = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("no port"));
      }
    });
  });
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function makeClient(room: string, name: string): Promise<AtelierProvider> {
  const conn = new WsConnection(`ws://127.0.0.1:${relayPort}/ws`);
  const provider = new AtelierProvider(conn, room, { id: name, name, color: "#00ff00" });
  conn.connect();
  cleanups.push(() => provider.destroy());
  await waitFor(() => provider.synced, 10_000, `${name} synced`);
  return provider;
}

beforeAll(async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-relay-"));
  const bin = path.join(binDir, "relay");
  execSync(`go build -o ${JSON.stringify(bin)} atelier.dev/services/collab-relay/cmd/collab-relay`, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  relayPort = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-data-"));
  relayProc = spawn(bin, [], {
    env: { ...process.env, RELAY_ADDR: `:${relayPort}`, RELAY_DATA_DIR: dataDir },
    stdio: "ignore",
  });
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${relayPort}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }, 30_000, "relay healthz");

  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-ws-"));
});

afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
  relayProc?.kill("SIGTERM");
});

describe("DocFsSync against a real relay", () => {
  const room = `docfs-${Date.now().toString(36)}`;
  let syncProvider: AtelierProvider;
  let sync: DocFsSync;
  let peer: AtelierProvider;

  it("starts and imports pre-existing disk files into the room", async () => {
    await fs.writeFile(path.join(workDir, "preexisting.ts"), "export const pre = 1;\n");

    syncProvider = await makeClient(room, "doc-fs");
    sync = new DocFsSync({ provider: syncProvider, dir: workDir, debounceMs: 100 });
    await sync.start();
    cleanups.push(() => sync.stop());

    peer = await makeClient(room, "peer");
    const files = peer.doc.getMap<Y.Text>("files");
    await waitFor(() => files.has("preexisting.ts"), 5_000, "import of preexisting.ts");
    expect(files.get("preexisting.ts")!.toString()).toBe("export const pre = 1;\n");
  });

  it("doc → disk: a collaborator's new nested file lands on disk", async () => {
    const files = peer.doc.getMap<Y.Text>("files");
    peer.doc.transact(() => {
      files.set("src/hello.ts", new Y.Text('export const hello = "world";\n'));
    });

    const abs = path.join(workDir, "src", "hello.ts");
    await waitFor(
      async () => {
        try {
          return (await fs.readFile(abs, "utf8")) === 'export const hello = "world";\n';
        } catch {
          return false;
        }
      },
      5_000,
      "src/hello.ts on disk",
    );
  });

  it("doc → disk: collaborator edits update the file", async () => {
    const files = peer.doc.getMap<Y.Text>("files");
    const ytext = files.get("src/hello.ts")!;
    peer.doc.transact(() => ytext.insert(0, "// edited by peer\n"));

    const abs = path.join(workDir, "src", "hello.ts");
    await waitFor(
      async () => (await fs.readFile(abs, "utf8")).startsWith("// edited by peer\n"),
      5_000,
      "edit visible on disk",
    );
  });

  it("disk → doc: an external write appears in the room", async () => {
    await fs.writeFile(path.join(workDir, "fromdisk.md"), "# written by the terminal\n");

    const files = peer.doc.getMap<Y.Text>("files");
    await waitFor(() => files.has("fromdisk.md"), 5_000, "fromdisk.md in room");
    expect(files.get("fromdisk.md")!.toString()).toBe("# written by the terminal\n");
  });

  it("disk → doc: external modification patches the Y.Text minimally", async () => {
    const abs = path.join(workDir, "src", "hello.ts");
    const current = await fs.readFile(abs, "utf8");
    await fs.writeFile(abs, current + "// appended externally\n");

    const files = peer.doc.getMap<Y.Text>("files");
    await waitFor(
      () => files.get("src/hello.ts")!.toString().endsWith("// appended externally\n"),
      5_000,
      "external append in room",
    );
  });

  it("doc-side delete removes the file from disk", async () => {
    const files = peer.doc.getMap<Y.Text>("files");
    peer.doc.transact(() => files.delete("fromdisk.md"));

    await waitFor(
      async () => {
        try {
          await fs.stat(path.join(workDir, "fromdisk.md"));
          return false;
        } catch {
          return true;
        }
      },
      5_000,
      "fromdisk.md deleted",
    );
  });

  it("ignores binary and ignored-directory files", async () => {
    await fs.mkdir(path.join(workDir, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(workDir, "node_modules", "dep.js"), "ignored");
    await fs.writeFile(path.join(workDir, "image.bin"), Buffer.from([0, 1, 2, 0, 255]));
    await new Promise((r) => setTimeout(r, 500)); // give the watcher a beat

    const files = peer.doc.getMap<Y.Text>("files");
    expect(files.has("node_modules/dep.js")).toBe(false);
    expect(files.has("image.bin")).toBe(false);
  });
});

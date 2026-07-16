import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Multiplayer harness: each browser context is an independent client
 * (separate localStorage → separate identity, separate Yjs clientID).
 */

function uniqueRoom(): string {
  return `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function openClient(browser: Browser, room: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/w/${room}`);
  // Synced + seed file present + editor painted.
  await page.waitForFunction(
    () => {
      const at = (window as unknown as Record<string, any>).__atelier;
      return at?.provider?.synced === true && !!at.provider.doc.getMap("files").get("main.ts");
    },
    { timeout: 30_000 },
  );
  return page;
}

function docContains(page: Page, needle: string) {
  return page.waitForFunction(
    (s: string) => {
      const at = (window as unknown as Record<string, any>).__atelier;
      return at?.provider?.doc.getMap("files").get("main.ts")?.toString().includes(s) ?? false;
    },
    needle,
    { timeout: 15_000, polling: 50 },
  );
}

async function typeAtEnd(page: Page, text: string) {
  // Typing needs the editor painted and bound (doc-state assertions don't).
  await page.waitForFunction(
    () => document.querySelector(".view-lines")?.textContent?.includes("Welcome"),
    { timeout: 30_000 },
  );
  await page.locator(".monaco-editor").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type(text);
}

test("edits converge across clients with presence and remote cursors", async ({ browser }) => {
  const room = uniqueRoom();
  const a = await openClient(browser, room);
  const b = await openClient(browser, room);

  const marker = `MARKER_${Date.now().toString(36)}`;
  await typeAtEnd(a, `\n// ${marker}`);

  const t0 = Date.now();
  await docContains(b, marker);
  console.log(`cross-client propagation observed in ~${Date.now() - t0}ms`);

  await expect(a.locator(".presence-chip")).toHaveCount(2);
  await expect(b.locator(".presence-chip")).toHaveCount(2);

  // A's caret renders in B as a y-monaco remote-selection decoration. Make
  // sure B's editor is painted/bound, then refresh A's cursor broadcast so
  // the decoration doesn't depend on awareness that predates B's binding.
  await b.waitForFunction(
    () => document.querySelector(".view-lines")?.textContent?.includes("Welcome"),
    { timeout: 30_000 },
  );
  await a.keyboard.press("ArrowLeft");
  await expect(b.locator('[class*="yRemoteSelectionHead"]').first()).toBeAttached();
});

test("late joiner replays full history", async ({ browser }) => {
  const room = uniqueRoom();
  const a = await openClient(browser, room);

  const marker = `HISTORY_${Date.now().toString(36)}`;
  await typeAtEnd(a, `\n// ${marker}`);
  await docContains(a, marker);

  const c = await openClient(browser, room); // fresh client, no prior state
  await docContains(c, marker);
});

test("edits made while disconnected reconcile after reconnect", async ({ browser }) => {
  const room = uniqueRoom();
  const a = await openClient(browser, room);
  const b = await openClient(browser, room);

  // Sever B's socket and edit in the same JS task — the edit is guaranteed
  // to happen before any reconnect. The real backoff + re-sync path must
  // then deliver it to A.
  await b.evaluate(() => {
    const at = (window as unknown as Record<string, any>).__atelier;
    at.conn.debugDrop();
    at.provider.doc.getMap("files").get("main.ts").insert(0, "// OFFLINE_EDIT\n");
  });

  await docContains(a, "OFFLINE_EDIT");
  // And B is live again afterwards.
  await b.waitForFunction(
    () => (window as unknown as Record<string, any>).__atelier?.provider?.synced === true,
  );
});

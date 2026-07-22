"use client";

import { useEffect, useState } from "react";
import type { AtelierProvider } from "@atelier/client";

/**
 * Latest test result from the Tester agent (blueprint doc 07). The tester
 * writes results into the room's shared Y.Map("tests"); this shows the most
 * recent one so every participant sees pass/fail live. Mirrors
 * services/conductor/src/proposals.ts (TestResult).
 */
interface TestResult {
  id: string;
  runId: string;
  tester: string;
  command: string;
  status: "pass" | "fail";
  exitCode: number;
  output: string;
  durationMs: number;
  at: string;
}

const TESTS_KEY = "tests";

export default function TestStatus({ provider }: { provider: AtelierProvider }) {
  const [latest, setLatest] = useState<TestResult | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const tests = provider.doc.getMap<TestResult>(TESTS_KEY);
    const refresh = () => {
      const all = [...tests.values()].sort((a, b) => a.at.localeCompare(b.at));
      setLatest(all.length > 0 ? all[all.length - 1]! : null);
    };
    tests.observe(refresh);
    refresh();
    return () => tests.unobserve(refresh);
  }, [provider]);

  if (!latest) return null;

  return (
    <div className={`test-status test-${latest.status}`}>
      <button className="test-status-head" onClick={() => setOpen((o) => !o)} title={latest.command}>
        <span className="test-badge">{latest.status === "pass" ? "✓ pass" : "✗ fail"}</span>
        <code className="test-cmd">{latest.command}</code>
        <span className="test-meta">
          exit {latest.exitCode} · {latest.durationMs}ms
        </span>
      </button>
      {open && latest.output.trim().length > 0 && (
        <pre className="test-output">{latest.output.trim()}</pre>
      )}
    </div>
  );
}

#!/usr/bin/env node
/**
 * Simulator CLI — npm run sim -- --scenario <name> [--target core|file] [--speed ms]
 * 注入标准化事件到 Core（默认 127.0.0.1:17893），或写 JSONL 文件。
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { readApiToken } from "../core/token.ts";
import { generateScenario, SCENARIOS } from "./scenarios.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const scenario = (arg("scenario") ?? "normal") as Parameters<typeof generateScenario>[0];
  if (!SCENARIOS.includes(scenario)) {
    console.error(`unknown scenario: ${scenario}. choices: ${SCENARIOS.join(", ")}`);
    process.exit(1);
  }
  const target = arg("target") ?? "core";
  const speed = Number(arg("speed") ?? "0");
  const events = generateScenario(scenario);
  console.log(`[sim] scenario=${scenario} events=${events.length} target=${target}`);

  if (target === "file") {
    const file = arg("file") ?? join(".vibepaws", "sim_events.jsonl");
    for (const e of events) appendFileSync(file, JSON.stringify(e) + "\n");
    console.log(`[sim] wrote ${events.length} events → ${file}`);
    return;
  }

  const port = Number(arg("port") ?? "17893");
  const base = `http://127.0.0.1:${port}`;
  const token = readApiToken();
  if (!token) {
    console.error(`[sim] 找不到 api_token（cwd/.vibepaws 或 ~/.vibepaws）— 先启动 Core`);
    process.exit(1);
  }

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const res = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vibepaws-token": token },
      body: JSON.stringify(e),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    if (!json.ok) {
      console.error(`[sim] event ${e.event_id} rejected: ${json.error}`);
    } else if (i % 2 === 0 || has("verbose")) {
      console.log(`[sim] + ${e.event_type.padEnd(22)} ${e.agent} ${e.session_id}`);
    }
    if (speed > 0 && i < events.length - 1) await new Promise((r) => setTimeout(r, speed));
  }
  console.log(`[sim] done: ${events.length} events → ${base}`);
}

main().catch((err) => {
  console.error("[sim] failed:", err);
  process.exit(1);
});

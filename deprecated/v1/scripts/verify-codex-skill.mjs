#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const cwd = process.argv[2] ?? process.cwd();
const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
let finished = false;
let timeout;

function send(value) {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function finish(exitCode, message) {
  if (finished) return;
  finished = true;
  if (timeout) clearTimeout(timeout);
  if (message) (exitCode === 0 ? process.stdout : process.stderr).write(`${message}\n`);
  process.exitCode = exitCode;
  child.kill("SIGTERM");
}

child.on("error", (error) => finish(2, `No se pudo ejecutar Codex App Server: ${error.message}`));
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === 1) {
      send({ method: "initialized", params: {} });
      send({ id: 2, method: "skills/list", params: { cwds: [cwd], forceReload: true } });
      continue;
    }
    if (message.id !== 2) continue;
    if (message.error) {
      finish(2, `Codex rechazó skills/list: ${message.error.message ?? JSON.stringify(message.error)}`);
      return;
    }
    const entry = message.result?.data?.[0];
    const direct = entry?.skills?.find((skill) => skill.name === "use-hrp");
    if (direct?.enabled) {
      finish(0, `Codex detectó use-hrp correctamente: ${direct.path}`);
      return;
    }
    const qualified = entry?.skills?.find((skill) => skill.name.endsWith(":use-hrp"));
    if (qualified) {
      finish(1, `Codex registró ${qualified.name} en vez de use-hrp; reinstala la copia standalone.`);
      return;
    }
    const errors = entry?.errors?.map((error) => error.message ?? JSON.stringify(error)).join("; ");
    finish(1, `Codex no detectó use-hrp.${errors ? ` Errores: ${errors}` : ""}`);
  }
});

send({
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "hrp-install-verifier", version: "0.4.0" },
    capabilities: { experimentalApi: true },
  },
});

timeout = setTimeout(() => finish(2, "Codex App Server no respondió a skills/list en 10 segundos."), 10_000);

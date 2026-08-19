import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProtocolConfig } from "@human-review/protocol";
import { ProtocolOrchestrator } from "./orchestrator.js";

const execFileAsync = promisify(execFile);

export type ObserverStatus = {
  state: "disabled" | "watching" | "unavailable" | "stopped";
  detail: string;
  lastObservedAt?: string;
};

type Capture = { hash: string; files: string[]; diff: string; truncated: boolean };

export class WorkspaceObserver {
  #timer?: NodeJS.Timeout;
  #lastHash?: string;
  #polling = false;
  #status: ObserverStatus;

  constructor(
    private readonly config: ProtocolConfig,
    private readonly orchestrator: ProtocolOrchestrator,
  ) {
    this.#status = config.workspaceObserver.enabled
      ? { state: "stopped", detail: "Observer not started" }
      : { state: "disabled", detail: "Disabled in protocol.config.json" };
  }

  getStatus(): ObserverStatus {
    return { ...this.#status };
  }

  async start(): Promise<void> {
    if (!this.config.workspaceObserver.enabled) return;
    try {
      const capture = await this.#capture();
      this.#lastHash = capture.hash;
      this.#status = { state: "watching", detail: "Git workspace observer active" };
      this.#timer = setInterval(() => void this.#poll(), this.config.workspaceObserver.pollIntervalMs);
      this.#timer.unref();
    } catch (error) {
      this.#status = {
        state: "unavailable",
        detail: error instanceof Error ? error.message : "Git workspace observer unavailable",
      };
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#status.state === "watching") this.#status = { state: "stopped", detail: "Observer stopped" };
  }

  async #git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.config.workspaceRoot,
      encoding: "utf8",
      maxBuffer: this.config.workspaceObserver.maxDiffBytes * 3,
    });
    return stdout;
  }

  async #capture(): Promise<Capture> {
    const inside = (await this.#git(["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") throw new Error("Workspace root is not a Git worktree");
    const status = await this.#git(["status", "--porcelain=v1", "--untracked-files=all"]);
    let diff = "";
    try {
      diff = await this.#git(["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", "."]);
    } catch {
      diff = await this.#git(["diff", "--no-ext-diff", "--unified=3", "--", "."]);
    }
    const files = status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).split(" -> ").at(-1) ?? line.slice(3));
    const raw = Buffer.from(diff, "utf8");
    const truncated = raw.byteLength > this.config.workspaceObserver.maxDiffBytes;
    const visibleDiff = truncated
      ? raw.subarray(0, this.config.workspaceObserver.maxDiffBytes).toString("utf8")
      : diff;
    return {
      hash: createHash("sha256").update(status).update("\0").update(diff).digest("hex"),
      files,
      diff: visibleDiff,
      truncated,
    };
  }

  async #poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const capture = await this.#capture();
      if (capture.hash !== this.#lastHash) {
        this.#lastHash = capture.hash;
        await this.orchestrator.observeWorkspaceSnapshot(capture);
        this.#status = {
          state: "watching",
          detail: "Git workspace observer active",
          lastObservedAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      this.#status = {
        state: "unavailable",
        detail: error instanceof Error ? error.message : "Workspace observation failed",
      };
      this.stop();
    } finally {
      this.#polling = false;
    }
  }
}

import { describe, expect, it } from "vitest";
import { agentAttentionCommand, agentAttentionReleaseInstruction } from "./agent-attention";

describe("agentAttentionCommand", () => {
  it("builds the attention command for the selected model and workspace", () => {
    expect(agentAttentionCommand("claude", "/Users/rrrssa/Documents/mysrc/hrp"))
      .toBe("hrp attention --agent claude --workspace /Users/rrrssa/Documents/mysrc/hrp --wait 1800");
    expect(agentAttentionCommand("codex", "/Users/rrrssa/Documents/mysrc/hrp"))
      .toBe("hrp attention --agent codex --workspace /Users/rrrssa/Documents/mysrc/hrp --wait 1800");
  });

  it("quotes workspace paths that contain shell-sensitive characters", () => {
    expect(agentAttentionCommand("antigravity", "/Users/dev/My Project's repo"))
      .toBe("hrp attention --agent antigravity --workspace '/Users/dev/My Project'\"'\"'s repo' --wait 1800");
  });

  it("builds the release instruction for stopping a manual attention wait", () => {
    expect(agentAttentionReleaseInstruction("codex"))
      .toBe("Presiona Ctrl+C en la terminal donde codex esta ejecutando hrp attention para dejar de esperar HRP.");
  });
});

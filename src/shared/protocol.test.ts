import { describe, expect, it } from "vitest";
import {
  attentionCommand,
  computeAuditStatus,
  isUnresolvedAcceptance,
  isValidFamily,
  isValidSessionId,
  runIsOnHold,
  sessionFamily,
  voteIsCurrent,
  type ChangeNode,
  type Session,
} from "./protocol.js";

function node(partial: Partial<ChangeNode> & Pick<ChangeNode, "id">): ChangeNode {
  return {
    runId: "r1", file: "a.ts", symbol: "f", title: "t", description: "d", rationale: "r",
    status: "completed", author: "claude:1", dependencies: [], auditedBy: [],
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    ...partial,
  };
}

function session(partial: Partial<Session> & Pick<Session, "id" | "role">): Session {
  return {
    runId: "r1", family: sessionFamily(partial.id), status: "attached",
    reviewedNodeIds: [], requirementReviewed: false, integrationReviewed: false,
    attachedAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-09-01T00:00:00Z",
    ...partial,
  };
}

describe("identidades", () => {
  it("valida familias y sesiones acuñadas", () => {
    expect(isValidFamily("claude")).toBe(true);
    expect(isValidFamily("claude:2")).toBe(false);
    expect(isValidSessionId("claude:2")).toBe(true);
    expect(isValidSessionId("claude")).toBe(false);
    expect(sessionFamily("codex:3")).toBe("codex");
  });

  it("el comando de enganche es uno solo por run", () => {
    expect(attentionCommand("3f9a2c1d")).toBe("/hrp attention 3f9a2c1d");
  });
});

describe("hallazgos", () => {
  it("un crítico vivo pone el run en hold", () => {
    expect(runIsOnHold([{ status: "open", severity: "critical" }])).toBe(true);
    expect(runIsOnHold([{ status: "rejected", severity: "critical" }, { status: "open", severity: "major" }])).toBe(false);
  });

  it("aceptar sin corregir sigue vivo", () => {
    const nodes = [node({ id: "n1", status: "running" })];
    expect(isUnresolvedAcceptance({ status: "accepted" }, nodes)).toBe(true);
    expect(isUnresolvedAcceptance({ status: "accepted", resolutionNodeId: "n1" }, nodes)).toBe(true);
    expect(isUnresolvedAcceptance({ status: "accepted", resolutionNodeId: "n1" }, [node({ id: "n1" })])).toBe(false);
  });
});

describe("votos", () => {
  it("caducan cuando se completa un nodo después", () => {
    const voter = { vote: "ok" as const, votedAt: "2026-09-01T01:00:00Z" };
    expect(voteIsCurrent(voter, [node({ id: "n1", updatedAt: "2026-09-01T00:30:00Z" })])).toBe(true);
    expect(voteIsCurrent(voter, [node({ id: "n2", updatedAt: "2026-09-01T02:00:00Z" })])).toBe(false);
    expect(voteIsCurrent({ vote: undefined }, [])).toBe(false);
  });
});

describe("gate", () => {
  const base = session({ id: "claude:1", role: "base" });

  it("no cierra sin auditoría ajena ni voto", () => {
    const status = computeAuditStatus({ status: "implemented", base: "claude:1" }, [node({ id: "n1" })], [base], []);
    expect(status.canClose).toBe(false);
    expect(status.unauditedNodeIds).toEqual(["n1"]);
    expect(status.blockers.join(" ")).toMatch(/voto OK/);
  });

  it("la auditoría propia no cuenta", () => {
    const status = computeAuditStatus({ status: "implemented", base: "claude:1" }, [node({ id: "n1", auditedBy: ["claude:1"] })], [base], []);
    expect(status.unauditedNodeIds).toEqual(["n1"]);
  });

  it("dos sesiones de la misma familia bastan", () => {
    const auditor = session({ id: "claude:2", role: "auditor", vote: "ok", votedAt: "2026-09-01T03:00:00Z" });
    const status = computeAuditStatus(
      { status: "implemented", base: "claude:1" },
      [node({ id: "n1", auditedBy: ["claude:2"] })],
      [base, auditor],
      [],
    );
    expect(status.canClose).toBe(true);
    expect(status.distinctFamilies).toEqual(["claude"]);
  });

  it("un hallazgo vivo o una aceptación sin corregir bloquean", () => {
    const auditor = session({ id: "codex:1", role: "auditor", vote: "ok", votedAt: "2026-09-01T03:00:00Z" });
    const nodes = [node({ id: "n1", auditedBy: ["codex:1"] })];
    expect(computeAuditStatus({ status: "implemented", base: "claude:1" }, nodes, [base, auditor], [{ status: "open", severity: "minor" }]).canClose).toBe(false);
    expect(computeAuditStatus({ status: "implemented", base: "claude:1" }, nodes, [base, auditor], [{ status: "accepted", severity: "minor" }]).canClose).toBe(false);
  });

  it("los rechazos pesan contra la mayoría y los votos caducados quedan pendientes", () => {
    const ok = session({ id: "codex:1", role: "auditor", vote: "ok", votedAt: "2026-09-01T03:00:00Z" });
    const reject = session({ id: "claude:2", role: "auditor", vote: "reject", votedAt: "2026-09-01T03:00:00Z" });
    const stale = session({ id: "claude:3", role: "auditor", vote: "ok", votedAt: "2026-08-31T00:00:00Z" });
    const nodes = [node({ id: "n1", auditedBy: ["codex:1"] })];
    const status = computeAuditStatus({ status: "implemented", base: "claude:1" }, nodes, [base, ok, reject, stale], []);
    expect(status.canClose).toBe(false);
    expect(status.pendingVoters).toEqual(["claude:3"]);
    expect(status.blockers.join(" ")).toMatch(/sin mayoría/);
  });
});

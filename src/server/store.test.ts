import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeAttention } from "./attention.js";
import { FAILED_OUTPUT_HEAD, FAILED_OUTPUT_TAIL, HrpStore, PASSED_OUTPUT_LIMIT, reconstructBaseFiles, runVerification, stripAnsi, trimVerificationOutput } from "./store.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const exercised = [{ text: "abrir el panel", observed: "el panel muestra el nodo con su diff" }];

let dataDir: string;
let workspace: string;
let store: HrpStore;

function baseInput(overrides: Partial<Parameters<HrpStore["createRun"]>[1]> = {}) {
  return {
    title: "Guardar tema",
    requirement: "Quiero que el tema elegido se guarde",
    interpretation: "Persistir la preferencia en localStorage",
    acceptance: [{ text: "el test pasa", command: "test -f src/prefs.ts" }, { text: "abrir el panel", exercise: true }],
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "hrp-data-"));
  workspace = mkdtempSync(path.join(os.tmpdir(), "hrp-ws-"));
  git(workspace, "init", "-q", "-b", "main");
  git(workspace, "config", "user.email", "test@example.com");
  git(workspace, "config", "user.name", "HRP Test");
  writeFileSync(path.join(workspace, "README.md"), "# demo\n");
  git(workspace, "add", ".");
  git(workspace, "commit", "-q", "-m", "init");
  store = new HrpStore(dataDir);
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function startRun() {
  const project = store.attachProject(workspace);
  return { project, ...store.createRun(project.id, baseInput(), "claude") };
}

function implementNode(runId: string, actor: string, file = "src/prefs.ts", content = "export const saveTheme = () => {};\n") {
  const node = store.openNode(runId, actor, { file, symbol: "saveTheme", title: "Persistir tema", description: "guarda", rationale: "porque sí" });
  writeFileSync(path.join(workspace, file), content);
  store.verifyNode(runId, node.id, `test -f ${file}`, actor);
  return store.completeNode(runId, node.id, actor, { summary: "Guarda el tema" });
}

describe("run", () => {
  it("escribe el issue, crea la rama y acuña al base", () => {
    const { run, session, project } = startRun();
    expect(run.id).toMatch(/^[0-9a-f]{8}$/);
    expect(run.branch).toBe(`hrp/run-${run.id}`);
    expect(git(workspace, "branch", "--show-current")).toBe(run.branch);
    expect(session.id).toBe("claude:1");
    expect(session.role).toBe("base");
    const issue = store.readIssue(run.id);
    expect(issue).toContain("## Requerimiento literal\nQuiero que el tema elegido se guarde");
    expect(issue).toContain(`workspaceRoot: ${project.workspaceRoot}`);
    expect(run.phase).toBe("open");
  });

  it("copia los adjuntos en vez de enlazarlos", () => {
    const source = path.join(os.tmpdir(), `hrp-adjunto-${Date.now()}.png`);
    writeFileSync(source, "png");
    const project = store.attachProject(workspace);
    const { run } = store.createRun(project.id, baseInput({ attachments: [{ path: source, note: "pantalla" }] }), "claude");
    rmSync(source);
    expect(run.attachments).toEqual(["attachments/" + path.basename(source)]);
    expect(store.readIssue(run.id)).toContain(`attachments/${path.basename(source)} — pantalla`);
  });

  it("exige un criterio que ejercite el artefacto", () => {
    const project = store.attachProject(workspace);
    expect(() => store.createRun(project.id, baseInput({ acceptance: [{ text: "compila", command: "true" }] }), "claude")).toThrow(/exercise: true/);
    const { run } = store.createRun(project.id, baseInput(), "claude");
    expect(store.readIssue(run.id)).toContain("- [ejercicio] abrir el panel");
  });

  it("no abre dos runs vivos en el mismo proyecto", () => {
    const { project } = startRun();
    expect(() => store.createRun(project.id, baseInput(), "codex")).toThrow(/ya tiene un run abierto/);
  });
});

describe("nodos", () => {
  it("completar mide el diff con git y deja un commit en la rama", () => {
    const { run } = startRun();
    mkdirSyncSafe(path.join(workspace, "src"));
    const node = implementNode(run.id, "claude:1");
    expect(node.status).toBe("completed");
    expect(node.diff).toContain("+export const saveTheme");
    expect(node.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(workspace, "log", "-1", "--format=%s")).toBe(`hrp(${run.id}) ${node.id}: Persistir tema`);
    expect(store.getRun(run.id)!.completedCount).toBe(1);
  });

  it("un nodo de varios archivos deja un solo commit con todos", () => {
    const { run } = startRun();
    mkdirSyncSafe(path.join(workspace, "src"));
    const node = store.openNode(run.id, "claude:1", { files: ["src/mod.ts", "src/mod.test.ts"], symbol: "mod", title: "Módulo y prueba", description: "d", rationale: "r" });
    expect(node.files).toEqual(["src/mod.ts", "src/mod.test.ts"]);
    expect(node.file).toBe("src/mod.ts");
    writeFileSync(path.join(workspace, "src/mod.ts"), "export const mod = 1;\n");
    writeFileSync(path.join(workspace, "src/mod.test.ts"), "import { mod } from './mod';\n");
    store.verifyNode(run.id, node.id, "true", "claude:1");
    const done = store.completeNode(run.id, node.id, "claude:1", { summary: "ambos" });
    expect(done.diff).toContain("src/mod.ts");
    expect(done.diff).toContain("src/mod.test.ts");
    expect(git(workspace, "show", "--stat", "--format=", "HEAD")).toMatch(/2 files changed/);
    expect(() => store.openNode(run.id, "claude:1", { files: ["../fuera.ts"], symbol: "x", title: "t", description: "d", rationale: "r" })).toThrow(/fuera del workspace/);
  });

  it("la verificación se guarda sin color y recortada según el resultado", () => {
    const passed = runVerification(workspace, "printf '\\033[32mok\\033[0m\\n'; printf 'a\\rb\\n'");
    // El retorno de carro suelto se elimina sin reescribir la línea: queda "ab".
    expect(passed.output).toBe("ok\nab\n");
    expect(stripAnsi("\u001b]0;title\u0007x\u001b[1;31my\u001b[0m")).toBe("xy");
    const long = "x".repeat(PASSED_OUTPUT_LIMIT + 100);
    expect(trimVerificationOutput(long, true)).toHaveLength(PASSED_OUTPUT_LIMIT + 2);
    expect(trimVerificationOutput(long, false)).toBe(long);
    const failed = trimVerificationOutput("y".repeat(FAILED_OUTPUT_HEAD + FAILED_OUTPUT_TAIL + 1), false);
    expect(failed).toHaveLength(FAILED_OUTPUT_HEAD + FAILED_OUTPUT_TAIL + 3);
  });

  it("exige verificación aprobada y diff real", () => {
    const { run } = startRun();
    const node = store.openNode(run.id, "claude:1", { file: "README.md", symbol: "intro", title: "t", description: "d", rationale: "r" });
    expect(() => store.completeNode(run.id, node.id, "claude:1", { summary: "x" })).toThrow(/verificación aprobada/);
    store.verifyNode(run.id, node.id, "true", "claude:1");
    expect(() => store.completeNode(run.id, node.id, "claude:1", { summary: "x" })).toThrow(/diff real/);
  });

  it("sólo el base abre nodos", () => {
    const { run } = startRun();
    const auditor = store.attachSession(run.id, "codex");
    expect(auditor.id).toBe("codex:1");
    expect(() => store.openNode(run.id, auditor.id, { file: "a", symbol: "b", title: "c", description: "d", rationale: "e" })).toThrow(/es auditor/);
  });
});

describe("auditoría y gate", () => {
  it("cierra solo con auditoría ajena y voto, y libera a todos", () => {
    const { run } = startRun();
    mkdirSyncSafe(path.join(workspace, "src"));
    const node = implementNode(run.id, "claude:1");
    const auditor = store.attachSession(run.id, "claude");
    expect(auditor.id).toBe("claude:2");

    expect(() => store.closeRun(run.id, "claude:2")).toThrow(/Sólo el base/);
    expect(() => store.closeRun(run.id, "claude:1")).toThrow(/Ejercita el artefacto/);
    const closed = store.closeRun(run.id, "claude:1", exercised);
    expect(closed.acceptance.find((criterion) => criterion.exercise)?.observed).toBe(exercised[0].observed);
    expect(closed.passed).toBe(true);
    expect(closed.run.status).toBe("implemented");
    expect(closed.run.audit.canClose).toBe(false);

    expect(() => store.vote(run.id, "claude:2", "ok")).toThrow(/hrp_audit_done/);
    store.markAudited(run.id, "claude:2", { nodeIds: [node.id], requirement: true });
    store.vote(run.id, "claude:2", "ok", "sin observaciones");
    const final = store.getRun(run.id)!;
    expect(final.status).toBe("closed");
    expect(final.attachedSessions).toEqual([]);
    expect(computeAttention(store.getRunDetail(run.id)!, "claude:2").kind).toBe("released");
  });

  it("un hallazgo crítico pone hold y bloquea abrir nodos hasta resolverlo", () => {
    const { run } = startRun();
    mkdirSyncSafe(path.join(workspace, "src"));
    const node = implementNode(run.id, "claude:1");
    const auditor = store.attachSession(run.id, "codex");
    const finding = store.createFinding(run.id, { reviewer: auditor.id, severity: "critical", title: "Rompe el tema", body: "no persiste", nodeId: node.id });
    expect(store.getRun(run.id)!.phase).toBe("hold");
    expect(computeAttention(store.getRunDetail(run.id)!, "claude:1").kind).toBe("hold");
    expect(() => store.openNode(run.id, "claude:1", { file: "a", symbol: "b", title: "c", description: "d", rationale: "e" })).toThrow(/hold/);
    expect(() => store.acceptFinding(finding.id, auditor.id)).toThrow(/Sólo el base/);
    store.acceptFinding(finding.id, "claude:1");
    expect(store.getRun(run.id)!.phase).toBe("open");
    const fix = store.openNode(run.id, "claude:1", { file: "src/prefs.ts", symbol: "saveTheme", title: "Corregir", description: "d", rationale: "r", resolves: finding.id });
    expect(store.getFinding(finding.id)!.resolutionNodeId).toBe(fix.id);
    expect(store.getRun(run.id)!.audit.liveFindings).toBe(1);
  });

  it("reportar sobre un nodo cuenta como auditarlo y lo propio se rechaza", () => {
    const { run } = startRun();
    mkdirSyncSafe(path.join(workspace, "src"));
    const node = implementNode(run.id, "claude:1");
    const auditor = store.attachSession(run.id, "claude");
    store.createFinding(run.id, { reviewer: auditor.id, severity: "minor", title: "t", body: "b", nodeId: node.id });
    expect(store.getNode(run.id, node.id)!.auditedBy).toEqual(["claude:2"]);
    expect(() => store.markAudited(run.id, "claude:1", { nodeIds: [node.id] })).toThrow(/es el base/);
  });

  it("el cierre no procede con criterios de aceptación fallidos", () => {
    const project = store.attachProject(workspace);
    const { run } = store.createRun(project.id, baseInput({ acceptance: [{ text: "falla", command: "false" }, { text: "abrir", exercise: true }] }), "claude");
    const node = store.openNode(run.id, "claude:1", { file: "README.md", symbol: "intro", title: "t", description: "d", rationale: "r" });
    writeFileSync(path.join(workspace, "README.md"), "# demo 2\n");
    store.verifyNode(run.id, node.id, "true", "claude:1");
    store.completeNode(run.id, node.id, "claude:1", { summary: "x" });
    const result = store.closeRun(run.id, "claude:1", [{ text: "abrir", observed: "abierto" }]);
    expect(result.passed).toBe(false);
    expect(result.run.status).toBe("open");
    expect(result.acceptance[0].result?.exitCode).not.toBe(0);
  });

  it("la atención guía al auditor por requerimiento, nodos y cierre", () => {
    const { run } = startRun();
    mkdirSyncSafe(path.join(workspace, "src"));
    const node = implementNode(run.id, "claude:1");
    const auditor = store.attachSession(run.id, "codex");
    const detail = () => store.getRunDetail(run.id)!;
    expect(computeAttention(detail(), auditor.id).kind).toBe("requirement");
    store.markAudited(run.id, auditor.id, { requirement: true });
    expect(computeAttention(detail(), auditor.id).kind).toBe("node");
    store.markAudited(run.id, auditor.id, { nodeIds: [node.id] });
    expect(computeAttention(detail(), auditor.id).kind).toBe("wait");
    expect(computeAttention(detail(), "claude:1").kind).toBe("resume");
    store.closeRun(run.id, "claude:1", exercised);
    expect(computeAttention(detail(), auditor.id).kind).toBe("close");
    expect(computeAttention(detail(), "claude:1").kind).toBe("wait");
  });

  it("los hooks encuentran su sesión por el proceso anfitrión", () => {
    const { run } = startRun();
    store.bindSessionHost(run.id, "claude:1", [4242]);
    const auditor = store.attachSession(run.id, "codex", [777]);
    expect(store.sessionsForHostPids([1, 4242]).map((session) => session.id)).toEqual(["claude:1"]);
    expect(store.sessionsForHostPids([777]).map((session) => session.id)).toEqual([auditor.id]);
    expect(store.sessionsForHostPids([9])).toEqual([]);
  });
});

function mkdirSyncSafe(target: string) {
  execFileSync("mkdir", ["-p", target]);
}

// Lleva un run hasta 'closed' con un auditor: la continuación exige eso.
function closeWithAuditor(runId: string, family = "codex") {
  const node = implementNode(runId, "claude:1");
  const auditor = store.attachSession(runId, family);
  store.closeRun(runId, "claude:1", exercised);
  store.markAudited(runId, auditor.id, { nodeIds: [node.id], requirement: true });
  store.vote(runId, auditor.id, "ok");
  expect(store.getRun(runId)!.status).toBe("closed");
  return { node, auditor };
}

describe("continuación", () => {
  it("un run nuevo continúa uno cerrado y su rama nace de la punta de la anterior", () => {
    const { run, project } = startRun();
    mkdirSyncSafe(path.join(workspace, "src"));
    closeWithAuditor(run.id);
    const tip = git(workspace, "rev-parse", run.branch);
    git(workspace, "switch", "-q", "main");
    const next = store.createRun(project.id, baseInput({ title: "Guardar tema 2", continues: run.id }), "claude");
    expect(next.run.continues).toBe(run.id);
    expect(git(workspace, "branch", "--show-current")).toBe(next.run.branch);
    expect(git(workspace, "rev-parse", "HEAD")).toBe(tip);
    expect(store.getRun(run.id)!.continuedBy).toEqual([next.run.id]);
    const issue = store.readIssue(next.run.id);
    expect(issue).toContain(`continues: ${run.id}`);
    expect(issue).toContain(`## Antecedente\nContinúa el run ${run.id} (Guardar tema)`);
    expect(store.getRunDetail(run.id)!.activity[0].message).toContain(`Continuado por el run ${next.run.id}`);
  });

  it("sólo se continúa un run cerrado del mismo proyecto", () => {
    const { run, project } = startRun();
    expect(() => store.createRun(project.id, baseInput({ continues: run.id }), "claude")).toThrow(/ya tiene un run abierto/);
    store.setRunControl(run.id, "stopped");
    expect(() => store.createRun(project.id, baseInput({ continues: run.id }), "claude")).toThrow(/sólo se continúa un run cerrado/);
    expect(() => store.createRun(project.id, baseInput({ continues: "00000000" }), "claude")).toThrow(/Unknown run/);
  });

  it("si la rama anterior ya no existe, la continuación parte del árbol actual", () => {
    const { run, project } = startRun();
    mkdirSyncSafe(path.join(workspace, "src"));
    closeWithAuditor(run.id);
    git(workspace, "switch", "-q", "main");
    git(workspace, "merge", "-q", run.branch);
    git(workspace, "branch", "-D", run.branch);
    const next = store.createRun(project.id, baseInput({ continues: run.id }), "claude");
    expect(git(workspace, "branch", "--show-current")).toBe(next.run.branch);
    expect(store.getRunDetail(next.run.id)!.activity.some((entry) => entry.detail?.includes("ya no existe"))).toBe(true);
  });
});

describe("adenda", () => {
  it("anexa el requerimiento al issue, suma criterios y reabre un run implementado", () => {
    const { run } = startRun();
    mkdirSyncSafe(path.join(workspace, "src"));
    const node = implementNode(run.id, "claude:1");
    const auditor = store.attachSession(run.id, "codex");
    store.closeRun(run.id, "claude:1", exercised);
    store.markAudited(run.id, auditor.id, { nodeIds: [node.id], requirement: true });
    expect(computeAttention(store.getRunDetail(run.id)!, auditor.id).kind).toBe("close");
    expect(() => store.extendRun(run.id, auditor.id, { requirement: "x", interpretation: "y" })).toThrow(/Sólo el base/);
    expect(() => store.extendRun(run.id, "claude:1", { requirement: "x" })).toThrow(/interpretación del base/);

    const extended = store.extendRun(run.id, "claude:1", {
      requirement: "Y que también se guarde el idioma",
      interpretation: "Persistir el idioma junto al tema",
      acceptance: [{ text: "el idioma persiste", command: "test -f src/lang.ts" }],
    });
    expect(extended.status).toBe("open");
    expect(extended.extensions).toHaveLength(1);
    expect(extended.extensions[0]).toMatchObject({ ordinal: 1, author: "claude:1", requirement: "Y que también se guarde el idioma" });
    expect(extended.acceptance.map((criterion) => criterion.text)).toEqual(["el test pasa", "abrir el panel", "el idioma persiste"]);
    const issue = store.readIssue(run.id);
    expect(issue).toContain("## Requerimiento literal\nQuiero que el tema elegido se guarde");
    expect(issue).toMatch(/## Adenda 1 · .* · claude:1\n\n### Requerimiento literal\nY que también se guarde el idioma/);
    expect(issue).toContain("- `test -f src/lang.ts` — el idioma persiste");

    // La auditoría del nodo se conserva; el requerimiento se vuelve a auditar.
    expect(store.getNode(run.id, node.id)!.auditedBy).toEqual([auditor.id]);
    const detail = store.getRunDetail(run.id)!;
    expect(detail.sessions.find((session) => session.id === auditor.id)!.requirementReviewed).toBe(false);
    const requirement = computeAttention(detail, auditor.id);
    expect(requirement.kind).toBe("requirement");
    expect(requirement.directive).toContain("adenda 1");
    const resume = computeAttention(detail, "claude:1");
    expect(resume.kind).toBe("resume");
    expect(resume.directive).toContain("adenda 1");
    expect(() => store.extendRun(run.id, "claude:1", { requirement: "otra", interpretation: "i", acceptance: [{ text: "abrir el panel" }] })).toThrow(/ya existe/);
  });

  it("anula los votos y el cierre exige cumplir también lo nuevo", () => {
    const { run } = startRun();
    mkdirSyncSafe(path.join(workspace, "src"));
    const node = implementNode(run.id, "claude:1");
    const first = store.attachSession(run.id, "codex");
    const second = store.attachSession(run.id, "codex");
    store.closeRun(run.id, "claude:1", exercised);
    store.markAudited(run.id, first.id, { nodeIds: [node.id], requirement: true });
    store.markAudited(run.id, second.id, { nodeIds: [node.id], requirement: true });
    store.vote(run.id, second.id, "reject", "falta el idioma");
    store.vote(run.id, first.id, "ok");
    const tied = store.getRun(run.id)!;
    expect(tied.status).toBe("implemented");
    expect(tied.audit.okVotes).toEqual([first.id]);
    expect(tied.audit.rejectVotes).toEqual([second.id]);

    store.extendRun(run.id, "human", { requirement: "Y el idioma", acceptance: [{ text: "el idioma persiste", command: "test -f src/lang.ts" }] });
    const reopened = store.getRun(run.id)!;
    expect(reopened.status).toBe("open");
    expect(reopened.audit.okVotes).toEqual([]);
    expect(reopened.audit.rejectVotes).toEqual([]);
    expect(reopened.extensions[0].author).toBe("human");
    expect(store.readIssue(run.id)).toContain("(sin interpretación: la adenda la escribió el humano");
    expect(computeAttention(store.getRunDetail(run.id)!, second.id).kind).toBe("requirement");

    // Cerrar sin implementar la adenda falla en su criterio.
    const failed = store.closeRun(run.id, "claude:1", exercised);
    expect(failed.passed).toBe(false);
    expect(failed.acceptance.find((criterion) => criterion.text === "el idioma persiste")!.result!.passed).toBe(false);
    implementNode(run.id, "claude:1", "src/lang.ts", "export const lang = 'es';\n");
    expect(computeAttention(store.getRunDetail(run.id)!, "claude:1").directive).not.toContain("adenda");
    const passed = store.closeRun(run.id, "claude:1", exercised);
    expect(passed.passed).toBe(true);
    expect(passed.run.status).toBe("implemented");
  });

  it("un run cerrado o detenido no se amplía", () => {
    const { run } = startRun();
    mkdirSyncSafe(path.join(workspace, "src"));
    store.setRunControl(run.id, "stopped");
    expect(() => store.extendRun(run.id, "human", { requirement: "más" })).toThrow(/detenido/);
    store.setRunControl(run.id, "active");
    closeWithAuditor(run.id);
    expect(() => store.extendRun(run.id, "human", { requirement: "más" })).toThrow(/run nuevo que lo continúe/);
  });
});

describe("evolución", () => {
  it("parte del padre del primer commit y ordena los cuadros por commit", () => {
    const { run } = startRun();
    const initial = git(workspace, "rev-parse", "HEAD");
    mkdirSyncSafe(path.join(workspace, "src"));
    implementNode(run.id, "claude:1");
    implementNode(run.id, "claude:1", "README.md", "# demo\n\nmás\n");
    const evolution = store.getRunEvolution(run.id);
    expect(evolution.baseCommit).toBe(initial);
    expect(evolution.baseFiles).toEqual(["README.md"]);
    expect(evolution.partial).toBe(false);
    expect(evolution.frames.map((frame) => frame.nodeId)).toEqual(["n1", "n2"]);
    expect(evolution.frames[0].files).toEqual([{ path: "src/prefs.ts", status: "A" }]);
    expect(evolution.frames[1].files).toEqual([{ path: "README.md", status: "M" }]);
    expect(evolution.frames.every((frame) => frame.commit && frame.committedAt)).toBe(true);
  });

  it("sin nodos completados usa el HEAD de la rama del run", () => {
    const { run } = startRun();
    const evolution = store.getRunEvolution(run.id);
    expect(evolution.frames).toEqual([]);
    expect(evolution.baseCommit).toBe(git(workspace, "rev-parse", "HEAD"));
    expect(evolution.baseFiles).toEqual(["README.md"]);
  });

  it("lee el antes y el después de un archivo en el commit del nodo", () => {
    const { run } = startRun();
    mkdirSyncSafe(path.join(workspace, "src"));
    const created = implementNode(run.id, "claude:1");
    const edited = implementNode(run.id, "claude:1", "README.md", "# demo\n\nmás\n");
    expect(store.getRunEvolutionFile(run.id, created.id, "src/prefs.ts")).toEqual({
      path: "src/prefs.ts", before: undefined, after: "export const saveTheme = () => {};\n", binary: false, truncated: false,
    });
    const readme = store.getRunEvolutionFile(run.id, edited.id, "README.md");
    expect(readme.before).toBe("# demo\n");
    expect(readme.after).toBe("# demo\n\nmás\n");
    // Un archivo que no cambió en ese nodo se lee igual en las dos versiones.
    expect(store.getRunEvolutionFile(run.id, edited.id, "src/prefs.ts").before).toBe("export const saveTheme = () => {};\n");
    expect(() => store.getRunEvolutionFile(run.id, created.id, "../fuera.ts")).toThrow(/fuera del workspace/);
    const pending = store.openNode(run.id, "claude:1", { file: "src/x.ts", symbol: "x", title: "t", description: "d", rationale: "r" });
    expect(() => store.getRunEvolutionFile(run.id, pending.id, "src/x.ts")).toThrow(/no tiene commit/);
  });

  it("reconstruye el árbol base con los archivos que no nacieron en el run", () => {
    expect(reconstructBaseFiles([
      { nodeId: "n1", files: [{ path: "src/new.ts", status: "A" }, { path: "README.md", status: "M" }] },
      { nodeId: "n2", files: [{ path: "src/new.ts", status: "M" }, { path: "src/moved.ts", status: "R", from: "src/old.ts" }] },
      { nodeId: "n3", files: [{ path: "src/moved.ts", status: "D" }, { path: "src/gone.ts", status: "D" }] },
    ])).toEqual(["README.md", "src/gone.ts", "src/old.ts"]);
  });
});

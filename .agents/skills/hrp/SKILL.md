---
name: hrp
description: >-
  Use this skill to integrate task execution and code changes with Human Review Protocol (HRP v3).
  Covers the full lifecycle: checking/starting the HRP service, attaching workspace, creating runs,
  decomposing tasks into granular semantic graphs (file + symbol + intent), waiting for human approval gates,
  executing nodes with agent identity declaration (start → exclusive diff patch → verification → complete),
  handling retries within the same node, registering discovered work, and publishing technical activity.
---

# Human Review Protocol (HRP v3) Skill for Antigravity

This skill defines how Antigravity integrates with HRP v3 following `docs/agent-adapter.md`.

## Core Principles

1. **Granularity Rule**:
   Each node represents exactly:
   `file + symbol or logical section + intention`
   - Two independent changes in the same file MUST be two distinct nodes.
   - Cross-cutting modifications to a single symbol form one node.
   - Dependencies express real prerequisite relationships, not arbitrary visual ordering.

2. **Allowed Information**:
   - Publish factual operational explanations: what the node changes, why it is necessary, what diff was applied, what command verified it, and what constraints were discovered.
   - Do NOT emit internal chain of thought, private reasoning, or raw credentials.

3. **Approval Gate & Identity (Protocol v3)**:
   - Nodes published with `publishGraph` start unapproved (`approved: false`) and require a human click before starting.
   - Discovered nodes (added with `hrp node discover` during an active run) start **approved automatically**: implement them immediately without waiting for a human click.
   - The agent MUST declare its identity (`--agent antigravity` or `{ agent: "antigravity" }`) and respect assignments made by the user.
   - Only ONE node may be in progress (`running`) at a time per execution.

4. **Exclusive Diff & Attribution**:
   - The diff published for a node must be attributable strictly to the declared file/symbol of that node.
   - Do not mix changes from multiple files or unannounced symbols into a single node patch.

5. **Mandatory Verification**:
   - A node can only be completed when it has a non-empty attributable diff and its most recent verification passed with exit code 0.

---

## Workflow Step-by-Step

### 1. Ensure Service & Register Project

Check if the HRP service is running, and attach the current workspace:

- Using MCP tools:
  1. Call `hrp_service_status` (or `hrp_service_start`).
  2. Call `hrp_attach` with `workspaceRoot`.
- Using CLI:
  ```sh
  hrp service status || hrp service start
  project_json=$(hrp attach . --json)
  project_id=$(printf '%s' "$project_json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
  ```

### 2. Create the Execution (Run)

Create a single run for the human requirement:

- Using MCP tools:
  Call `hrp_create_run` with `title` and `requirement`.
- Using CLI:
  ```sh
  run_json=$(hrp run create --project "$project_id" --title "Titulo de la tarea" --requirement "Requerimiento humano original" --json)
  run_id=$(printf '%s' "$run_json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
  ```

### 3. Inspect Code and Publish the Semantic Graph

Before modifying files, inspect the codebase and plan granular operations:

- Using MCP tools:
  Call `hrp_publish_graph` with `runId` and `nodes` array:
  ```json
  [
    {
      "id": "config-schema",
      "file": "src/config.ts",
      "symbol": "ConfigSchema",
      "title": "Añadir esquema de configuración",
      "description": "Definir los nuevos campos requeridos en el esquema Zod.",
      "rationale": "La validación debe conocer los nuevos parámetros antes de instanciarlos.",
      "dependencies": []
    },
    {
      "id": "service-integration",
      "file": "src/service.ts",
      "symbol": "Service.init",
      "title": "Integrar configuración en el servicio",
      "description": "Leer y aplicar la nueva configuración al iniciar el servicio.",
      "rationale": "El servicio requiere los parámetros validados para operar correctamente.",
      "dependencies": ["config-schema"]
    }
  ]
  ```
- Using CLI:
  Save `graph.json` and execute:
  ```sh
  hrp graph publish "$run_id" graph.json --agent antigravity
  ```

Declaring `--agent antigravity` registers you as the run's **base model** when you are the first publisher: unassigned nodes belong to you by default, and any node discovered during execution is auto-assigned to the base model so the run never stalls waiting for an agent that does not know new work exists.

### 4. Wait for Human Approval (initial graph only)

Graph nodes start unapproved. Stay parked on the MCP blocking tool until work is available:

- Using MCP tools (preferred — blocks without ending the turn):
  ```
  hrp_attention({ agent: "antigravity", waitSeconds: 600 })
  ```
  Call it in a loop: it returns as soon as HRP signals work or the timer expires, then call again if no actionable work is ready yet.
- Using CLI fallback:
  ```sh
  hrp attention --agent antigravity --wait 600
  ```
  It exits as soon as HRP has a signal for your identity; on timeout, call it again instead of ending the turn. On older HRP installs that do not have `hrp attention`, use `hrp wait approval "$run_id" --agent antigravity --timeout 300` only for compatibility with the initial approval gate.

**Never end your turn while an active run still has work for you.** Park on `hrp_attention` instead of returning control to the user. Approval is a human control: call `hrp_approve_nodes` (or `hrp node approve "$run_id"`) only when the user explicitly asks to approve nodes, never by inferring permission from general task autonomy.

Verify your installation is up to date before starting work:
```sh
hrp agent install antigravity
```

### 5. Execute Each Node

For each node whose dependencies are completed and is approved:

1. **Start the node**:
   - MCP: `hrp_start_node(runId, nodeId, agent="antigravity")`
   - CLI: `hrp node start "$run_id" nodeId --agent antigravity`
2. **Capture baseline state** of the target file before editing.
3. **Apply the code modification**.
4. **Compute exclusive diff** (e.g. `git diff -- path/to/file` or unified diff format).
5. **Publish patch**:
   - MCP: `hrp_publish_patch(runId, nodeId, summary, diff, rationale)`
   - CLI: `hrp patch publish "$run_id" nodeId --summary "..." --rationale "..." --diff-file diff_path`
6. **Run verification**:
   - MCP: `hrp_verify_run(runId, nodeId, command="npm", args=["test", "path/to/test.ts"])`
   - CLI: `hrp verify run "$run_id" nodeId -- npm test`
7. **Complete node**:
   - MCP: `hrp_complete_node(runId, nodeId)`
   - CLI: `hrp node complete "$run_id" nodeId --tokens N`
   - Report `--tokens` (your real token usage for this node) only if your environment exposes actual usage; omit it otherwise. Never fabricate the number.

### 6. Handling Failures and Retries

If verification fails:
- The node remains in `failed` status.
- Investigate the issue, apply the fix.
- Call `hrp_retry_node(runId, nodeId, agent="antigravity")` (or `hrp node retry "$run_id" nodeId`).
- Publish updated patch and verification.
- Call `hrp_complete_node(runId, nodeId)` once verification passes.
- Do NOT create a new run for a technical failure.

### 7. Discovered Work

If an unforeseen required operation is discovered during execution:
- MCP: `hrp_discover_node(runId, nodeObject)`
- CLI: `hrp node discover "$run_id" discovered-node.json`

Discovered nodes are **approved automatically** (the human already approved the intent of the run). Do NOT wait for a human click — proceed immediately with `start → patch → verify → complete` as soon as the node's dependencies are met. Do not group discovered nodes into a single wait; implement each one as soon as it is ready.


### 8. Secondary Activity

Publish technical inspections or notes when relevant:
- MCP: `hrp_publish_activity(runId, type="inspect", message="...", detail="...", nodeId="...")`
- CLI: `hrp activity publish "$run_id" --type inspect --node nodeId --summary "..." --detail "..."`

### 9. Review Another Agent

When `antigravity` is selected in `run.auditors`, park on `hrp_attention` (or `hrp attention --agent antigravity --wait 600`) until it reports **Auditoría disponible**. Unassigned nodes belong to the base model; never claim or edit them as a reviewer. Publish `hrp agent status` with `phase reviewing` before reading `hrp review pack`, then update `--completed`, `--reviewed`, and `--remaining` as coverage advances.

Audit integration boundaries, broken contracts, approved-spec versus diff deviations, and missing edge cases. Report real problems with `hrp finding add`, debate with `hrp finding reply`, and never edit the workspace. Publish `phase completed` only after every node is covered, then return to parking on `hrp_attention` because a completed correction can request another pass. Do not invent findings or coverage.

### 10. Final Verification

As the base model, check `hrp_get_state` (or `hrp state "$run_id" --json`) to confirm all nodes are `completed`, with attributable diffs and passing verifications. Remain parked on `hrp_attention` until every selected auditor publishes `phase completed`, then require `hrp review gate` to pass without live findings or `pendingAuditors`. Run a comprehensive workspace test suite before handing off.

# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who supervise coding agents and need to understand, redirect, or selectively waive review while work is still happening.

## Product Purpose

Provide a vendor-neutral human view of agent intent, graph progress, workspace changes, verification evidence, and human feedback. Success means a developer can intervene at the right semantic scope without depending on a specific model, skill system, MCP server, or provider API.

## Positioning

Human Review Protocol is a local event protocol and review surface. Agent-specific integrations are thin adapters outside the core. The protocol does not act as another autonomous agent and does not own provider credentials.

## Operating Context

One local protocol host can supervise several workspace folders. Every project has an isolated orchestrator, observer, session and append-only event stream; adapters select a project explicitly or derive it from their working directory. The browser panel can switch folders without restarting the service.

## Capabilities and Constraints

- Keep the canonical contract independent of Codex, Claude, Gemini, or any transport plugin.
- Publish and review a directed plan before implementation nodes execute.
- Decompose each plan phase into semantic changes and per-file/symbol operations that explain what changes and why.
- Require real per-file diff evidence and mapped passing verification before completing granular work.
- Support `required`, `watch`, and `auto` review policies per node or subtree.
- Bind every review waiver to a plan version and node fingerprint; invalidate it when scope changes.
- Record targeted, optionally blocking human observations as commands for the connected adapter.
- Observe Git workspace changes independently when the workspace is a worktree.
- Persist immutable, causal events locally and reconstruct state after restart.
- Register multiple project folders in one local SQLite database and keep their event streams isolated.
- First release is local and single-user, with at most one active execution node per project session.

## Evidence on Hand

The initial specification is `/Users/rrrssa/Downloads/especificacion-poc-arnes-guiado-codex.md`. It established the human-in-the-loop workflow; the current implementation generalizes it into a neutral protocol.

## Product Principles

1. Show intent before action.
2. Separate agent claims from workspace observations.
3. Make selective review explicit, scoped, and revocable.
4. Treat human feedback as structured protocol data.
5. Prefer portable contracts to vendor behavior.
6. Keep every change attributable and replayable.

## Accessibility & Inclusion

The panel is keyboard operable, preserves visible focus, avoids color-only state communication, and remains usable on narrower laptop screens.

# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated: React and TypeScript for the browser surface, Node.js and Express for the local host, SQLite for persistence, and a provider-neutral HTTP/SSE protocol with a thin CLI.

## Users

Developers supervising coding agents while they modify a local repository. They need to understand the global implementation path without reading agent logs or reconstructing intent from a final diff.

## Product Purpose

Human Review Protocol v3 presents an observable map of planned and completed code changes. Success means a developer can see every affected file and symbol, understand why each change exists and what it depends on, then select a completed node and inspect the exact diff and verification evidence.

## Positioning

HRP models execution as a provider-neutral graph of semantic code operations rather than exposing private model reasoning, raw tool logs, or provider-specific task formats.

## Operating Context

One local service can register multiple workspace folders. An agent adapter publishes a run, its best-known graph, newly discovered operations, patches and verification results. The graph evolves during execution while preserving the distinction between planned and discovered work.

## Capabilities and Constraints

- A graph node represents `file + symbol or logical section + intent`.
- Multiple symbols in one file are separate nodes.
- Dependencies form directed branches between semantic operations.
- Nodes use only `pending`, `running`, `completed` and `failed`.
- A completed node requires real diff evidence and a passing verification.
- Work discovered during execution joins the same graph and is labeled as discovered.
- A secondary activity view contains investigation, commands and chronological evidence.
- All execution is automatic in this stage; human review gates and review policies are explicitly out of scope.
- Internal chain-of-thought is never requested or stored. Visible rationale must be a concise operational explanation.
- The core protocol cannot depend on Codex, Claude, Gemini, skills or MCP.
- First release is local and single-user.

## Evidence on Hand

The prior implementation is frozen under `deprecated/v1`. It is historical evidence only and must not be imported into the v2 architecture.

## Product Principles

1. Map change intent before implementation detail.
2. Prefer semantic operations over files, phases or tool calls.
3. Keep planned intent and applied evidence visibly distinct.
4. Let the graph grow honestly when new work is discovered.
5. Make every completed state provable from diff and verification evidence.

## Accessibility & Inclusion

The graph and inspector must be keyboard operable, expose written status labels in addition to color, maintain visible focus and remain usable on laptop and mobile widths.

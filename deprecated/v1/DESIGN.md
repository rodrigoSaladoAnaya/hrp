---
name: Human Review Cue Desk
description: A vendor-neutral live cue sheet for intent, evidence, and selective human review.
colors:
  ink: "#14233b"
  paper: "#f4f7f5"
  paper-deep: "#e7ece9"
  paper-bright: "#fbfcfb"
  signal: "#b23722"
  signal-deep: "#842717"
  go: "#19745c"
  hold: "#a75d00"
  fail: "#a8323a"
  quiet: "#637083"
  rule: "#cad2cf"
  focus: "#1a8fa3"
  code-surface: "#101a2b"
  code-raised: "#17243a"
  review-required-bg: "#fbe8e3"
  review-watch-bg: "#faebd4"
  review-auto-bg: "#dff0ea"
typography:
  display:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "clamp(1.55rem, 2.2vw, 2.35rem)"
    fontWeight: 700
    lineHeight: 0.98
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "1.16rem"
    fontWeight: 700
    lineHeight: 1.05
  title:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "0.96rem"
    fontWeight: 700
    lineHeight: 1.12
  body:
    fontFamily: "Aptos, Segoe UI, Helvetica Neue, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Aptos, Segoe UI, Helvetica Neue, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "0.07em"
rounded:
  micro: "3px"
  panel: "4px"
  control: "6px"
  pill: "999px"
spacing:
  micro: "4px"
  cue: "8px"
  measure: "12px"
  beat: "16px"
  lane: "20px"
  scene: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper-bright}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "42px"
  button-approval:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.paper-bright}"
    rounded: "{rounded.control}"
    padding: "9px 13px"
    height: "44px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 13px"
    height: "44px"
  review-required:
    backgroundColor: "{colors.review-required-bg}"
    textColor: "{colors.signal-deep}"
    rounded: "{rounded.control}"
    padding: "8px"
    height: "58px"
  review-watch:
    backgroundColor: "{colors.review-watch-bg}"
    textColor: "{colors.hold}"
    rounded: "{rounded.control}"
    padding: "8px"
    height: "58px"
  review-auto:
    backgroundColor: "{colors.review-auto-bg}"
    textColor: "{colors.go}"
    rounded: "{rounded.control}"
    padding: "8px"
    height: "58px"
---

# Design System: Human Review Cue Desk

## Overview

**Creative North Star: "The Technical Director's Cue Sheet"**

The product behaves like a working cue desk beside a developer's workspace: intent is sequenced, evidence is attributable, and selective review stays legible without borrowing the identity or interaction model of any agent vendor. Cool production paper, navy rules, and one live vermilion cue create an operational surface rather than an analytics dashboard.

The interface is dense but not compressed. Continuous lanes, ruled relationships, explicit labels, and compact production typography let developers scan the graph, change review policy, inspect evidence, and send targeted observations without losing causal context.

**Key Characteristics:**

- Three continuous work lanes instead of a grid of interchangeable cards.
- One saturated signal reserved for a pending human decision.
- Review policy is always written as `REVISAR`, `OBSERVAR`, or `AUTO`; color is reinforcement only.
- Evidence uses a dark code reel while intent and control remain on cool paper.
- Motion announces a current state change and respects reduced-motion preferences.

## Colors

The palette pairs cool production neutrals with semantic control colors. Production Ink carries structure and primary controls; Cool Cue Paper and its deeper and brighter layers separate working regions. Go Green marks running, completed, or successful evidence; Hold Amber marks watched or unavailable states; Failure Red is reserved for errors. Cyan Focus is an accessibility affordance, not a decorative accent.

### Primary

- **Decision Vermilion:** The saturated signal used for the approval cue and its current action.
- **Deep Decision Vermilion:** Hover and high-contrast text within the required-review family.

### Secondary

- **Go Green:** Progress, completion, successful verification, and live graph motion.
- **Hold Amber:** Watched review policy and non-failing unavailable states.
- **Failure Red:** Failed nodes, verification failures, and error ribbons.

### Neutral

- **Production Ink:** Text, rules, the control rail, and the default primary button.
- **Cool Cue Paper:** The persistent working canvas.
- **Deep Cue Paper:** Tonal grouping for the graph canvas and policy controls.
- **Bright Cue Paper:** Interactive surfaces and node interiors.
- **Quiet Slate:** Secondary copy, metadata, and inactive status.
- **Rule Gray:** One-pixel internal dividers.
- **Code Navy / Raised Code Navy:** The evidence reel and its tabs, captions, and verification shelves.

### Named Rules

**The Signal Rule.** Saturated Decision Vermilion belongs only to a human action that is currently pending; never use it as decoration or as a generic brand color.

**The Words-First Rule.** Every state remains understandable through text. Color can accelerate recognition, but cannot carry protocol meaning alone.

## Typography

**Display Font:** Barlow Condensed (self-hosted weights 600, 700, and 800; with Arial Narrow and sans-serif fallbacks)  
**Body Font:** Aptos (with Segoe UI, Helvetica Neue, and sans-serif fallbacks)  
**Label/Mono Font:** SFMono-Regular (with Consolas, Liberation Mono, and monospace fallbacks)

**Character:** Narrow, assertive headings feel like cue labels on production equipment; the body stack stays familiar for prolonged operational reading. Monospace is a semantic instrument for diffs, commands, identifiers, and timestamps.

### Hierarchy

- **Display** (700, responsive `clamp(1.55rem, 2.2vw, 2.35rem)`, 0.98 line-height): Selected-node titles and the strongest contextual hierarchy.
- **Headline** (700, `1.16rem`, 1.05 line-height): Sticky lane headings.
- **Title** (700, `0.96rem`, 1.12 line-height): Plan-node titles and compact production headings.
- **Body** (400, `0.9375rem`, 1.5 line-height): Objectives and explanatory copy, generally constrained to 64–70 characters.
- **Label** (700–850, `0.75rem`, up to `0.1em` tracking): Review badges, status labels, timestamps, evidence metadata, and control captions.

### Named Rules

**The Operational Floor Rule.** No operational label, timestamp, state, or code line may render below `0.75rem`; narrow layouts reflow instead of shrinking type.

**The Semantic Mono Rule.** Use monospace only where fixed-width structure helps compare or attribute evidence.

## Layout

The desktop workspace fills the viewport beneath a control rail with a minimum height of `74px`. The main grid is intention / selected-node control / evidence at `29fr / 40fr / 31fr`, with minimum lane widths of `290px / 420px / 330px`. Lane headings are sticky, and the current approval cue is pinned directly below the middle heading so a required decision remains available while contextual content scrolls.

At `1050px`, the first two lanes become `42fr / 58fr` and the evidence reel spans the next row. At `720px`, all lanes become one ordered column; when action is pending, the context lane moves first. The control rail reduces to the product identity and hold control, then places live status on its own row. Evidence, policy, and decision subgrids collapse to a single column without reducing the type floor.

Spacing follows an `4 / 8 / 12 / 16 / 20 / 24px` operational rhythm. One-pixel rules establish alignment across lanes; internal blocks use measured padding rather than detached card gutters.

## Elevation & Depth

The system is flat by default. Depth comes primarily from tonal paper layers, hard dividers, sticky overlap, and the dark evidence field. Shadows are structural responses: graph nodes are lightly lifted, hover moves them by `2px`, the active node receives a green-tinted lift, and the pending approval cue receives the strongest offset shadow. No ambient glow is used.

### Shadow Vocabulary

- **Node Rest** (`3px 5px 12px rgba(20,35,59,.13)`): Gives graph nodes enough separation from the graph canvas.
- **Node Hover** (`4px 7px 12px rgba(20,35,59,.14)`): Pairs with a `-2px` vertical lift.
- **Node Active** (`5px 7px 18px rgba(25,116,92,.23)`): Marks the currently executing node, not the human decision.
- **Approval Cue** (`4px 9px 20px rgba(20,35,59,.16)`): Holds the pending human decision above scrolling context.

### Named Rules

**The Flat-by-Default Rule.** Surfaces stay flat until selection, hover, execution, or pending review creates a real hierarchy change.

## Shapes

The form language is ruled and compact. Work lanes and large content regions remain square; cue nodes and inline subjects use gently clipped `4px` corners; controls use `5–6px` corners. Pills (`999px`) are reserved for short categorical state such as review mode, node status, and counts. Circular geometry is limited to connection lights and graph handles.

**The Category-Only Pill Rule.** A pill must encode a short category or status; never place paragraphs, primary actions, or arbitrary metadata inside one.

## Components

### Buttons

- **Shape:** Compact controls with `6px` corners, `42–44px` minimum height, and dense `8–14px` internal padding.
- **Primary:** Production Ink on Bright Cue Paper text for durable actions such as sending an observation.
- **Approval:** Decision Vermilion with a deeper vermilion hover, used only inside the current approval cue.
- **Secondary:** Transparent with a Production Ink border for rejection and neutral alternatives.
- **Hover / Focus:** Hover changes surface tone without changing meaning. Every button receives a `3px` Cyan Focus outline with a `2px` offset on keyboard focus.

### Chips

- **Style:** `REVISAR`, `OBSERVAR`, and `AUTO` use text, border, pale semantic tint, and explicit uppercase labels. Node state stamps and change counts use the same pill silhouette with their own text.
- **State:** Selected review-policy controls add an ink border and compact structural shadow; the semantic tint remains subordinate to the written label.

### Cards / Containers

- **Corner Style:** Continuous lanes stay square; cue nodes and approval subjects use `4px` corners.
- **Background:** Paper layers separate graph, control, and interactive regions; the evidence lane switches to Code Navy.
- **Shadow Strategy:** Only graph-node interaction and the pending approval cue receive elevation.
- **Border:** One-pixel Production Ink rules separate lanes and primary sections; Rule Gray divides subordinate rows.
- **Internal Padding:** Usually `12–20px`, following the shared rhythm.

### Inputs / Fields

- **Style:** Bright Cue Paper, a Quiet Slate or Rule Gray stroke, `5–6px` corners, and body copy no smaller than `0.75rem`.
- **Focus:** The shared `3px` Cyan Focus outline with a `2px` offset; textarea caret uses Decision Vermilion.
- **Error / Disabled:** Errors are described in an alert ribbon; disabled controls lower opacity but retain their label.

### Navigation

The control rail is a persistent dark operational header, not product navigation. It keeps the neutral protocol identity, live status, pending command count, connection state, and pause/resume control visible. On mobile, secondary telemetry hides while live status wraps to a full-width row.

### Cue Node

The graph has two projections. **Changes** is the default and gives each semantic change a cue combining phase/change number, phase name, written review badge, operation/file count, written status, and dependency label. **Plan** preserves the coarser phase/gate view. Selection uses an outline; execution uses Go Green and a green-tinted shadow; superseded nodes become quieter. The node never implies that the protocol itself is an agent.

### Approval Cue

The sticky central cue is the only saturated Decision Vermilion surface. It names the decision, identifies the affected node or replan impact, and pairs the approval action with a neutral rejection action. Its visibility is the primary human-in-the-loop guarantee.

### Evidence Reel

The dark reel unifies agent-reported patches and independently observed workspace snapshots in one causal sequence. Patch tabs identify semantic scope; a second strip selects the exact file operation. The reel states what changed and why before showing the real per-file diff. Fixed-width code preserves whitespace, and added/removed lines use both sign gutters and color. Only explicitly mapped verification evidence attaches below its associated patch; missing coverage is written as an unavailable state.

## Do's and Don'ts

### Do:

- **Do** preserve the vendor-neutral protocol identity in every label, empty state, and control.
- **Do** keep the pending decision visible while any lane scrolls.
- **Do** connect every verification, patch, workspace snapshot, and observation to its node and timestamp.
- **Do** write review modes exactly as `REVISAR`, `OBSERVAR`, and `AUTO` and pair every state color with text.
- **Do** maintain the `0.75rem` operational type floor and the `1050px` / `720px` responsive transitions.
- **Do** expose empty, loading, offline, failed, paused, and superseded states in words.

### Don't:

- **Don't** present the protocol as an autonomous agent, provider dashboard, or owner of credentials.
- **Don't** use saturated Decision Vermilion unless a human action is currently pending.
- **Don't** turn every fact into a separate rounded card or float unrelated panels above the lane grid.
- **Don't** use color as the only state indicator or rely on motion to convey meaning.
- **Don't** animate completed history; motion belongs to the current transition.
- **Don't** shrink metadata, code, or controls below the operational type floor on narrow screens.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readWebFile(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

function declarationFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = readWebFile("styles.css").match(new RegExp(`${escaped} \\{([^}]+)\\}`));
  if (!match) throw new Error(`Missing CSS selector: ${selector}`);
  return match[1];
}

function reducedMotionBlock(): string {
  const match = readWebFile("styles.css").match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]+?)\n\}/);
  if (!match) throw new Error("Missing reduced-motion media query");
  return match[1];
}

describe("graph status style contracts", () => {
  it("keeps graph status classes and completed crumbs wired from App to CSS", () => {
    const app = readWebFile("App.tsx");

    expect(app).toContain("change-node-${change.status}");
    expect(app).toContain("node-completion-crumb");
    expect(app).toContain("route-edge-from-${sourceStatus");
    expect(app).toContain("route-edge-completed-path");
    expect(declarationFor(".node-completion-crumb")).toContain("display: flex");
    expect(readWebFile("styles.css")).toContain(".react-flow__edge.route-edge-completed-path .react-flow__edge-path");
  });

  it("uses the normalized magnifier helper instead of the old fixed scale", () => {
    const app = readWebFile("App.tsx");

    expect(app).toContain("magnifierContentTransform({");
    expect(app).toContain("transform: graphMagnifierTransform.transform");
    expect(app).not.toContain("scale(${graphMagnifierScale})");
  });

  it("animates the running node and disables that pulse for reduced motion", () => {
    expect(declarationFor(".change-node-running")).toContain("animation: node-running-pulse");
    expect(readWebFile("styles.css")).toContain("@keyframes node-running-pulse");
    expect(reducedMotionBlock()).toContain(".change-node-running");
    expect(reducedMotionBlock()).toContain("animation: none");
  });

  it("does not let completed-route crumbs override running or failed edges", () => {
    const css = readWebFile("styles.css");
    const crumbRule = ".route-edge-from-completed:not(.route-edge-completed-path):not(.route-edge-running):not(.route-edge-failed)";

    expect(css).toContain(crumbRule);
    expect(declarationFor(".react-flow__edge.route-edge-running .react-flow__edge-path")).toContain("stroke: var(--running)");
    expect(declarationFor(".react-flow__edge.route-edge-failed .react-flow__edge-path")).toContain("stroke: var(--failed)");
  });

  it("keeps shortcut settings controls wired to CSS", () => {
    const app = readWebFile("App.tsx");

    expect(app).toContain("shortcut-settings");
    expect(app).toContain("shortcut-options");
    const shortcutOptionsTag = app.match(/<div[^>]*className="shortcut-options"[^>]*>/)?.[0] ?? "";
    expect(shortcutOptionsTag).toContain("role=\"group\"");
    expect(shortcutOptionsTag).toContain("aria-label=\"Modificador de atajos de vistas\"");
    expect(app).toContain("aria-pressed={uiPreferences.viewShortcuts.modifier === modifier}");
    expect(app).not.toContain("role=\"radiogroup\"");
    expect(app).not.toContain("role=\"radio\"");
    expect(declarationFor(".settings-section")).toContain("border-top");
    expect(declarationFor(".settings-check")).toContain("grid-template-columns");
    expect(declarationFor(".shortcut-options")).toContain("grid-template-columns");
    expect(declarationFor(".shortcut-options button.active")).toContain("background: #35443f");
  });

  it("guards view shortcuts when there is no visible run detail", () => {
    const app = readWebFile("App.tsx");

    expect(app).toContain("isViewShortcutEvent, resolveViewShortcut");
    expect(app).toContain("const shortcutsAvailable = Boolean(runId && detail);");
    expect(app).toContain("isViewShortcutEvent({ event, preferences: uiPreferences })");
    expect(app).toMatch(/isViewShortcut\s*\?\s*resolveViewShortcut/);
    expect(app).toMatch(/if \(isViewShortcut\) \{\s*event\.preventDefault\(\);\s*return;\s*\}\s*if \(event\.metaKey \|\| event\.ctrlKey\) showGraphMagnifier/);
    expect(app).toContain("[detail, hideGraphMagnifier, refreshGraphPointer, runId");
  });
});

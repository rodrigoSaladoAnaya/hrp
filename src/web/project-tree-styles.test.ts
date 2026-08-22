import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function declarationFor(selector: string): string {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped} \\{([^}]+)\\}`));
  if (!match) throw new Error(`Missing CSS selector: ${selector}`);
  return match[1];
}

describe("project tree styles", () => {
  it("keeps .tree-show-more width consistent with its horizontal margins", () => {
    const declaration = declarationFor(".tree-show-more");
    const width = declaration.match(/width:\s*calc\(100% - (\d+)px\)/)?.[1];
    const margin = declaration.match(/margin:\s*\d+px\s+(\d+)px\s+\d+px\s+(\d+)px/)?.slice(1);

    expect(width).toBeDefined();
    expect(margin).toHaveLength(2);
    expect(margin?.map(Number).reduce((sum, value) => sum + value, 0)).toBe(Number(width));
  });

  it("defines a quieter expanded state for the persistent toggle", () => {
    const base = declarationFor(".tree-show-more");
    const expanded = declarationFor(".tree-show-more.is-expanded");

    expect(expanded).toContain("justify-content: flex-start");
    expect(expanded.match(/color:\s*([^;]+)/)?.[1]).not.toBe(base.match(/color:\s*([^;]+)/)?.[1]);
  });
});

import { describe, expect, it } from "vitest";
import { isViewShortcutEvent, resolveEvolutionFrameShortcut, resolveViewShortcut } from "./view-shortcuts.js";

describe("resolveViewShortcut", () => {
  it("moves through graph views with the default meta shortcut", () => {
    expect(resolveViewShortcut({ currentView: "map", event: { key: "ArrowRight", metaKey: true } })).toBe("activity");
    expect(resolveViewShortcut({ currentView: "activity", event: { key: "ArrowRight", metaKey: true } })).toBe("findings");
    expect(resolveViewShortcut({ currentView: "findings", event: { key: "ArrowRight", metaKey: true } })).toBe("evolution");
    expect(resolveViewShortcut({ currentView: "evolution", event: { key: "ArrowRight", metaKey: true } })).toBe("issue");
    expect(resolveViewShortcut({ currentView: "issue", event: { key: "ArrowRight", metaKey: true } })).toBe("map");
    expect(resolveViewShortcut({ currentView: "map", event: { key: "ArrowLeft", metaKey: true } })).toBe("issue");
    expect(resolveViewShortcut({ currentView: "issue", event: { key: "ArrowLeft", metaKey: true } })).toBe("evolution");
    expect(resolveViewShortcut({ currentView: "evolution", event: { key: "ArrowLeft", metaKey: true } })).toBe("findings");
  });

  it("honors ctrl and either modifier preferences", () => {
    expect(resolveViewShortcut({
      currentView: "map",
      event: { key: "ArrowRight", ctrlKey: true },
      preferences: { viewShortcuts: { enabled: true, modifier: "ctrl" } },
    })).toBe("activity");
    expect(resolveViewShortcut({
      currentView: "map",
      event: { key: "ArrowRight", ctrlKey: true },
      preferences: { viewShortcuts: { enabled: true, modifier: "meta" } },
    })).toBeNull();
    expect(resolveViewShortcut({
      currentView: "map",
      event: { key: "ArrowRight", ctrlKey: true },
      preferences: { viewShortcuts: { enabled: true, modifier: "either" } },
    })).toBe("activity");
  });

  it("does not capture editable targets", () => {
    expect(resolveViewShortcut({
      currentView: "map",
      event: { key: "ArrowRight", metaKey: true, target: { tagName: "input" } },
    })).toBeNull();
    expect(resolveViewShortcut({
      currentView: "map",
      event: { key: "ArrowRight", metaKey: true, target: { isContentEditable: true } },
    })).toBeNull();
    expect(resolveViewShortcut({
      currentView: "map",
      event: { key: "ArrowRight", metaKey: true, target: { closest: () => ({}) } },
    })).toBeNull();
  });

  it("leaves disabled, extra-modifier, and non-arrow events alone", () => {
    expect(resolveViewShortcut({
      currentView: "map",
      event: { key: "ArrowRight", metaKey: true },
      preferences: { viewShortcuts: { enabled: false, modifier: "meta" } },
    })).toBeNull();
    expect(resolveViewShortcut({ currentView: "map", event: { key: "ArrowRight", metaKey: true, shiftKey: true } })).toBeNull();
    expect(resolveViewShortcut({ currentView: "map", event: { key: "ArrowDown", metaKey: true } })).toBeNull();
  });

  it("ignores repeated keydown events", () => {
    expect(resolveViewShortcut({
      currentView: "map",
      event: { key: "ArrowRight", metaKey: true, repeat: true },
    })).toBeNull();
  });

  it("identifies view shortcut events before repeat resolution", () => {
    expect(isViewShortcutEvent({
      event: { key: "ArrowRight", metaKey: true, repeat: true },
    })).toBe(true);
    expect(isViewShortcutEvent({
      event: { key: "ArrowDown", metaKey: true },
    })).toBe(false);
    expect(isViewShortcutEvent({
      event: { key: "ArrowRight", metaKey: true, target: { tagName: "input" } },
    })).toBe(false);
    expect(isViewShortcutEvent({
      event: { key: "ArrowRight", metaKey: true },
      preferences: { viewShortcuts: { enabled: false, modifier: "meta" } },
    })).toBe(false);
  });
});

describe("resolveEvolutionFrameShortcut", () => {
  const base = { view: "evolution" as const, length: 5 };

  it("mueve el cuadro con flechas sin modificador y salta con Home/End", () => {
    expect(resolveEvolutionFrameShortcut({ ...base, index: 1, event: { key: "ArrowRight" } })).toBe(2);
    expect(resolveEvolutionFrameShortcut({ ...base, index: 1, event: { key: "ArrowLeft" } })).toBe(0);
    expect(resolveEvolutionFrameShortcut({ ...base, index: 3, event: { key: "Home" } })).toBe(0);
    expect(resolveEvolutionFrameShortcut({ ...base, index: 0, event: { key: "End" } })).toBe(4);
  });

  it("se queda en los extremos y no reporta cambio", () => {
    expect(resolveEvolutionFrameShortcut({ ...base, index: 4, event: { key: "ArrowRight" } })).toBeNull();
    expect(resolveEvolutionFrameShortcut({ ...base, index: 0, event: { key: "ArrowLeft" } })).toBeNull();
    expect(resolveEvolutionFrameShortcut({ ...base, index: 0, event: { key: "Home" } })).toBeNull();
    expect(resolveEvolutionFrameShortcut({ ...base, index: -1, event: { key: "ArrowLeft" } })).toBe(0);
  });

  it("ignora otras vistas, modificadores, campos editables y runs sin cuadros", () => {
    expect(resolveEvolutionFrameShortcut({ ...base, view: "map", index: 1, event: { key: "ArrowRight" } })).toBeNull();
    expect(resolveEvolutionFrameShortcut({ ...base, index: 1, event: { key: "ArrowRight", metaKey: true } })).toBeNull();
    expect(resolveEvolutionFrameShortcut({ ...base, index: 1, event: { key: "ArrowRight", shiftKey: true } })).toBeNull();
    expect(resolveEvolutionFrameShortcut({ ...base, index: 1, event: { key: "ArrowRight", target: { tagName: "textarea" } } })).toBeNull();
    expect(resolveEvolutionFrameShortcut({ ...base, length: 0, index: 0, event: { key: "ArrowRight" } })).toBeNull();
    expect(resolveEvolutionFrameShortcut({ ...base, index: 1, event: { key: "a" } })).toBeNull();
  });
});

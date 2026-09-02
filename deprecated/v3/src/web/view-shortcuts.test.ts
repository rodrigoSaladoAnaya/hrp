import { describe, expect, it } from "vitest";
import { isViewShortcutEvent, resolveViewShortcut } from "./view-shortcuts.js";

describe("resolveViewShortcut", () => {
  it("moves through graph views with the default meta shortcut", () => {
    expect(resolveViewShortcut({ currentView: "map", event: { key: "ArrowRight", metaKey: true } })).toBe("activity");
    expect(resolveViewShortcut({ currentView: "activity", event: { key: "ArrowRight", metaKey: true } })).toBe("findings");
    expect(resolveViewShortcut({ currentView: "findings", event: { key: "ArrowRight", metaKey: true } })).toBe("map");
    expect(resolveViewShortcut({ currentView: "map", event: { key: "ArrowLeft", metaKey: true } })).toBe("findings");
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

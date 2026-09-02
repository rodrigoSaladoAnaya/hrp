import type { UiPreferences } from "../shared/protocol.js";
import { DEFAULT_UI_PREFERENCES } from "../shared/protocol.js";
import type { GraphView } from "./graph-viewport.js";

export type ViewShortcutEvent = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  target?: unknown;
};

type EditableLikeTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
};

const viewOrder: GraphView[] = ["issue", "map", "activity", "findings"];
const editableTags = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as EditableLikeTarget;
  const tagName = element.tagName?.toUpperCase();
  return Boolean(
    (tagName && editableTags.has(tagName))
    || element.isContentEditable
    || element.getAttribute?.("contenteditable") === "true"
    || element.closest?.("[contenteditable=\"true\"]"),
  );
}

function modifierMatches(event: ViewShortcutEvent, preferences: UiPreferences): boolean {
  const modifier = preferences.viewShortcuts.modifier;
  if (modifier === "meta") return event.metaKey === true && event.ctrlKey !== true;
  if (modifier === "ctrl") return event.ctrlKey === true && event.metaKey !== true;
  return event.metaKey === true || event.ctrlKey === true;
}

export function isViewShortcutEvent({
  event,
  preferences = DEFAULT_UI_PREFERENCES,
}: {
  event: ViewShortcutEvent;
  preferences?: UiPreferences;
}): boolean {
  if (!preferences.viewShortcuts.enabled) return false;
  if (event.altKey || event.shiftKey) return false;
  if (!modifierMatches(event, preferences)) return false;
  if (isEditableTarget(event.target)) return false;
  return event.key === "ArrowRight" || event.key === "ArrowLeft";
}

export function resolveViewShortcut({
  currentView,
  event,
  preferences = DEFAULT_UI_PREFERENCES,
}: {
  currentView: GraphView;
  event: ViewShortcutEvent;
  preferences?: UiPreferences;
}): GraphView | null {
  if (!isViewShortcutEvent({ event, preferences })) return null;
  if (event.repeat) return null;

  const currentIndex = viewOrder.indexOf(currentView);
  if (currentIndex === -1) return null;
  if (event.key === "ArrowRight") return viewOrder[(currentIndex + 1) % viewOrder.length];
  if (event.key === "ArrowLeft") return viewOrder[(currentIndex - 1 + viewOrder.length) % viewOrder.length];
  return null;
}

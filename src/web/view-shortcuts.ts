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

const viewOrder: GraphView[] = ["issue", "map", "activity", "findings", "evolution"];
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

// Flechas sin modificador en la vista Evolución: mueven el cuadro de la línea
// de tiempo. Devuelve el índice nuevo, o null cuando no aplica o no cambia.
export function resolveEvolutionFrameShortcut({
  event,
  index,
  length,
  view,
}: {
  event: ViewShortcutEvent;
  index: number;
  length: number;
  view: GraphView;
}): number | null {
  if (view !== "evolution" || length <= 0) return null;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (isEditableTarget(event.target)) return null;
  const last = length - 1;
  const current = Math.min(Math.max(index, 0), last);
  const next = event.key === "ArrowRight" ? Math.min(current + 1, last)
    : event.key === "ArrowLeft" ? Math.max(current - 1, 0)
      : event.key === "Home" ? 0
        : event.key === "End" ? last
          : null;
  return next === null || next === index ? null : next;
}

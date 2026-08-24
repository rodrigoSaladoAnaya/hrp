import type { OllamaSettingsView } from "../shared/protocol.js";

type LaneSettings = Pick<OllamaSettingsView, "model" | "tiers">;

// Modelos distintos configurados, en orden estable: primero el de por defecto y
// después los niveles que declaren otro.
function distinctModels(ollama?: LaneSettings): string[] {
  const models = [ollama?.model, ...Object.values(ollama?.tiers ?? {})]
    .map((model) => model?.trim())
    .filter((model): model is string => Boolean(model));
  return [...new Set(models)];
}

// Un carril existe para poder correr dos nodos delegados a la vez, y eso sólo
// pasa si los ataca un modelo distinto. Con un único modelo configurado el
// carril sería el propio nodo base: mostrarlo colgando de él duplicaba la fila
// en el árbol —mismo nombre y misma etiqueta— sin añadir nada que asignar.
export function delegateLanes(ollama?: LaneSettings): string[] {
  const models = distinctModels(ollama);
  return models.length > 1 ? models.map((model) => `ollama:${model}`) : [];
}

// Etiqueta de la raíz delegada. Con un solo modelo dice cuál es; con varios el
// modelo lo decide la dificultad de cada nodo, así que nombrar uno mentiría.
export function delegateSubtitle(ollama?: LaneSettings & { configured?: boolean }): string | undefined {
  if (ollama?.configured === false) return undefined;
  const models = distinctModels(ollama);
  if (!models.length) return undefined;
  return models.length === 1 ? models[0] : "por dificultad";
}

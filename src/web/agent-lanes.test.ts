import { describe, expect, it } from "vitest";
import { delegateLanes, delegateSubtitle } from "./agent-lanes";

describe("agent-lanes", () => {
  it("hangs no lane when a single model is configured", () => {
    // El carril de ese único modelo sería el propio nodo base: colgarlo
    // duplicaba la fila del árbol con el mismo nombre y la misma etiqueta.
    expect(delegateLanes({ model: "glm-5.2", tiers: {} })).toEqual([]);
  });

  it("hangs no lane when every tier repeats the default model", () => {
    expect(delegateLanes({ model: "glm-5.2", tiers: { trivial: "glm-5.2", standard: " glm-5.2 " } })).toEqual([]);
  });

  it("hangs one lane per distinct model, in a stable order", () => {
    const settings = { model: "glm-5.2", tiers: { trivial: "qwen-3", standard: "glm-5.2" } };
    expect(delegateLanes(settings)).toEqual(["ollama:glm-5.2", "ollama:qwen-3"]);
    expect(delegateLanes(settings)).toEqual(delegateLanes(settings));
  });

  it("returns nothing when there is no configuration at all", () => {
    expect(delegateLanes(undefined)).toEqual([]);
    expect(delegateLanes({ model: "", tiers: {} })).toEqual([]);
    expect(delegateSubtitle(undefined)).toBeUndefined();
    expect(delegateSubtitle({ model: "", tiers: {} })).toBeUndefined();
  });

  it("names the model in the root subtitle while there is only one", () => {
    expect(delegateSubtitle({ model: "glm-5.2", tiers: {} })).toBe("glm-5.2");
  });

  it("says the model depends on difficulty once there is more than one", () => {
    // Con varios modelos, nombrar uno en la raíz mentiría: el modelo lo elige
    // la dificultad de cada nodo.
    expect(delegateSubtitle({ model: "glm-5.2", tiers: { trivial: "qwen-3" } })).toBe("por dificultad");
  });

  it("says nothing when the delegate is not configured", () => {
    expect(delegateSubtitle({ model: "glm-5.2", tiers: {}, configured: false })).toBeUndefined();
  });
});

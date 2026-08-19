# Revisión granular: cambio → archivo → evidencia

Desde el protocolo `1.1`, un nodo del plan representa una fase y un gate humano. Dentro de la fase, `changes` representa las decisiones semánticas que el panel dibuja como nodos finos. Cada cambio declara sus operaciones por archivo o símbolo.

## Plan

```json
{
  "title": "Persistencia multi-proyecto",
  "summary": "Aislar eventos y probar la frontera entre carpetas",
  "nodes": [
    {
      "id": "storage",
      "title": "Persistencia y aislamiento",
      "objective": "Guardar eventos de varios proyectos sin mezclarlos",
      "dependencies": [],
      "affectedFiles": [
        "apps/server/src/event-store.ts",
        "apps/server/src/orchestrator.test.ts"
      ],
      "rationale": "La persistencia debe existir antes de exponer selección de proyectos.",
      "verificationCriteria": ["Dos proyectos reconstruyen estados independientes"],
      "changes": [
        {
          "id": "project-scoping",
          "title": "Aislar eventos por proyecto",
          "intent": "Conservar el proyecto propietario en cada escritura y lectura",
          "rationale": "Una base compartida necesita una frontera explícita.",
          "dependencies": [],
          "operations": [
            {
              "id": "scope-event-writes",
              "file": "apps/server/src/event-store.ts",
              "symbol": "append",
              "kind": "modify",
              "summary": "Persistir project_id al insertar eventos",
              "rationale": "Permite atribuir cada evento a una sola carpeta."
            }
          ]
        },
        {
          "id": "isolation-proof",
          "title": "Probar aislamiento entre carpetas",
          "intent": "Ejecutar dos proyectos contra la misma base",
          "rationale": "La frontera necesita evidencia ejecutable.",
          "dependencies": ["project-scoping"],
          "operations": [
            {
              "id": "test-project-isolation",
              "file": "apps/server/src/orchestrator.test.ts",
              "kind": "modify",
              "summary": "Añadir una prueba con dos project_id",
              "rationale": "Evita regresiones de mezcla de eventos."
            }
          ]
        }
      ]
    }
  ]
}
```

Los ids de cambio y operación son únicos en todo el plan. Las operaciones sólo pueden usar archivos incluidos en `affectedFiles`. Las dependencias de cambios también forman un DAG.

## Patch real

```bash
hrp patch publish storage \
  --change project-scoping \
  --summary "Aísla escrituras y lecturas por project_id" \
  --files apps/server/src/event-store.ts
```

El CLI obtiene el diff Git y el servidor lo separa por archivo. El evento conserva `patchId`, `changeId`, ids de operación, símbolo, resumen, motivo, diff y conteos de líneas. Con varios cambios declarados, `--change` es obligatorio; si sólo existe uno, el CLI lo infiere.

## Verificación mapeada

```bash
hrp verify run storage --command-id isolation-test -- npm test
```

Sin flags de cobertura, el CLI mapea la verificación a todos los cambios, operaciones y patches actuales del nodo. Para una prueba estrecha:

```bash
hrp verify run storage \
  --command-id storage-unit \
  --changes project-scoping \
  --operations scope-event-writes \
  --patches PATCH_ID \
  -- npm test -- event-store
```

Un plan granular no puede ejecutar `node complete` hasta que:

1. cada cambio tenga un patch;
2. cada operación esté ligada a un diff real por archivo;
3. una verificación exitosa cubra el cambio completo o todas sus operaciones.

## Panel

- **Cambios** es la proyección predeterminada del grafo y muestra un nodo por decisión semántica.
- **Plan** conserva la vista de fases y gates.
- Al seleccionar un cambio, la columna central muestra sus operaciones y motivos.
- Al seleccionar una operación, el reel muestra su archivo, símbolo, diff real, procedencia y verificaciones asociadas.
- Una observación se dirige al plan, nodo, cambio, operación, archivo, símbolo y patch seleccionados.

Los eventos `1.0` siguen reconstruyéndose. Cuando una corrida histórica no declaró `changes`, el panel la identifica como evidencia heredada y no inventa granularidad.

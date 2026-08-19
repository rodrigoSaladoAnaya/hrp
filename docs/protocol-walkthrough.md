# Recorrido del protocolo

Este ejemplo conserva el contrato mínimo compatible. Para la vista predeterminada con un nodo por decisión, diffs por archivo y cobertura obligatoria, usa el contrato `1.1` de [granular-review.md](./granular-review.md).

Con el servidor en ejecución, publica un plan neutral:

```bash
curl -X POST http://127.0.0.1:4317/api/protocol/plans \
  -H 'content-type: application/json' \
  -d '{
    "title": "Validación de registro",
    "summary": "Contrato, implementación y pruebas",
    "nodes": [
      {
        "id": "contract",
        "title": "Definir errores públicos",
        "objective": "Estabilizar el contrato antes de implementar",
        "dependencies": [],
        "affectedFiles": ["examples/user-registration/src/register.ts"],
        "rationale": "Los consumidores dependen del contrato observable.",
        "verificationCriteria": ["Los casos inválidos tienen errores explícitos."]
      },
      {
        "id": "implementation",
        "title": "Implementar validación",
        "objective": "Rechazar datos inválidos y conservar normalización",
        "dependencies": ["contract"],
        "affectedFiles": ["examples/user-registration/src/register.ts"],
        "rationale": "Implementa el contrato ya revisado.",
        "verificationCriteria": ["El runner externo reporta exitCode 0."]
      },
      {
        "id": "tests",
        "title": "Cubrir el comportamiento",
        "objective": "Probar éxito y fallos",
        "dependencies": ["implementation"],
        "affectedFiles": ["examples/user-registration/test/register.test.ts"],
        "rationale": "Evita regresiones del contrato.",
        "verificationCriteria": ["La suite cubre entradas válidas e inválidas."]
      }
    ]
  }'
```

Abre el panel, aprueba el plan y marca la rama de pruebas como `AUTO` o `OBSERVAR`. El cambio quedará ligado a los fingerprints actuales.

Un adaptador inicia un nodo con:

```bash
curl -X POST http://127.0.0.1:4317/api/protocol/nodes/contract/start \
  -H 'content-type: application/json' \
  -d '{
    "intent": "Definir únicamente el contrato de errores",
    "affectedFiles": ["examples/user-registration/src/register.ts"]
  }'
```

Los nodos `required` necesitan antes una revisión de nodo creada en `POST /api/protocol/reviews`. Los nodos `watch` y `auto` pueden iniciar después de completar sus dependencias.

Durante el trabajo, el adaptador publica patches y verificaciones. Las observaciones emitidas desde el panel aparecen en:

```bash
curl http://127.0.0.1:4317/api/protocol/commands
```

Tras entregar un comando al agente, el adaptador confirma su ID:

```bash
curl -X POST http://127.0.0.1:4317/api/protocol/commands/COMMAND_ID/ack
```

Este recorrido no presupone cómo se inicia, autentica o controla el modelo. Esas decisiones pertenecen al adaptador.

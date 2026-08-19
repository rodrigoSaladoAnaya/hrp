# Flujo del adaptador HRP

Esta referencia define el intercambio entre un agente y HRP. Los comandos funcionan desde la raíz del proyecto objetivo y aceptan `--url URL` cuando la instancia no usa `http://127.0.0.1:4317`.

## 1. Conectar

```bash
hrp attach . --start --json
```

`attach` valida tanto la versión del protocolo como la ruta absoluta del workspace. No continúes si la instancia está observando otro proyecto.

## 2. Publicar el plan

Escribe el siguiente contrato JSON en un archivo temporal fuera del proyecto y publícalo con `hrp plan publish ARCHIVO --json`:

```json
{
  "title": "Resultado buscado",
  "summary": "Alcance y estrategia resumidos",
  "nodes": [
    {
      "id": "implementacion",
      "title": "Implementar el cambio",
      "objective": "Comportamiento observable que producirá el nodo",
      "dependencies": [],
      "affectedFiles": ["src/example.ts"],
      "rationale": "Por qué esta unidad y este enfoque son apropiados",
      "alternatives": [
        {
          "option": "Alternativa descartada",
          "reasonRejected": "Motivo concreto"
        }
      ],
      "verificationCriteria": ["El comando de prueba termina con código 0"],
      "changes": [
        {
          "id": "persist-project-id",
          "title": "Aislar eventos por proyecto",
          "intent": "Conservar el proyecto propietario en cada evento",
          "rationale": "Una base compartida necesita una frontera explícita",
          "dependencies": [],
          "operations": [
            {
              "id": "write-project-id",
              "file": "src/example.ts",
              "symbol": "append",
              "kind": "modify",
              "summary": "Guardar project_id al insertar",
              "rationale": "Permite filtrar lecturas sin mezclar carpetas"
            }
          ]
        }
      ]
    }
  ]
}
```

Los ids sólo admiten letras, números, `_` y `-`. Las dependencias deben formar un DAG. `affectedFiles`, `verificationCriteria`, `changes` y `operations` no pueden estar vacíos en una corrida granular. Cada cambio debe ser una decisión semántica revisable y cada operación debe explicar **qué** hará en un archivo y **por qué**. No agrupes decisiones independientes en un solo cambio.

El resultado incluye `review.id`. Espera su resolución:

```bash
hrp wait review --id REVIEW_ID --timeout 50 --json
```

Código de salida: `0` aprobado, `4` timeout, `10` rechazado, `11` redirigido y `12` pausado. Un timeout exige otra espera, no una inferencia.

## 3. Ejecutar un nodo

Consulta el estado y localiza el nodo en el plan activo:

```bash
hrp state --json
```

Si `reviewMode` es `required`:

```bash
hrp review request NODE_ID --summary "Objetivo y alcance que se revisarán" --json
hrp wait review --id REVIEW_ID --timeout 50 --json
```

Declara intención y archivos antes de editar:

```bash
hrp node start NODE_ID \
  --intent "Cambio concreto que voy a realizar" \
  --files src/example.ts,src/example.test.ts
```

Después de editar, publica el diff Git. Usa `--files` para limitarlo al nodo; omítelo sólo cuando todos los cambios detectados pertenecen inequívocamente al nodo:

```bash
hrp patch publish NODE_ID \
  --change persist-project-id \
  --summary "Qué cambió y por qué" \
  --files src/example.ts,src/example.test.ts
```

Para workspaces sin Git o evidencia preparada por otra herramienta:

```bash
hrp patch publish NODE_ID \
  --change persist-project-id \
  --summary "Qué cambió y por qué" \
  --files src/example.ts \
  --diff-file /ruta/al/diff.patch
```

El adaptador puede ejecutar una verificación y publicar su salida en una operación:

```bash
hrp verify run NODE_ID --command-id unit-tests -- npm test
```

También puede publicar el resultado de un comando ya ejecutado:

```bash
hrp verify publish NODE_ID \
  --command-id unit-tests \
  --command "npm test" \
  --exit-code 0 \
  --output-file /ruta/al/output.txt
```

Por defecto, `verify run` y `verify publish` mapean la evidencia a todos los cambios, operaciones y patches actuales del nodo. Para una prueba estrecha declara la cobertura exacta con `--changes`, `--operations` y `--patches`. Un nodo granular no puede terminar hasta que todas sus operaciones tengan diff real y una verificación exitosa mapeada.

Finaliza sólo con la última verificación exitosa:

```bash
hrp node complete NODE_ID --summary "Resultado implementado y verificado"
```

## 4. Consumir observaciones y control

Consulta comandos antes de cada transición y después de publicar un patch o verificación:

```bash
hrp commands list --json
```

Tipos posibles:

- `observation`: pregunta, restricción, cambio o nota humana; inspecciona `payload.observation.blocking`.
- `review_resolution`: decisión y posible dirección humana.
- `review_policy`: cambio de modo para un nodo o rama.
- `control`: `pause` o `resume` global.

Después de procesar cada comando:

```bash
hrp commands ack COMMAND_ID
```

Si no hay comandos aún y el humano indicó que enviará uno:

```bash
hrp wait commands --timeout 50 --json
```

## 5. Replan

Publica el mismo contrato del plan, añadiendo estas propiedades de nivel superior:

```json
{
  "changedAssumption": "Qué cambió y por qué invalida el plan activo",
  "retainedNodeIds": ["nodo-sin-cambios"],
  "supersededNodeIds": ["nodo-reemplazado"],
  "newNodeIds": ["nodo-nuevo"]
}
```

Usa `hrp replan publish ARCHIVO --json` y espera su `review.id` igual que para el plan inicial. Las políticas sólo se conservan cuando el fingerprint semántico del nodo no cambia.

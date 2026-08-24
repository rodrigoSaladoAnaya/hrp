# Protocolo neutral HRP v3

La version observable del protocolo la publica `PROTOCOL_VERSION` en `src/shared/protocol.ts` y el endpoint `/api/health`.

HRP no solicita ni almacena el razonamiento interno de un modelo. Un adaptador publica explicaciones operativas y evidencia observable.

## Flujo

1. Registrar la carpeta del proyecto.
2. Crear una ejecución para el requerimiento humano.
3. Publicar el mejor mapa conocido de operaciones semánticas.
4. Esperar la aprobación humana de los nodos publicados.
5. Iniciar un nodo aprobado cuando sus dependencias hayan terminado y no exista otro nodo en curso.
6. Publicar su diff real.
7. Publicar una verificación.
8. Completar el nodo sólo si existen diff y verificación aprobada.
9. Añadir al mismo mapa cualquier operación descubierta posteriormente y volver a esperar su aprobación.

## Identidad de un nodo

Cada nodo combina:

- `file`: ruta relativa al workspace.
- `symbol`: método, componente, clave de configuración o sección lógica.
- `title`: nombre corto del cambio.
- `description`: qué pretende hacer.
- `rationale`: por qué es necesario.
- `dependencies`: nodos que deben completarse primero.
- `discovered`: indica que no estaba en el mapa inicial.
- `approved`: indica que el humano autorizó su ejecución.
- `assignee`: agente elegido por el humano, cuando existe.
- `difficulty`: dificultad declarada de la operación — `trivial`, `standard` o `hard`. Es opcional y ausente equivale a `standard`.

Los identificadores pertenecen al adaptador, deben ser estables dentro de una ejecución y no contienen semántica específica de un proveedor.

El plan nunca se sustituye por el resultado. Cuando el agente publica el parche, HRP conserva además:

- `patchSummary`: qué hizo realmente;
- `patchRationale`: por qué la implementación aplicada tomó esa forma;
- `diff`: evidencia exacta del cambio.

`patchRationale` es opcional para adaptadores anteriores, pero los adaptadores nuevos deben publicarlo. Si falta, la interfaz lo indica sin atribuir al agente una explicación que no proporcionó.

## Aprobación, identidad y concurrencia segura

Todo nodo publicado o descubierto nace sin aprobar. El servidor rechaza `start` hasta que el humano lo aprueba desde el panel o mediante `hrp node approve`.

El humano puede asignar un nodo. El adaptador declara su identidad al iniciar o reintentar y no toma trabajo asignado a otro agente. La identidad es declarativa, no autenticada.

La dificultad es lo que decide **qué modelo** implementa el nodo. La publica el modelo base junto con el resto de la spec, de modo que el humano la aprueba y puede corregirla antes de que exista código; ningún componente la infiere después del diff. Un ejecutor delegado se nombra `ollama` (el modelo por defecto) o `ollama:<modelo>` para un modelo concreto, y ese carril **es una identidad ejecutora distinta**.

Pueden coexistir varios nodos `running` cuando HRP determina que son compatibles. El servidor rechaza `start` si el candidato depende de un nodo en curso, si otro nodo en curso depende de él, si ambos modifican el mismo archivo, o si uno modifica un archivo que el otro usa como contexto aprobado.

Un mismo agente nunca sostiene dos nodos `running`: el estado observable por agente modela un solo `currentNodeId`, y un segundo nodo dejaría al primero sin rastro en el panel y en la señal de atención. Por eso los carriles importan: dos carriles con distinto modelo son dos identidades, así que sus nodos corren a la vez **bajo exactamente las mismas reglas de compatibilidad** —la concurrencia sale de repartir el trabajo entre ejecutores, nunca de relajar la exclusión que protege el workspace. Un nodo asignado a la familia `ollama` puede iniciarlo cualquier carril, y `executedBy` conserva el modelo real que lo implementó.

Mientras haya otro nodo en vuelo, la verificación debe nombrar el archivo, el símbolo o el id del nodo. Un comando de proyecto entero también lee lo que el otro nodo tiene a medio editar, así que HRP lo rechaza hasta que el workspace vuelva a estar libre para esa lectura global.

Republicar el grafo conserva los nodos completados y devuelve a aprobación los demás.

## Estados

- `pending`: declarado, sin ejecución.
- `running`: el adaptador está trabajando en esa operación.
- `completed`: tiene diff y verificación aprobada.
- `failed`: su última verificación falló.

Un fallo técnico no crea otra ejecución. El adaptador corrige el cambio y reinicia el mismo nodo; los dependientes permanecen bloqueados hasta que ese nodo publique una verificación aprobada. Cada intento queda conservado en la actividad cronológica, aunque el inspector muestre la evidencia más reciente.

```sh
hrp node retry <run-id> <node-id>
```

## JSON de un mapa

```json
{
  "nodes": [
    {
      "id": "theme-contract",
      "file": "config.json",
      "symbol": "theme.default",
      "title": "Declarar el tema predeterminado",
      "description": "Añadir la preferencia al contrato persistente.",
      "rationale": "La UI necesita una fuente de verdad compartida.",
      "difficulty": "trivial",
      "dependencies": []
    },
    {
      "id": "resolve-theme",
      "file": "src/theme.ts",
      "symbol": "resolveTheme",
      "title": "Resolver la apariencia activa",
      "description": "Combinar preferencia y apariencia del sistema.",
      "rationale": "Las pantallas no deben duplicar esta decisión.",
      "difficulty": "hard",
      "dependencies": ["theme-contract"]
    }
  ]
}
```

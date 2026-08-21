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

Los identificadores pertenecen al adaptador, deben ser estables dentro de una ejecución y no contienen semántica específica de un proveedor.

El plan nunca se sustituye por el resultado. Cuando el agente publica el parche, HRP conserva además:

- `patchSummary`: qué hizo realmente;
- `patchRationale`: por qué la implementación aplicada tomó esa forma;
- `diff`: evidencia exacta del cambio.

`patchRationale` es opcional para adaptadores anteriores, pero los adaptadores nuevos deben publicarlo. Si falta, la interfaz lo indica sin atribuir al agente una explicación que no proporcionó.

## Aprobación, identidad y exclusión

Todo nodo publicado o descubierto nace sin aprobar. El servidor rechaza `start` hasta que el humano lo aprueba desde el panel o mediante `hrp node approve`.

El humano puede asignar un nodo. El adaptador declara su identidad al iniciar o reintentar y no toma trabajo asignado a otro agente. La identidad es declarativa, no autenticada.

Sólo puede existir un nodo `running` por ejecución. Esta exclusión evita que parches y verificaciones de varios agentes contaminen el mismo workspace compartido.

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
      "dependencies": []
    },
    {
      "id": "resolve-theme",
      "file": "src/theme.ts",
      "symbol": "resolveTheme",
      "title": "Resolver la apariencia activa",
      "description": "Combinar preferencia y apariencia del sistema.",
      "rationale": "Las pantallas no deben duplicar esta decisión.",
      "dependencies": ["theme-contract"]
    }
  ]
}
```

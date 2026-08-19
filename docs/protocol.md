# Protocolo neutral v2

HRP no solicita ni almacena el razonamiento interno de un modelo. Un adaptador publica explicaciones operativas y evidencia observable.

## Flujo

1. Registrar la carpeta del proyecto.
2. Crear una ejecución para el requerimiento humano.
3. Publicar el mejor mapa conocido de operaciones semánticas.
4. Iniciar un nodo cuando sus dependencias hayan terminado.
5. Publicar su diff real.
6. Publicar una verificación.
7. Completar el nodo sólo si existen diff y verificación aprobada.
8. Añadir al mismo mapa cualquier operación descubierta posteriormente.

## Identidad de un nodo

Cada nodo combina:

- `file`: ruta relativa al workspace.
- `symbol`: método, componente, clave de configuración o sección lógica.
- `title`: nombre corto del cambio.
- `description`: qué pretende hacer.
- `rationale`: por qué es necesario.
- `dependencies`: nodos que deben completarse primero.
- `discovered`: indica que no estaba en el mapa inicial.

Los identificadores pertenecen al adaptador, deben ser estables dentro de una ejecución y no contienen semántica específica de un proveedor.

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

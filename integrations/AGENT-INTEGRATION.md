# Integración neutral de agentes con HRP

Este documento es el contrato portátil para adaptar Codex, Claude, Gemini u otro agente sin acoplar el núcleo de HRP a un proveedor.

## Arquitectura recomendada

```text
instrucción del proveedor ──▶ CLI hrp ──HTTP──▶ HRP core ──SSE──▶ panel humano
          ▲                                      │                 │
          └──────── comandos neutrales ◀─────────┴─────────────────┘
```

La instrucción del proveedor decide **cuándo** invocar HRP. El CLI decide **cómo** traducir el trabajo a HTTP. El core sólo decide **qué significa** cada evento, gate y comando. Esta separación permite reemplazar Codex sin migrar sesiones ni cambiar la interfaz humana.

## Capacidades mínimas de un adaptador

Un adaptador debe:

1. Validar la URL, versión del protocolo y workspace con `hrp attach`.
2. Publicar un DAG antes de mutar el proyecto. Cada fase declara cambios semánticos y operaciones por archivo/símbolo con motivo local.
3. Esperar revisiones `required` sin interpretar un timeout como aprobación.
4. Declarar intención y archivos antes de cada nodo.
5. Publicar cada patch ligado a un cambio; el diff debe poder separarse por archivo y cubrir las operaciones declaradas.
6. Publicar resultados de verificación con cobertura explícita de cambios, operaciones o patches.
7. Consultar, entregar y después confirmar los comandos humanos.
8. Respetar pausa, redirección, rechazo y replans.
9. No atribuir al agente cambios externos sólo porque aparecen en Git.

## Unidad canónica de revisión

```text
PlanNode (fase y gate)
└── SemanticChange (decisión explicable y verificable)
    └── ChangeOperation (archivo, símbolo, acción, qué y por qué)
        └── PatchEvidence (diff real por archivo)
```

El panel usa por defecto los cambios semánticos como nodos del grafo y conserva una proyección de fases. Un adaptador no debe usar “un archivo” como sinónimo de “un cambio”: una decisión puede atravesar varios archivos y un archivo puede contener decisiones distintas.

El detalle operativo y los códigos de salida viven en `integrations/codex/plugins/hrp/skills/use-hrp/references/agent-workflow.md`. Aunque está empaquetado con Codex, su contenido no depende de herramientas de OpenAI y puede reutilizarse en otros proveedores.

## Opciones por proveedor

### Codex

- Skill standalone: menor fricción y compatible con uso explícito de `$use-hrp`.
- Plugin: paquete distribuible para equipos; contiene la misma skill y no declara MCP ni hooks.

### Claude

- Copiar el contrato a una instrucción/comando de proyecto o usuario que se active explícitamente.
- Ejecutar el mismo binario `hrp`; no recrear la API con herramientas específicas de Claude.

### Gemini

- Exponer el contrato como instrucción/extensión invocable y usar el mismo CLI.
- Mantener cualquier mecanismo de aprobación del proveedor como optimización, no como fuente canónica del estado.

## Qué no instalar en el proyecto objetivo

- No agregar archivos de instrucciones del agente automáticamente.
- No agregar dependencias npm/pip al proyecto observado.
- No ejecutar hooks globales que capturen todas las tareas.
- No requerir MCP para operaciones que ya cubre el CLI HTTP local.

La instalación vive en el perfil del agente o en su marketplace y se activa sólo cuando el usuario dice que use HRP.

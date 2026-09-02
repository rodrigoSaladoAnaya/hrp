// Resaltado de sintaxis para el panel Antes/Después. Se resalta el archivo
// entero (así los comentarios de bloque y las plantillas multilínea conservan
// su color) y el HTML resultante se reparte por líneas cerrando y reabriendo
// los spans que las cruzan, para pintarlo en la rejilla alineada.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const languages: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = { bash, css, java, javascript, json, markdown, python, scss, sql, typescript, xml, yaml };
for (const [name, language] of Object.entries(languages)) hljs.registerLanguage(name, language);

const byExtension: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  css: "css", scss: "scss",
  json: "json", jsonc: "json",
  md: "markdown", markdown: "markdown",
  sh: "bash", bash: "bash", zsh: "bash",
  html: "xml", htm: "xml", xml: "xml", svg: "xml",
  yml: "yaml", yaml: "yaml",
  py: "python",
  java: "java",
  sql: "sql",
};

export function languageForPath(path: string): string | undefined {
  const name = path.split("/").pop() ?? "";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return byExtension[extension];
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function splitSource(source: string): string[] {
  if (source === "") return [];
  const lines = source.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const tagPattern = /<span class="([^"]*)">|<\/span>/g;

// Reparte HTML resaltado por líneas: cada línea cierra los spans que deja
// abiertos y la siguiente los vuelve a abrir con las mismas clases.
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = "";
  let index = 0;
  const flush = () => {
    lines.push(current + "</span>".repeat(open.length));
    current = open.map((className) => `<span class="${className}">`).join("");
  };
  while (index < html.length) {
    tagPattern.lastIndex = index;
    const tag = tagPattern.exec(html);
    const tagStart = tag ? tag.index : html.length;
    const chunk = html.slice(index, tagStart);
    const parts = chunk.split("\n");
    for (let position = 0; position < parts.length; position += 1) {
      current += parts[position];
      if (position < parts.length - 1) flush();
    }
    if (!tag) break;
    if (tag[0] === "</span>") open.pop();
    else open.push(tag[1]);
    current += tag[0];
    index = tagStart + tag[0].length;
  }
  if (current !== "" || open.length) lines.push(current + "</span>".repeat(open.length));
  return lines;
}

// Una entrada HTML por línea de la fuente, escapada; sin lenguaje conocido
// sólo se escapa.
export function highlightLines(source: string | undefined, path: string): string[] {
  if (source === undefined) return [];
  const plain = splitSource(source);
  const language = languageForPath(path);
  if (!language) return plain.map(escapeHtml);
  try {
    const { value } = hljs.highlight(source, { language, ignoreIllegals: true });
    const lines = splitHighlightedLines(value);
    // La última línea vacía (salto final) no cuenta como línea de la fuente.
    while (lines.length > plain.length && lines[lines.length - 1] === "") lines.pop();
    if (lines.length !== plain.length) return plain.map(escapeHtml);
    return lines;
  } catch {
    return plain.map(escapeHtml);
  }
}

import { describe, expect, it } from "vitest";
import { escapeHtml, highlightLines, languageForPath, splitHighlightedLines } from "./syntax.js";

const strip = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe("languageForPath", () => {
  it("mapea extensiones conocidas y deja el resto sin lenguaje", () => {
    expect(languageForPath("src/web/App.tsx")).toBe("typescript");
    expect(languageForPath("bin/hrp.mjs")).toBe("javascript");
    expect(languageForPath("src/web/styles.css")).toBe("css");
    expect(languageForPath("README.md")).toBe("markdown");
    expect(languageForPath("scripts/install.sh")).toBe("bash");
    expect(languageForPath("src/web/index.html")).toBe("xml");
    expect(languageForPath("a/b/config.YML")).toBe("yaml");
    expect(languageForPath("LICENSE")).toBeUndefined();
    expect(languageForPath(".gitignore")).toBeUndefined();
  });
});

describe("splitHighlightedLines", () => {
  it("cierra y reabre los spans que cruzan líneas", () => {
    const lines = splitHighlightedLines('a <span class="hljs-comment">/* uno\ndos\ntres */</span> b');
    expect(lines).toEqual([
      'a <span class="hljs-comment">/* uno</span>',
      '<span class="hljs-comment">dos</span>',
      '<span class="hljs-comment">tres */</span> b',
    ]);
  });

  it("respeta spans anidados", () => {
    const lines = splitHighlightedLines('<span class="x"><span class="y">1\n2</span>\n3</span>');
    expect(lines).toEqual(['<span class="x"><span class="y">1</span></span>', '<span class="x"><span class="y">2</span></span>', '<span class="x">3</span>']);
  });
});

describe("highlightLines", () => {
  it("devuelve una línea por línea de la fuente con el mismo texto", () => {
    const source = "const a = 1; // hola\n/* bloque\n   sigue */\nconst b = `x\n${a}\ny`;\n";
    const lines = highlightLines(source, "x.ts");
    expect(lines).toHaveLength(6);
    expect(lines.map(strip)).toEqual(source.split("\n").slice(0, 6));
    expect(lines[0]).toContain("hljs-keyword");
    expect(lines[1]).toContain("hljs-comment");
    expect(lines[2]).toContain("hljs-comment");
    expect(lines[3]).toContain("hljs-string");
    expect(lines[4]).toContain("hljs-string");
  });

  it("escapa sin lenguaje y con lenguaje", () => {
    expect(highlightLines("a < b && c > d\n", "notes.txt")).toEqual(["a &lt; b &amp;&amp; c &gt; d"]);
    expect(strip(highlightLines("if (a < b && c > d) {}\n", "x.ts")[0])).toBe("if (a < b && c > d) {}");
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
  });

  it("maneja fuente vacía, ausente y sin salto final", () => {
    expect(highlightLines(undefined, "x.ts")).toEqual([]);
    expect(highlightLines("", "x.ts")).toEqual([]);
    expect(highlightLines("a\nb", "x.ts")).toHaveLength(2);
    expect(highlightLines("# t\n\ntexto\n", "README.md")).toHaveLength(3);
  });
});

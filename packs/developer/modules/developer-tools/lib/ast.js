"use strict";

/* Tree-sitter adapter boundary. Parser loading is isolated here so grammar
 * packaging differences (including Perl's ESM binding) cannot leak into the
 * normalized Semantic IR or the Developer Pack dispatcher. */
const Parser = require("tree-sitter");

const grammarPromises = new Map();
const grammarVersions = Object.freeze({
  javascript: "tree-sitter-javascript@0.25.0",
  javascript_jsx: "tree-sitter-javascript@0.25.0",
  typescript: "tree-sitter-typescript@0.23.2",
  typescript_tsx: "tree-sitter-typescript@0.23.2",
  ruby: "tree-sitter-ruby@0.23.1",
  java: "tree-sitter-java@0.23.5",
  go: "tree-sitter-go@0.25.0",
  perl: "tree-sitter-perl@1.2.1",
  rust: "tree-sitter-rust@0.24.0",
});

async function grammarFor(language) {
  if (!grammarPromises.has(language)) {
    grammarPromises.set(language, (async () => {
      if (language === "perl") return (await import("tree-sitter-perl")).default;
      const base = language.startsWith("typescript") ? "typescript" : language.startsWith("javascript") ? "javascript" : language;
      const loaded = require(`tree-sitter-${base}`);
      if (language === "typescript_tsx") return loaded.tsx;
      return base === "typescript" ? loaded.typescript : loaded;
    })());
  }
  return grammarPromises.get(language);
}

async function parse(language, source, limits = {}) {
  const grammar = await grammarFor(language);
  const parser = new Parser(); parser.setLanguage(grammar);
  const tree = parser.parse(source);
  const maxNodes = Math.min(Number(limits.maxNodes) || 50000, 100000);
  const symbols = []; const imports = []; const exports = []; const relationships = []; let visited = 0;
  const symbolKinds = new Map([
    ["function_declaration", "function"], ["function_item", "function"], ["method_definition", "method"], ["method_declaration", "method"],
    ["class_declaration", "class"], ["interface_declaration", "interface"], ["trait_item", "trait"], ["struct_item", "struct"],
    ["enum_item", "enum"], ["enum_declaration", "enum"], ["module", "module"], ["namespace_definition", "namespace"],
  ]);
  const nameFrom = node => {
    const named = node.childForFieldName?.("name");
    if (named) return named.text;
    for (const child of node.namedChildren || []) if (/identifier|name|constant|type_identifier/.test(child.type)) return child.text;
    return null;
  };
  const add = (list, value, key) => { if (value && !list.some(x => key(x) === key(value))) list.push(value); };
  const walk = (node, scope = null) => {
    if (!node || visited++ >= maxNodes) return;
    const name = nameFrom(node);
    if (symbolKinds.has(node.type) && name) {
      const symbol = { name: String(name).slice(0, 200), kind: symbolKinds.get(node.type), ast_node: node.type, start_byte: node.startIndex, end_byte: node.endIndex, start_line: node.startPosition.row + 1, start_column: node.startPosition.column + 1, parent: scope };
      add(symbols, symbol, x => `${x.name}:${x.kind}:${x.start_byte}`);
      scope = symbol.name;
    }
    if (/^(import|use_declaration|import_declaration|import_statement|preproc_include)$/.test(node.type)) add(imports, { text: String(node.text).slice(0, 240), ast_node: node.type, start_byte: node.startIndex }, x => `${x.ast_node}:${x.start_byte}`);
    if (/^(export_statement|export_declaration)$/.test(node.type)) add(exports, { text: String(node.text).slice(0, 240), ast_node: node.type, start_byte: node.startIndex }, x => `${x.ast_node}:${x.start_byte}`);
    if (/^(call_expression|call|method_invocation)$/.test(node.type)) {
      const fn = node.childForFieldName?.("function") || node.childForFieldName?.("name");
      if (fn && scope) relationships.push({ kind: "calls", from: scope, to: String(fn.text).slice(0, 200), certainty: "parsed", start_byte: node.startIndex, end_byte: node.endIndex, ast_node: node.type });
    }
    for (const child of node.namedChildren || []) walk(child, scope);
  };
  walk(tree.rootNode);
  const parseErrors = Boolean(tree.rootNode.hasError);
  return { parser: "tree-sitter", parser_version: grammarVersions[language], root_type: tree.rootNode.type, parse_errors: parseErrors, visited_nodes: visited, symbols, imports, exports, relationships };
}

module.exports = { grammarFor, grammarVersions, parse };

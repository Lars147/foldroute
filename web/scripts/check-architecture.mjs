import ts from "typescript";
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";

const root = resolve("src");
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(resolve(dir, entry.name))
          : /\.(ts|svelte)$/.test(entry.name)
            ? [resolve(dir, entry.name)]
            : [],
      ),
    )
  ).flat();
}
const paths = await files(root);
const graph = new Map();
const pure = new Set([
  "clock.ts",
  "model.ts",
  "place-model.ts",
  "routing-settings.ts",
  "geometry.ts",
  "snapshot-codec.ts",
  "navigation-summary.ts",
  "navigation-projection.ts",
  "routing-contracts.ts",
  "pwa-update-state.ts",
]);
for (const path of paths) {
  let code = await readFile(path, "utf8");
  if (path.endsWith(".svelte"))
    code = [...code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1])
      .join("\n");
  const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
  const dependencies = [];
  for (const statement of source.statements) {
    const importing = ts.isImportDeclaration(statement);
    const exporting = ts.isExportDeclaration(statement);
    if (
      (!importing && !exporting) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    if (
      exporting &&
      (statement.isTypeOnly ||
        (statement.exportClause &&
          ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.every((item) => item.isTypeOnly)))
    )
      continue;
    const clause = importing ? statement.importClause : undefined;
    const bindings = clause?.namedBindings;
    if (
      clause?.isTypeOnly ||
      (bindings &&
        ts.isNamedImports(bindings) &&
        !clause.name &&
        bindings.elements.every((item) => item.isTypeOnly))
    )
      continue;
    const name = statement.moduleSpecifier.text;
    if (
      pure.has(relative(root, path)) &&
      (!name.startsWith(".") || !pure.has(name.replace(/^\.\//, "") + ".ts"))
    )
      throw new Error(
        `Domain dependency points upward: ${relative(root, path)} imports ${name}`,
      );
    if (!name.startsWith(".")) continue;
    const base = resolve(dirname(path), name);
    const dependency = paths.find(
      (candidate) =>
        candidate === base ||
        candidate === `${base}.ts` ||
        candidate === `${base}.svelte`,
    );
    if (dependency) dependencies.push(dependency);
  }
  graph.set(path, dependencies);
}
const visited = new Set();
const active = [];
function visit(path) {
  if (active.includes(path))
    throw new Error(
      `Runtime import cycle: ${[...active.slice(active.indexOf(path)), path].map((item) => relative(root, item)).join(" -> ")}`,
    );
  if (visited.has(path)) return;
  active.push(path);
  for (const dependency of graph.get(path) ?? []) visit(dependency);
  active.pop();
  visited.add(path);
}
for (const path of paths) visit(path);
console.log(
  `Architecture: ${paths.length} modules; no runtime import cycles or upward domain imports.`,
);

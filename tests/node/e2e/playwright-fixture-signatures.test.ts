import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Playwright resolves a fixture's dependencies by reading the destructured keys
 * of its first argument, so that argument must literally BE a destructuring
 * pattern. `async ({}, use)` is the documented way to declare no dependencies.
 *
 * Naming the parameter instead — `async (_fixtures, use)` — makes `extend()`
 * throw at module load:
 *
 *   First argument must use the object destructuring pattern: _fixtures
 *
 * That is a collection-time failure, so it takes down the entire suite rather
 * than one spec. LAC-5012: biome's `lint/correctness/noEmptyPattern` flags
 * `({})`, and clearing that error by renaming the parameter left `E2E
 * (Playwright)` at zero tests collected. The framework contract wins; the rule
 * is suppressed at the call site instead.
 *
 * This guard is static rather than a Playwright run so it lands in the cheap
 * `test:node` job that runs on every PR — the e2e job is gated and was skipped
 * when the break went in.
 */
const E2E_DIR = join(process.cwd(), "tests", "e2e");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

interface Fixture {
  file: string;
  name: string;
  line: number;
  firstParam: ts.ParameterDeclaration | undefined;
}

/** Every property of an object literal passed to a `*.extend(...)` call. */
function fixturesIn(file: string): Fixture[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const found: Fixture[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "extend" &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const prop of node.arguments[0].properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        // A fixture is either the function itself or `[fn, { scope }]`.
        const init = ts.isArrayLiteralExpression(prop.initializer)
          ? prop.initializer.elements[0]
          : prop.initializer;
        if (!init || (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init))) continue;
        found.push({
          file,
          name: prop.name.getText(source),
          line: source.getLineAndCharacterOfPosition(prop.getStart(source)).line + 1,
          firstParam: init.parameters[0],
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

const fixtures = walk(E2E_DIR).flatMap(fixturesIn);

describe("Playwright fixtures destructure their first argument", () => {
  it("finds the fixture definitions (sanity — a parse change must not silently pass)", () => {
    expect(fixtures.map((f) => f.name).sort()).toContain("manifest");
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
  });

  it.each(
    fixtures.map(
      (f) => [`${relative(E2E_DIR, f.file)}:${f.line} ${f.name}`, f] as [string, Fixture]
    )
  )("%s", (_label, fixture) => {
    expect(fixture.firstParam).toBeDefined();
    expect(fixture.firstParam?.name.kind).toBe(ts.SyntaxKind.ObjectBindingPattern);
  });
});

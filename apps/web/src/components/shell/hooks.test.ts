/**
 * Rules of hooks, the one that quietly breaks a screen: a hook called after an
 * early return.
 *
 * The shell renders the setup route with a short hook list (it returns the
 * children before the game chrome) and the game with the full one. A hook
 * placed below that early return is counted on the second render and not the
 * first, and React throws #310 — "rendered more hooks than during the previous
 * render" — the moment a founder crosses from setup into the game. The app has
 * no eslint, so nothing else enforces this; this test reads the components
 * with the TypeScript parser and refuses a hook call in any top-level statement
 * that follows a statement which may return.
 *
 * Scope: every component and custom hook under the shell, the screens, the
 * scenes, the lib and the app routes — a function whose name is capitalised or
 * starts with `use`. Hooks inside nested functions (an effect's body, a
 * callback) are not component hooks and are not counted.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(process.cwd(), 'src');

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const isFunctionLike = (node: ts.Node): boolean =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node);

/** Hook calls in a statement, not descending into nested functions. */
function hookCallsIn(node: ts.Node): string[] {
  const out: string[] = [];
  // A function declared inside the component is not the component's body.
  if (isFunctionLike(node)) return out;
  const walk = (current: ts.Node): void => {
    if (current !== node && isFunctionLike(current)) return;
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name !== null && /^use[A-Z]/.test(name)) out.push(name);
    }
    ts.forEachChild(current, walk);
  };
  walk(node);
  return out;
}

/** Whether a statement contains a `return`, not counting returns inside nested functions. */
function mayReturn(node: ts.Node): boolean {
  if (isFunctionLike(node)) return false;
  let found = false;
  const walk = (current: ts.Node): void => {
    if (found) return;
    if (current !== node && isFunctionLike(current)) return;
    if (ts.isReturnStatement(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, walk);
  };
  walk(node);
  return found;
}

/** The component's or hook's body, for a declaration that is one. */
function componentBody(node: ts.Node): { name: string; body: ts.Block } | null {
  const isComponentName = (name: string): boolean => /^[A-Z]/.test(name) || /^use[A-Z]/.test(name);
  if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined && isComponentName(node.name.text)) {
    return { name: node.name.text, body: node.body };
  }
  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !isComponentName(declaration.name.text) || declaration.initializer === undefined) continue;
      let initializer: ts.Expression = declaration.initializer;
      // memo(function X() {}), forwardRef((props, ref) => {}), memo(forwardRef(...))
      while (ts.isCallExpression(initializer) && initializer.arguments[0] !== undefined) initializer = initializer.arguments[0];
      if ((ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) && initializer.body !== undefined && ts.isBlock(initializer.body)) {
        return { name: declaration.name.text, body: initializer.body };
      }
    }
  }
  return null;
}

export function hooksAfterEarlyReturn(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: string[] = [];
  const check = (node: ts.Node): void => {
    const component = componentBody(node);
    if (component !== null) {
      let returned: string | null = null;
      for (const statement of component.body.statements) {
        const hooks = hookCallsIn(statement);
        if (returned !== null && hooks.length > 0) {
          violations.push(`${fileName}: ${component.name} calls ${hooks.join(', ')} after an early return (${returned})`);
        }
        if (returned === null && mayReturn(statement)) returned = statement.getText(file).split('\n')[0]?.trim() ?? 'return';
      }
    }
    // Components declared inside an `export default` wrapper or a namespace.
    ts.forEachChild(node, check);
  };
  check(file);
  return violations;
}

describe('rules of hooks: no hook after an early return', () => {
  it('holds for a shell that returns the setup route before the game chrome', () => {
    const bad = `
      export function Shell({ children }) {
        const pathname = usePathname();
        if (!isGamePath(pathname)) { return children; }
        const search = useNewsSearch(pathname);
        return <div>{search}{children}</div>;
      }`;
    expect(hooksAfterEarlyReturn(bad, 'Shell.tsx')).toEqual(['Shell.tsx: Shell calls useNewsSearch after an early return (if (!isGamePath(pathname)) { return children; })']);
    const good = `
      export function Shell({ children }) {
        const pathname = usePathname();
        const search = useNewsSearch(pathname);
        useEffect(() => { if (search === '') return; }, [search]);
        if (!isGamePath(pathname)) { return children; }
        const label = React.useMemo ? 'x' : 'y';
        return <div>{search}{children}</div>;
      }`;
    expect(hooksAfterEarlyReturn(good, 'Shell.tsx')).toEqual([]);
    // A memoised component and a custom hook are read the same way.
    const memoised = `
      export const Card = memo(function Card({ item }) {
        if (item === null) return null;
        const [open] = useState(false);
        return <p>{String(open)}</p>;
      });
      export function useThing(id) {
        if (id === null) return null;
        return useMemo(() => id, [id]);
      }`;
    expect(hooksAfterEarlyReturn(memoised, 'Card.tsx')).toHaveLength(2);
  });

  it('holds for every component and hook in the app', () => {
    const violations = files(ROOT).flatMap((path) => hooksAfterEarlyReturn(readFileSync(path, 'utf8'), relative(process.cwd(), path)));
    expect(violations).toEqual([]);
  });
});

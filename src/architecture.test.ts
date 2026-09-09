import { expect, test } from 'bun:test'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'

test('editors depend only on their own feature and shared code; shared code is app-independent', async () => {
  const root = import.meta.dir
  const violations: string[] = []
  for await (const path of new Bun.Glob('{editors,shared}/**/*.{ts,css}').scan(root)) {
    if (path.endsWith('.test.ts')) continue
    const text = await Bun.file(resolve(root, path)).text()
    const dependencies: string[] = []
    if (path.endsWith('.css')) {
      for (const match of text.matchAll(/@import\s+['"]([^'"]+)['"]/g)) dependencies.push(match[1])
    } else {
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
      function visit(node: ts.Node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependencies.push(node.moduleSpecifier.text)
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) dependencies.push(node.argument.literal.text)
        if ((ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          || ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL')
          && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0])) dependencies.push(node.arguments[0].text)
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    const feature = path.startsWith('shared/') ? 'shared/' : path.split('/').slice(0, 2).join('/') + '/'
    for (const dependency of dependencies) {
      if (!dependency.startsWith('.')) continue
      const target = relative(root, resolve(root, dirname(path), dependency))
      if (!target.startsWith(feature) && !target.startsWith('shared/')) violations.push(`${path} -> ${dependency}`)
    }
  }
  expect(violations).toEqual([])
})

test('app and core load scene modules only through dynamic imports', async () => {
  const root = import.meta.dir
  const violations: string[] = []
  for await (const path of new Bun.Glob('{app,core}/**/*.{ts,tsx}').scan(root)) {
    if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) continue
    const source = ts.createSourceFile(path, await Bun.file(resolve(root, path)).text(), ts.ScriptTarget.Latest, true)
    for (const node of source.statements) {
      if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        if (clause?.isTypeOnly) continue
        const bindings = clause?.namedBindings
        if (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length && bindings.elements.every(item => item.isTypeOnly)) continue
      } else {
        if (node.isTypeOnly) continue
        const clause = node.exportClause
        if (clause && ts.isNamedExports(clause) && clause.elements.length && clause.elements.every(item => item.isTypeOnly)) continue
      }
      const dependency = node.moduleSpecifier.text
      if (!dependency.startsWith('.')) continue
      const target = relative(root, resolve(root, dirname(path), dependency))
      if (/^(editors\/scene|\.\.\/plugins\/scene)(\/|$)/.test(target)) violations.push(`${path} -> ${dependency}`)
    }
  }
  expect(violations).toEqual([])
})

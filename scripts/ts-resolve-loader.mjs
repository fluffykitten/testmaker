// Resolve extensionless relative imports to .ts/.tsx so Node can run app modules directly.
import fs from 'node:fs';

/** React components can't load in Node; expose their named exports as inert bindings. */
export async function load(url, context, next) {
  if (url.includes('?url')) {
    return { format: 'module', shortCircuit: true, source: 'export default "";' };
  }
  if (url.endsWith('.tsx')) {
    const source = fs.readFileSync(new URL(url), 'utf8');
    const names = [...source.matchAll(/export\s+(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]);
    const hasDefault = /export\s+default/.test(source);
    const stub = names.map((name) => `export const ${name} = undefined;`).join('\n') + (hasDefault ? '\nexport default undefined;' : '');
    return { format: 'module', shortCircuit: true, source: stub };
  }
  return next(url, context);
}

export async function resolve(specifier, context, next) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  const hasExtension = /\.[a-z0-9]+$/i.test(specifier);
  if (isRelative && !hasExtension) {
    for (const candidate of [`${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`, `${specifier}/index.tsx`]) {
      try {
        return await next(candidate, context);
      } catch {
        /* try the next candidate */
      }
    }
  }
  return next(specifier, context);
}

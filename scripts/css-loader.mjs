import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'pdfjs-dist') {
    const legacyPath = path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs');
    return {
      shortCircuit: true,
      url: pathToFileURL(legacyPath).href,
    };
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));
    const rawTarget = path.resolve(parentDir, specifier);
    const targetBase = rawTarget.replace(/\.js$/, '');
    for (const candidate of [rawTarget, targetBase + '.ts', targetBase + '.tsx', targetBase + '.js', targetBase + '/index.ts']) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return {
          shortCircuit: true,
          url: pathToFileURL(candidate).href,
        };
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.includes('?url') || url.endsWith('.css') || url.includes('.css?')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export default "";',
    };
  }
  if (url.endsWith('.tsx')) {
    const filePath = fileURLToPath(url);
    const code = fs.readFileSync(filePath, 'utf8');
    const ts = (await import('typescript')).default;
    const transformed = ts.transpileModule(code, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    });
    return {
      format: 'module',
      shortCircuit: true,
      source: transformed.outputText,
    };
  }
  return nextLoad(url, context);
}

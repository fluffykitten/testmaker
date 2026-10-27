import { pathToFileURL } from 'node:url';
import path from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'pdfjs-dist') {
    const legacyPath = path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs');
    return {
      shortCircuit: true,
      url: pathToFileURL(legacyPath).href,
    };
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
  return nextLoad(url, context);
}

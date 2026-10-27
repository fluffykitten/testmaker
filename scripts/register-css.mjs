import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

if (typeof global.DOMMatrix === 'undefined') {
  global.DOMMatrix = class DOMMatrix {
    constructor() {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
    }
  };
}

register('./scripts/css-loader.mjs', pathToFileURL('./'));

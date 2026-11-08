import { registerHooks } from 'node:module';

// Match Vite's extensionless core imports without transpiling or mocking modules.
const core = new URL('../src/core/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(core) && /^\.\.?\/[^?#]+$/.test(specifier) && !/\.[^/]+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

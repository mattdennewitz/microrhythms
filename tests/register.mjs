import { registerHooks } from 'node:module';

// Match Vite's extensionless core/app imports without transpiling or mocking modules.
const roots = ['core', 'app'].map((dir) => new URL(`../src/${dir}/`, import.meta.url).href);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (roots.some((root) => context.parentURL?.startsWith(root)) && /^\.\.?\/[^?#]+$/.test(specifier) && !/\.[^/]+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

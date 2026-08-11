import { defineConfig } from 'tsup'

export default defineConfig([
  {
    // The library entry: consumed via import/require, so it needs both
    // module formats and the generated .d.ts.
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    // The standalone server entry: only ever run directly with
    // `node dist/main.js`, never imported by a consumer. CJS output would
    // break its import.meta entry-point check for no benefit, so this
    // only builds ESM. clean is off here so it doesn't wipe the output
    // the entry above just produced.
    entry: ['src/main.ts'],
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
  },
])

// Vite's `import.meta.glob` (plan 12g, ddl-columns.test.ts). Core's tests
// have no Node types, so a test reads the source files of core this way.
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, T>;
}

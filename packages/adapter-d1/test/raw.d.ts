// The records that test/schema-v16.test.ts reads as text through Vite (plan 12p).
declare module "*.sql?raw" {
  const text: string;
  export default text;
}
declare module "*.md?raw" {
  const text: string;
  export default text;
}

/// <reference types="vite/client" />
declare module "*.sql?raw" {
  const text: string;
  export default text;
}

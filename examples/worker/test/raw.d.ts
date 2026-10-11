declare module "*.sql?raw" {
  const text: string;
  export default text;
}

declare module "*.csv?raw" {
  const text: string;
  export default text;
}

interface Env {
  BASE_URL: string;
  AUTH_SECRET: string;
  TEST_MODE: string;
}

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

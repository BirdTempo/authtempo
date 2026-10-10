import { type ClientPlugin, COMPAT_CLIENT_PLUGIN, type ExpoClientOptions } from "../types.js";

/**
 * `@better-auth/expo/client`'s `expoClient`. The token lives in `storage`
 * under `<storagePrefix>_tempo_session`. No Expo module is imported here:
 * the system-browser sign-in needs `webBrowser` (expo-web-browser) and, on
 * Hermes, `crypto` (expo-crypto), passed in.
 */
export function expoClient(options: ExpoClientOptions): ClientPlugin {
  return { kind: COMPAT_CLIENT_PLUGIN, id: "expo", options };
}

import { bind, client, text } from "./exchange.js";

bind({ request: (f) => client.magicLink.request({ email: text(f, "email") }) });

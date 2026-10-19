import { bind, client } from "./exchange.js";

// The client sends the browser to the start route. The provider page of the sandbox comes next.
bind({ start: async () => client.social.signIn({ provider: "demo" }) });

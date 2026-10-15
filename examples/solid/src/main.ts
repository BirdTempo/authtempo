import { createClient } from "@authtempo/client";
import { AuthProvider } from "@authtempo/solid";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App.js";

// The API is on another origin: list this app's origin in its trustedOrigins.
const client = createClient({ baseURL: "https://api.example.com" });

const root = document.getElementById("root");
if (root)
  render(
    () =>
      createComponent(AuthProvider, {
        client,
        get children() {
          return createComponent(App, {});
        },
      }),
    root,
  );

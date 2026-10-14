import { createClient } from "@authtempo/client";
import { AuthProvider } from "@authtempo/react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

// The API origin. List this page's origin in the API's trustedOrigins.
const client = createClient({ baseURL: "https://api.example.com" });

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <AuthProvider client={client}>
      <App />
    </AuthProvider>,
  );

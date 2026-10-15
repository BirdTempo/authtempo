import { HttpStatusCode } from "@solidjs/start";

// The app has no page of its own: every route is an API route. Solid Start
// renders this root only for a path that no API route matches, so it answers 404.
export default function App() {
  return (
    <main>
      <HttpStatusCode code={404} />
      Not found
    </main>
  );
}

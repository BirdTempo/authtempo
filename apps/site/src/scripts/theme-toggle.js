(() => {
  const KEY = "starlight-theme";
  const NEXT = { auto: "light", light: "dark", dark: "auto" };
  const root = document.documentElement;
  const safe = (f) => {
    try {
      return f();
    } catch {
      return null;
    }
  };
  const system = () => (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const stored = safe(() => localStorage.getItem(KEY));
  let choice = stored === "light" || stored === "dark" ? stored : "auto";
  const apply = () => {
    root.dataset.theme = choice === "auto" ? system() : choice;
    root.dataset.themeChoice = choice;
    const label = `Use the ${NEXT[choice] === "auto" ? "system" : NEXT[choice]} theme`;
    document.querySelector("[data-theme-toggle]")?.setAttribute("aria-label", label);
  };
  apply();
  document.addEventListener("DOMContentLoaded", apply);
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("[data-theme-toggle]")) return;
    choice = NEXT[choice];
    safe(() => localStorage.setItem(KEY, choice === "auto" ? "" : choice));
    apply();
  });
})();

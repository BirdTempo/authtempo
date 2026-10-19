import { base32Decode, totpCode } from "../core/primitives/totp.js";

let timer: number | null = null;

/**
 * The demo authenticator: it shows the current code of `secret`, the
 * secret of the setup answer. The code comes from core's own primitive
 * (deviation 4), the one that the server checks.
 */
export function startPanel(secret: string): void {
  const panel = document.getElementById("totp-panel");
  const code = document.getElementById("totp-code");
  const shown = document.getElementById("totp-secret");
  if (panel === null || code === null || shown === null) throw new Error("demo: no TOTP panel");
  const key = base32Decode(secret);
  shown.textContent = secret;
  panel.hidden = false;
  const tick = async () => {
    code.textContent = await totpCode(key, new Date());
  };
  if (timer !== null) clearInterval(timer);
  void tick();
  timer = setInterval(() => void tick(), 1000);
}

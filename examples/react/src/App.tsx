import { ERRORS, type ErrorCode, errorText, type OAuthClientCode } from "@authtempo/client";
import { type AuthErrorCode, useAuthError, useClient, useSession } from "@authtempo/react";
import { useState } from "react";

/**
 * The text of a redirect error. A code of core's table takes the core text.
 * Any other code is an OAuth code or `unexpected`, which the OAuth table
 * answers. `invalid_token` and `rate_limited` are in both tables, and a
 * redirect to this app carries the core one.
 */
function redirectText(code: NonNullable<AuthErrorCode>): string {
  return Object.hasOwn(ERRORS, code)
    ? errorText(code as ErrorCode)
    : errorText(code as OAuthClientCode, "oauth");
}

/**
 * A sign-in by email code with authtempo's React binding. The session store
 * reads the session again after the verify and after the sign-out, so the
 * page needs no refetch of its own.
 */
export function App() {
  const client = useClient();
  const session = useSession();
  const authError = useAuthError();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [failure, setFailure] = useState<string | null>(null);

  if (session.isPending) return <p>Loading</p>;
  if (session.data)
    return (
      <main>
        <p data-testid="who">{session.data.user.email}</p>
        <button
          type="button"
          onClick={async () => {
            await client.signOut();
            setFailure(null);
            // The next person starts at the email step.
            setStep("email");
            setCode("");
          }}
        >
          Sign out
        </button>
      </main>
    );
  return (
    <main>
      {authError && <p role="alert">{redirectText(authError)}</p>}
      {failure && <p role="alert">{failure}</p>}
      {step === "email" ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setFailure(null);
            const r = await client.emailOtp.request({ email });
            if (r.ok) setStep("code");
            else setFailure(errorText(r.code));
          }}
        >
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="username webauthn"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <button type="submit">Send a code</button>
        </form>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setFailure(null);
            const r = await client.emailOtp.verify({ email, code });
            if (!r.ok) setFailure(errorText(r.code));
          }}
        >
          <label>
            Code
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button type="submit">Sign in</button>
        </form>
      )}
    </main>
  );
}

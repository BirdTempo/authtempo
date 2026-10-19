/** A test identity of the demo provider. */
export interface Identity {
  subject: string;
  email: string;
  name: string;
}

/**
 * The three fixed test identities, by the value of their button. This module
 * has no Workers type, so the Node tests render the provider page with it.
 */
export const DEMO_IDENTITIES: Readonly<Record<string, Identity>> = Object.freeze({
  ada: { subject: "demo-ada", email: "ada@example.com", name: "Ada Lovelace" },
  grace: { subject: "demo-grace", email: "grace@example.com", name: "Grace Hopper" },
  alan: { subject: "demo-alan", email: "alan@example.com", name: "Alan Turing" },
});

/** The longest free address of the pick page. */
export const MAX_EMAIL = 254;

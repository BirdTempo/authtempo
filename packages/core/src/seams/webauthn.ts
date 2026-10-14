import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
};

export type PasskeyDeviceType = "singleDevice" | "multiDevice";

export interface StoredCredential {
  /** base64url credential id */
  id: string;
  /** COSE public key bytes */
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
}

export interface RegistrationOptionsInput {
  rpID: string;
  rpName: string;
  userID: Uint8Array;
  userName: string;
  userDisplayName: string;
  /** 32 random bytes from the engine. The options carry its base64url form. */
  challenge: Uint8Array;
  excludeCredentials: { id: string; transports: string[] | null }[];
}

export interface VerifyRegistrationInput {
  response: RegistrationResponseJSON;
  /** base64url, the same string the options carried */
  expectedChallenge: string;
  expectedOrigin: string[];
  expectedRPID: string;
}

export interface RegisteredPasskey {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
  deviceType: PasskeyDeviceType;
  backedUp: boolean;
}

export interface AuthenticationOptionsInput {
  rpID: string;
  challenge: Uint8Array;
  /**
   * The credentials that may answer (plan 12c): the user's passkeys for a
   * second-factor ceremony. Absent or empty for a sign-in, which takes any
   * discoverable credential.
   */
  allowCredentials?: { id: string; transports: string[] | null }[];
}

export interface VerifyAuthenticationInput {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  expectedOrigin: string[];
  expectedRPID: string;
  credential: StoredCredential;
}

export interface AuthenticatedPasskey {
  newCounter: number;
  deviceType: PasskeyDeviceType;
  backedUp: boolean;
}

/**
 * The one place that imports @simplewebauthn/server. The engine runs both
 * ceremonies through this interface, so a test injects a fake and a
 * replacement library plugs into the same four calls. Both ceremonies
 * require user verification; a passkey is a discoverable credential.
 */
export interface WebAuthnSeam {
  registrationOptions(
    input: RegistrationOptionsInput,
  ): Promise<PublicKeyCredentialCreationOptionsJSON>;
  /** Throws on any failure: challenge, origin, rpID, attestation, or key. */
  verifyRegistration(input: VerifyRegistrationInput): Promise<RegisteredPasskey>;
  authenticationOptions(
    input: AuthenticationOptionsInput,
  ): Promise<PublicKeyCredentialRequestOptionsJSON>;
  /** Throws on any failure, including a signature counter that does not advance. */
  verifyAuthentication(input: VerifyAuthenticationInput): Promise<AuthenticatedPasskey>;
}

export function createSimpleWebAuthnSeam(): WebAuthnSeam {
  return {
    registrationOptions(input) {
      return generateRegistrationOptions({
        rpID: input.rpID,
        rpName: input.rpName,
        userID: input.userID as Uint8Array<ArrayBuffer>,
        userName: input.userName,
        userDisplayName: input.userDisplayName,
        challenge: input.challenge as Uint8Array<ArrayBuffer>,
        attestationType: "none",
        excludeCredentials: input.excludeCredentials.map((c) => ({
          id: c.id,
          ...(c.transports ? { transports: c.transports } : {}),
        })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      });
    },
    async verifyRegistration(input) {
      const result = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.expectedRPID,
        requireUserVerification: true,
      });
      if (!result.verified) throw new Error("registration not verified");
      const info = result.registrationInfo;
      return {
        id: info.credential.id,
        publicKey: info.credential.publicKey,
        counter: info.credential.counter,
        transports: info.credential.transports ?? null,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
      };
    },
    authenticationOptions(input) {
      return generateAuthenticationOptions({
        rpID: input.rpID,
        challenge: input.challenge as Uint8Array<ArrayBuffer>,
        userVerification: "required",
        // The same mapping as `excludeCredentials` of the registration.
        allowCredentials: (input.allowCredentials ?? []).map((c) => ({
          id: c.id,
          ...(c.transports ? { transports: c.transports } : {}),
        })),
      });
    },
    async verifyAuthentication(input) {
      const result = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.expectedRPID,
        credential: {
          id: input.credential.id,
          publicKey: input.credential.publicKey as Uint8Array<ArrayBuffer>,
          counter: input.credential.counter,
          ...(input.credential.transports ? { transports: input.credential.transports } : {}),
        },
        requireUserVerification: true,
      });
      if (!result.verified) throw new Error("authentication not verified");
      const info = result.authenticationInfo;
      return {
        newCounter: info.newCounter,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
      };
    },
  };
}

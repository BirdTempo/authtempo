/**
 * The known-answer vectors of this package, exported as
 * `@tempo-auth/legacy-hashes/testing` so that other packages' tests use the
 * same Firebase project parameters and the same hashes (one source). They
 * are in `src` so that the build ships them in `dist/testing.js`. The
 * Firebase signer key is the public sample key of the firebase/scrypt README,
 * not a secret. The main entry does not import this file.
 *
 * Known-answer vectors, one per format. Each has its source; every one ran
 * on 2026-10-11 (plan 9b research, section 3, and the plan's own check).
 */
export const VECTORS = {
  // Go x/crypto/bcrypt TestBcryptingIsCorrect (bcrypt_test.go). Supabase hashes with this library.
  bcrypt2a: {
    password: "allmine",
    wrong: "allminE",
    stored: "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga",
  },
  // Clerk migration tool samples/clerk.csv: a real Clerk export row.
  bcrypt2b: {
    password: "Kk4aPMeiaRpAs2OeX1NE",
    wrong: "Kk4aPMeiaRpAs2OeX1Ne",
    stored: "$2b$10$U4C0ZY8OG8y41F9LusfKyu3HRMBL0rCZcKBVsXhgr.n8Ou6FPhzO2",
  },
  // @noble/hashes 2.4.0 argon2id and hash-wasm 4.12.0 argon2id gave the same
  // 32 bytes; hash-wasm's argon2Verify accepted this PHC string and refused
  // the wrong password (Node 26.10.0, 2026-10-11). Salt: "tempo-auth-salt!".
  argon2id: {
    password: "correct horse battery",
    wrong: "correct horse batterz",
    stored:
      "$argon2id$v=19$m=19456,t=2,p=1$dGVtcG8tYXV0aC1zYWx0IQ$3d3bfaojrW/Ap2grldDhnCuLyspXHQosopEJuHpTEnA",
  },
  // RFC 7914 section 11, second vector: P "Password", S "NaCl", c 80000, 64 bytes.
  pbkdf2: {
    password: "Password",
    wrong: "password",
    stored:
      "$pbkdf2-sha256$i=80000,l=64$TmFDbA$TdzY9guYviGDDO5e8icB+WQaRBjQTAQUrv8Ih2s0q1ah1CWhIlgzVJrbhBtRybMXaicr3ruh0HhHj2Kzl/M8jQ",
  },
  // RFC 7914 section 12, second vector: P "password", S "NaCl", N 1024, r 8, p 16, 64 bytes.
  scrypt: {
    password: "password",
    wrong: "Password",
    stored:
      "$scrypt$n=10,r=8,p=16$TmFDbA==$/bq+HJ00cgB4VucZDQHp/nxq18vII3gw53N2Y0s3MWIurzDZLiKjiG/xCSedmDDaxyevuUqD7m2DYMvfoswGQA==",
  },
  // firebase/scrypt README: the project parameters and one user. rounds 8 is r; mem_cost 14 is n.
  firescrypt: {
    password: "user1password",
    wrong: "user1passworD",
    stored:
      "$firescrypt$n=14,r=8,p=1$42xEC+ixf3L2lw==$lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==",
  },
} as const;

export const FIREBASE = {
  signerKey:
    "jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==",
  saltSeparator: "Bw==",
} as const;

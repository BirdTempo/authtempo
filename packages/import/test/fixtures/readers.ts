// The main export of each reader test (plan 11e Task 8). The reader tests
// and the MCP plan test read these values, so each fixture has one source.
// Each export keeps the comment on its source and the read date.

// Shapes: Clerk migration tool samples/clerk.csv and the Backend API spec 2026-05-12, read 2026-10-11.
// Unverified, checked by owner runbook item 3: the unit of created_at, the
// password_hasher values of a real export, and the banned field. Both
// milliseconds and seconds are here.
export const CLERK_CSV = `id,first_name,last_name,username,primary_email_address,primary_phone_number,verified_email_addresses,unverified_email_addresses,verified_phone_numbers,unverified_phone_numbers,totp_secret,password_digest,password_hasher
user_2a,Kim,Lee,,kim@example.com,,kim@example.com,,,,,$2b$10$U4C0ZY8OG8y41F9LusfKyu3HRMBL0rCZcKBVsXhgr.n8Ou6FPhzO2,bcrypt
user_2b,Max,,,max@example.com,,,max@example.com,,,,abc,md5
user_2c,Orphan,,,orphan@example.com,,orphan@example.com,,,,,,
`;
export const CLERK_USERS = JSON.stringify([
  {
    id: "user_2a",
    first_name: "Kim",
    last_name: "Lee",
    image_url: "https://img.clerk.com/kim",
    primary_email_address_id: "idn_1",
    email_addresses: [
      { id: "idn_1", email_address: "kim@example.com", verification: { status: "verified" } },
    ],
    external_accounts: [
      { provider: "oauth_google", provider_user_id: "g-77" },
      { provider: "oauth_github", provider_user_id: "gh-77" },
    ],
    passkeys: [{ id: "pk_1", name: "Laptop" }],
    password_enabled: true,
    created_at: 1700000000000,
  },
  {
    id: "user_2b",
    primary_email_address_id: "idn_2",
    // A verified secondary address first: only the primary one counts (review I-2).
    email_addresses: [
      { id: "idn_9", email_address: "old@example.com", verification: { status: "verified" } },
      { id: "idn_2", email_address: "max@example.com", verification: { status: "expired" } },
    ],
    external_accounts: [],
    password_enabled: true,
    created_at: 1700000001000,
  },
  // The CSV says user_2A is not user_2a: no case fold (Review Focus 5).
  {
    id: "user_2A",
    primary_email_address_id: null,
    email_addresses: [],
    password_enabled: true,
    created_at: 1,
  },
]);
export const CLERK_ORGS = JSON.stringify([
  {
    id: "org_1",
    name: "Acme",
    slug: "acme",
    created_at: 1700000002000,
    memberships: [
      { role: "org:admin", public_user_data: { user_id: "user_2a" } },
      { role: "org:billing", public_user_data: { user_id: "user_2b" } },
    ],
  },
  // No name: the reader passes no default, and the importer skips it (ruling I-5).
  {
    id: "org_2",
    slug: "nameless",
    created_at: 1700000003000,
    memberships: [{ role: "org:admin", public_user_data: { user_id: "user_2a" } }],
  },
]);

// Shapes: Auth0 user profile structure and the support article on the hash export, read 2026-10-11.
// Unverified, checked by owner runbook item 4: the hash algorithm, the hash
// file's field list, and whether user_id carries _id or alt_id. Every sample
// has $2b$10$, and the official docs never name it.
export const AUTH0_USERS = [
  {
    user_id: "auth0|o7p6",
    email: "ann@example.com",
    email_verified: true,
    created_at: "2023-05-01T10:00:00.000Z",
    name: "Ann",
    identities: [
      {
        provider: "auth0",
        user_id: "o7p6",
        connection: "Username-Password-Authentication",
        isSocial: false,
      },
    ],
  },
  {
    user_id: "google-oauth2|1035",
    email: "gus@example.com",
    email_verified: true,
    created_at: "2023-05-02T10:00:00.000Z",
    identities: [
      { provider: "google-oauth2", user_id: "1035", isSocial: true },
      { provider: "github", user_id: "99", isSocial: true },
    ],
  },
  {
    user_id: "auth0|b10c",
    email: "blocked@example.com",
    email_verified: true,
    blocked: true,
    identities: [],
  },
  { user_id: "auth0|e9e9", email: "eve@example.com", email_verified: false, identities: [] },
  // Two users that one hash line names, by _id and by alt_id (Review Focus 5).
  { user_id: "auth0|gg01", email: "gg01@example.com", email_verified: false, identities: [] },
  { user_id: "auth0|gg02", email: "gg02@example.com", email_verified: false, identities: [] },
]
  .map((u) => JSON.stringify(u))
  .join("\n");
export const AUTH0_HASH = "$2b$10$U4C0ZY8OG8y41F9LusfKyu3HRMBL0rCZcKBVsXhgr.n8Ou6FPhzO2";
export const AUTH0_HASHES = [
  { _id: { $oid: "o7p6" }, email: "ann@example.com", passwordHash: AUTH0_HASH },
  { _id: "e9e9", email: "mallory@example.com", passwordHash: AUTH0_HASH },
  { _id: "zz00", email: "nobody@example.com", passwordHash: AUTH0_HASH },
  { _id: "gg01", alt_id: "gg02", email: "gg01@example.com", passwordHash: AUTH0_HASH },
]
  .map((u) => JSON.stringify(u))
  .join("\n");
export const AUTH0_ORGS = JSON.stringify([
  {
    id: "org_a",
    name: "acme-co",
    display_name: "Acme Co",
    members: [
      { user_id: "auth0|o7p6", roles: [{ id: "rol_1", name: "owner" }] },
      { user_id: "auth0|e9e9", roles: [{ id: "rol_2", name: "Editor" }] },
      // A verified member with a role core does not name (review M-3).
      { user_id: "google-oauth2|1035", roles: [{ id: "rol_2", name: "Editor" }] },
    ],
  },
  // No display_name and no name: the reader passes no default (ruling I-5).
  { id: "org_b", members: [{ user_id: "auth0|o7p6", roles: [{ id: "rol_1", name: "owner" }] }] },
]);

// Fields: firebase-tools src/accountExporter.ts, read 2026-10-11. The user is the firebase/scrypt README vector.
// Unverified, checked by owner runbook item 5: the JSON type of createdAt and
// the { "users": [...] } wrapper. A digit string and a number are both here,
// and a bare array is tested too.
export const FIREBASE_LIST = [
  {
    localId: "fbuid1",
    email: "user1@example.com",
    emailVerified: true,
    passwordHash:
      "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==",
    salt: "42xEC+ixf3L2lw==",
    displayName: "User One",
    createdAt: "1600000000000",
    providerUserInfo: [
      { providerId: "apple.com", rawId: "001.apple" },
      { providerId: "facebook.com", rawId: "fb-1" },
    ],
  },
  {
    localId: "fbuid2",
    email: "off@example.com",
    emailVerified: true,
    disabled: true,
    createdAt: 1600000000000,
  },
  {
    localId: "fbuid3",
    email: "nopw@example.com",
    emailVerified: false,
    passwordHash: "",
    salt: "",
  },
];
export const FIREBASE_USERS = JSON.stringify({ users: FIREBASE_LIST });

// Columns: the Prisma schema of nextauthjs/next-auth main, read 2026-10-11.
export const AUTHJS_TABLES = JSON.stringify({
  users: [
    {
      id: "cuid1",
      name: "Ida",
      email: "ida@example.com",
      emailVerified: "2024-01-01T00:00:00.000Z",
      image: null,
      passwordHash: "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga",
    },
    { id: "cuid2", name: null, email: "jo@example.com", emailVerified: null, image: null },
  ],
  accounts: [
    { userId: "cuid1", type: "oidc", provider: "google", providerAccountId: "g-1" },
    { userId: "cuid1", type: "email", provider: "resend", providerAccountId: "ida@example.com" },
    { userId: "cuid2", type: "oauth", provider: "github", providerAccountId: "gh-2" },
  ],
  authenticators: [
    {
      credentialID: "AQID+/8=",
      userId: "cuid1",
      providerAccountId: "x",
      // Canonical standard base64, as Auth.js writes it (review M-3).
      credentialPublicKey: "pQECAyYgASFYIPv/",
      counter: 4,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      transports: "internal,hybrid",
    },
    // The unverified user's passkey: the importer drops and lists it (review M-2).
    {
      credentialID: "BAUG",
      userId: "cuid2",
      providerAccountId: "y",
      credentialPublicKey: "pQECAyYgASFYIPv/",
      counter: 0,
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
      transports: null,
    },
  ],
});

// Fields: the ListUsers API reference, read 2026-10-11.
// Unverified, checked by owner runbook item 6: that Cognito exports no
// password hash, and the shape of the identities attribute. The reference
// shows no hash, so every password user gets the marker. An unreadable
// identities attribute is dropped and listed: user "fed-bad".
export const COGNITO_USERS = JSON.stringify({
  Users: [
    {
      Username: "c0ffee",
      Attributes: [
        { Name: "sub", Value: "sub-1" },
        { Name: "email", Value: "cara@example.com" },
        { Name: "email_verified", Value: "true" },
      ],
      UserCreateDate: 1700000000.5,
      Enabled: true,
      UserStatus: "CONFIRMED",
    },
    {
      Username: "Google_123",
      Attributes: [
        { Name: "sub", Value: "sub-2" },
        { Name: "email", Value: "gail@example.com" },
        { Name: "email_verified", Value: "false" },
        { Name: "identities", Value: '[{"providerName":"Google","userId":"123"}]' },
      ],
      UserCreateDate: "2023-11-14T22:13:20.000Z",
      Enabled: true,
      UserStatus: "EXTERNAL_PROVIDER",
    },
    {
      Username: "off",
      Attributes: [
        { Name: "sub", Value: "sub-3" },
        { Name: "email", Value: "off@example.com" },
      ],
      Enabled: false,
      UserStatus: "CONFIRMED",
    },
    {
      Username: "fed-bad",
      Attributes: [
        { Name: "sub", Value: "sub-4" },
        { Name: "email", Value: "fed@example.com" },
        { Name: "identities", Value: "not json" },
      ],
      Enabled: true,
      UserStatus: "EXTERNAL_PROVIDER",
    },
  ],
});

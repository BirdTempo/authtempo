/**
 * What the Supabase fixture (supabase-users.csv, supabase-identities.csv)
 * creates with every format and no Firebase project: seven users, nine
 * identities, two passwords (ada and bob, bcrypt). The fbscrypt row of fire
 * and the argon2i string are refused. One constant, so the storage matrix
 * and the CLI test pin the same counts.
 */
export const SUPABASE_FIXTURE_CREATED = { user: 7, identity: 9, password: 2 } as const;

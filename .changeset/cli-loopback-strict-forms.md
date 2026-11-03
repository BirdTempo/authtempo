---
"@authtempo/cli": patch
---

The transport rule of `migrate` and `check` now reads a host with a tab, LF, or CR as no loopback host. mysql2 decodes such a character in the URL, such as `%09` in `mysql://u:p@%3A%3A%091/db`. That host now needs TLS, as any other remote host does.

An IPv4 address with a leading zero in an octet, such as `127.0.0.08`, is no loopback host either. Such a host needs TLS too.

---
"@authtempo/cli": patch
---

The transport rule of `migrate` and `check` now reads each form of the IPv6 loopback address `::1` as a loopback host. A libSQL URL such as `http://[0:0:0:0:0:0:0:1]:8080` no longer needs TLS. Another IPv6 address still needs TLS, and so does an IPv4-mapped address such as `::ffff:127.0.0.1`.

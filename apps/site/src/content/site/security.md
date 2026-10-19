---
title: Security
description: How authtempo keeps a secret, and how to report a fault.
page: /security/
---

authtempo stores a hash of each token, never the token.

Every secret compare is constant time. Every random value comes from the platform's random source.

An app lists each trusted origin exactly. A request from another origin gets 403 on each route that changes state.

## Read more

## Report a fault

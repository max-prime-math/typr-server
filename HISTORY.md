# Repository history

Typr Companion was developed inside
[`max-prime-math/typr`](https://github.com/max-prime-math/typr) through release
`v0.1.1`. This repository was split from Typr's `dev` lineage on 2026-08-09 with
the server, protocol, container, test, documentation, Compose, and Unraid paths
retained.

History filtering necessarily rewrote commit object IDs. The release-relevant
mapping is:

| Typr commit | Standalone commit | Change |
| --- | --- | --- |
| `52c5647f4182d2558af137afc40ec61c0517137c` | `f9abc8877b0c635a2e718abedd7a8393be11341c` | Initial Companion Docker release pipeline (`v0.1.0` in Typr) |
| `67c6327c6898138fd339f8f62152d611489e7a66` | `f6baa0d5743b41605eb4d34578a0ca51c8475a88` | Release channels, publishing, and CORS |
| `37ad4b2b478c7f84bca81517a1cb8e5b41c574fa` | `5f1507338d2a0ccd5d3eaf836b54b88cdba57335` | Docker and Unraid distribution (`v0.1.1` in Typr) |
| `bca5c310414ae11dec6fd233d671432e5226899d` | `2d2a536086221533d751f9ae8b974d9a24f81cb1` | Latest pre-split TeXpresso rendering change |

The annotated `v0.1.0` and `v0.1.1` tags remain unchanged in the Typr
repository. They were intentionally not copied here because their historical
workflow could republish mutable aliases in the existing
`ghcr.io/max-prime-math/typr-server` package. The first standalone release tag
is `v0.1.2`, created only after standalone validation.

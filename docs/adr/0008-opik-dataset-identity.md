# 0008. Verify native Opik dataset ownership before reuse

**Status** Accepted

This extends [ADR 0002](0002-opik-and-offline-runs.md) for multiple local profiles sharing an Opik deployment, including the [self-hosted service](0004-local-opik-service.md).

## Decision and evidence

Two fresh profiles assigned different native IDs to the same synthetic Manufacturing family. The self-hosted service returned HTTP 409 because the name already existed in another project. A lookup by name returned that other project's dataset even when the caller supplied the intended project name. DASH now checks the native project ID before binding a family. Newly created datasets carry a full family fingerprint and a source fingerprint. Their names include the destination and origin in a deterministic suffix, allowing concurrent first publishers to converge.

A saved binding keeps the native dataset ID across a rename. A fresh profile can find a renamed dataset by its family and source tags. It can also recognize an earlier version by its exact snapshot or an explicitly linked parent when the native record supplies enough evidence to verify the family and project. The self-hosted service can omit version metadata while retaining the full DASH snapshot tag. For an unmarked legacy dataset, that tag and the original family name can establish ownership in the intended project. An empty source label alone supplies no lineage. A fresh profile cannot safely attach to a renamed, unmarked legacy family if both the prior UUID and corroborating version metadata are unavailable. A conflicting or ambiguous dataset stays untouched.

The regression uses independent SQLite profiles with the official SDK and a service that enforces workspace-wide name uniqueness. A live read-only check separately recovered the existing tagged and legacy Manufacturing dataset IDs in their respective local projects. Both completed synthetic experiments retained their dataset versions and case feedback on repeated synchronization.

## Alternatives and consequences

Looking up datasets by display name alone can attach a run to a different project. Always allocating a new dataset loses the relationship between versions. Resolve the native identity from verifiable project and family evidence. A historical dataset with insufficient evidence can remain separate until an authorized operator establishes its identity. [Implementation and live verification](https://github.com/niksacdev/dash/pull/10)

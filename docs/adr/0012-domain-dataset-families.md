# 0012. Scope local dataset families to a domain and scenario

**Status** Accepted

This extends [the domain hierarchy](0001-domain-workbench.md) and the [native Opik ownership policy](0008-opik-dataset-identity.md). Financial Services and Manufacturing teams can both call a family “Operator QA”. Their local versions and parent selectors need separate histories.

Include normalized industry, scenario and family in the local identity. Validate the selected parent within that scope and require unique versions within a split. Migrate catalog metadata transactionally without reopening case payloads or changing existing immutable IDs. Preserve old recorded links for audit. For newly imported versions, only admit a parent from the correct domain and scenario.

A global family name would require unrelated teams to coordinate naming. Rewriting historical lineage during migration would change the evidence behind existing runs. The chosen policy preserves current snapshots and applies domain constraints to new entries. [Operator guide](../guides/workbench.md)

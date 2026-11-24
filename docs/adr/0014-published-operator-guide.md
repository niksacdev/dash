# 0014. Publish the operator guide from main

**Status** Accepted

Nik requested an always-current public reader for operators. A quality engineer evaluating incoming parts should be able to choose a workflow, import two labeled cases, attach a grader, and find the evidence behind a disposition. This extends the [main-branch review policy](0009-main-pr-target.md) to operator documentation.

We chose GitHub Pages with mdBook and the reviewed Markdown chapters as the source. It provides static navigation, local search and themes without adding dependencies to Electron. Sending readers to the engineering index would mix operator tasks with design history. Publishing the full docs tree would also include archived prototypes. Only the curated reader build is deployed.

A PR builds and checks public paths. Each push to main republishes the site. Maintainers update affected chapters, verify the deployed URL and keep repository labels linked in the README. The publication is independent of desktop release tags. A pinned documentation compiler adds a contributor tool for local previews. [Operator guide maintenance](../reader/README.md) · [Pages deployment policy](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

Acceptance includes a no-model first run, a valid downloadable example that imports under the stated scenario, accessible mobile navigation, and working deep links under the repository’s Pages path. The existing Opik guide remains the setup reference. The reader explains when to sync and the scope of the saved evidence.

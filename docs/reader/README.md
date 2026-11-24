# Maintain the operator guide

The [published reader](https://niksacdev.github.io/dash/) helps a first-time DASH operator choose an evaluation workflow. Edit the task chapters in [src](src/) and keep the [chapter list](src/SUMMARY.md) in reading order. The downloadable two-case dataset is also the source for the inline example. Engineering records and archived designs live in the [repository documentation index](../START_HERE.md).

## Preview a change

Install Node.js 22.13 or later and [mdBook 0.5.4](https://github.com/rust-lang/mdBook/releases/tag/v0.5.4). Put the executable on your PATH or set `MDBOOK` to its path. From the repository root:

```sh
npm --prefix dash-desktop run docs:check
node --experimental-strip-types docs/reader/build.mts
```

Open `dist/reader/index.html` for a quick read or serve the directory under `/dash/` on a local HTTP server to check navigation, deep links, search and downloads. Test a narrow viewport and keyboard navigation after changing layout. The build uses the Markdown chapters, their listed example, the project notices and the bundled circuit artwork. It checks generated chapter links, fragments and assets. Keep private run data outside the source directory.

## Publish a change

Submit a PR against `main`. Update the relevant instructions whenever an operator-visible workflow changes, and verify the example using the current UI or a synthetic test. The **Operator guide** workflow builds on PRs and publishes on every push to `main`. In GitHub, **Settings → Pages → Source** must be **GitHub Actions** and the **github-pages** environment must allow deployment from `main`.

GitHub queues up to 100 pending publications per branch. If the queue fills, check that the current main revision deployed and rerun its workflow if needed. [GitHub workflow queues](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

After merging, check **Actions → Operator guide** for the merged commit. Open the affected published chapter from its direct URL and follow a link or download. To retry a failed publication, rerun the failed job for the current `main` revision. Publishing documentation does not create a desktop release or version tag.

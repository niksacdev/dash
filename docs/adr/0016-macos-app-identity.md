# 0016. Give the local macOS app its DASH identity

**Status** Accepted

Nik requested the existing DASH mark, name and tagline on the Mac app. Running the stock Electron executable can show the development shell’s identity in Finder even when the renderer has a product title. This extends [the Electron desktop decision](0003-typescript-runtime.md).

Use the same DASH mark for the workbench, running Dock icon and Finder launcher icon. Show **DASH — Domain Assessment & Scoring Harness** as the window title. The native About panel includes the version and “Turn a business outcome into a scored model run.” Keep the existing product name, profile selection and single-instance lock so existing evaluations stay accessible.

Use a small Finder launcher built with macOS tools. It carries the DASH name and icon and points at the checkout. Sign the launcher locally with hardened runtime enabled and leave the installed Electron runtime exactly as provided. The running Electron process sets its Dock image and About panel. Rebuild the launcher after moving the checkout. A standalone app for distribution with its own signed Electron runtime requires a separate signing and release decision.

During verification, a renamed ad-hoc Electron bundle passed signature inspection but macOS rejected the framework at launch because its Team ID did not match. Check the actual launch path as well as the bundle identity. [Electron distribution guide](https://www.electronjs.org/docs/latest/tutorial/application-distribution) · [Local setup](../reader/src/first-run.md)

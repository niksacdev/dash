# Start with a recorded case

Use the bundled earnings example to see a failure your team would care about. On a fresh workspace, this walkthrough works without a model, an API key or an Opik server.

## Open the desktop app

Install Git, Node.js 22.13 or later, and npm. From a terminal, run:

```sh
git clone https://github.com/niksacdev/dash.git
cd dash/dash-desktop
npm ci
npm start
```

The initial install needs an internet connection. DASH has been exercised on Apple Silicon macOS. If you already have a checkout, run `npm start` from its `dash-desktop` directory.

### Open DASH from Finder on macOS

After `npm ci`, double-click **Open DASH.command** in `dash-desktop/`. It builds the workbench and opens a local **DASH.app** launcher. To build without opening a window, run `npm run package:mac`. The launcher is in the repository’s `dist/macos/` directory. Keep the checkout and its dependencies on this Mac. Rebuild the launcher if you move the checkout or update DASH.

Finder shows the red D launcher. The running workbench uses the same Dock mark, the title **DASH — Domain Assessment & Scoring Harness**, and the tagline in **About DASH**. The launcher starts the installed Electron development runtime, which macOS may identify as Electron in system tools. Both launch methods use the existing DASH profile.

## Find an incorrect earnings figure

1. Open **Dataset run** and choose **Earnings release capture**.
2. Expand **Test the scenario grader with saved answers** and choose **Replay saved answers**. DASH scores eight bundled synthetic cases. An existing workspace can also have a model-backed grader enabled by default.
3. Under **Cases**, open **eps-gaap**. The source lists diluted GAAP EPS of **0.74** and adjusted diluted EPS of **0.85**. The recorded response selected **0.85** for a request that specified GAAP.
4. Read the expected answer, the recorded output and the grader’s explanation. The answer contains a figure from the release and still fails the requested accounting basis.

Replay exercises the grader with recorded outputs. To measure model latency, tokens or power, [connect a model](models.md) and [start a live dataset run](dataset-runs.md).

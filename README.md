# Patient Dispatch Planner

**English** | [Français](docs/README.fr.md)

Patient Dispatch Planner is a local-first desktop app for Windows, macOS, and Linux x64. It helps maternity-care coordinators prepare draft patient assignments to midwife teams. A coordinator can divide each expected delivery month into one to four cohorts. A coordinator must review the recommendation. The app does not make a final assignment.

The app uses Go, React, TypeScript, and Wails. The React interface runs in the desktop WebView. A local Go service validates inputs, requests route times on demand, and runs the assignment optimizer on the device.

## How it works

- Configure midwife teams, their members and locations, and minimum/maximum cohort capacities.
- Split a delivery month into cohorts. Enter patient locations, parity, and PEC 100% eligibility. If you confirm a replacement split, the app deletes the existing cohorts and their history.
- When a coordinator starts a calculation, the app sends team-member and patient locations to Google Routes API. It compares bicycle and transit travel times. It does not send names, parity, capacities, or assignment data to Google.
- The Go optimizer distributes PEC 100% eligible patients across active teams. Their counts differ by at most one. The optimizer respects capacities and considers travel times and parity. Coordinators can review the explanation and make manual changes that preserve these constraints.
- The app stores team and cohort records in the desktop WebView’s local IndexedDB. You can export them as JSON or delete them in the app. The operating system’s credential store holds Google API keys.

The release app has no remote application server, cloud database, analytics, or telemetry. Route calculation is an exception to local processing. Google receives the locations and request metadata under the terms for the API key’s project. The app keeps Google route results in memory, not in the local database. The app does not encrypt local browser storage.

**Use synthetic records until your organization’s privacy/legal review and Google Maps Platform terms review approve real-data use.** See the [French data-processing and privacy notes](docs/traitement-des-donnees.md).

## Installation

Download the latest version from [GitHub Releases](https://github.com/xavierfnk/ak-dispatch/releases/latest). Only open a file if you trust its source and expect to install it.

- **Windows:** Download `patient-dispatch-planner-windows-x64.exe`. Create `%LOCALAPPDATA%\Programs\Patient Dispatch Planner`, move the file there, rename it `patient-dispatch-planner.exe`, and open it. If SmartScreen warns that the app is unrecognized, select **More info → Run anyway** if you trust the file.
- **macOS:** Download the `macos-arm64` ZIP for Apple silicon or `macos-x64` ZIP for Intel. Unzip it and move `patient-dispatch-planner.app` to `~/Applications` (create the folder if needed), then open it. If macOS blocks the app, open **System Settings → Privacy & Security**, select **Open Anyway**, and confirm. See [Apple's instructions](https://support.apple.com/en-us/102445).
- **Linux x64:** On Ubuntu 24.04, install the runtime with `sudo apt install libwebkitgtk-6.0-4` and use a desktop session with an unlocked Secret Service keyring for the API key. Download `patient-dispatch-planner-linux-x64`, then install it as your normal user (replace `~/Downloads` if needed):

  ```sh
  mkdir -p ~/.local/bin
  install -m 755 ~/Downloads/patient-dispatch-planner-linux-x64 ~/.local/bin/patient-dispatch-planner
  ~/.local/bin/patient-dispatch-planner
  ```

  Keep the executable at this path and the directory writable by your user for in-place updates. Do not run it with `sudo`: local data and credentials belong to your desktop account. The binary is built on Ubuntu 24.04; other distributions or older releases may lack compatible libraries.

The Windows executable is unsigned. The macOS app is not Developer ID signed or notarized. These warnings are expected. Managed devices may not allow an override. Contact your administrator rather than disabling security protections. The app can install updates in these locations if your user account can write to the folder.

## Development

Requirements: Go version specified in `server/go.mod`, Node.js 22, Task (optional), and the Wails v3 platform prerequisites. On macOS install Xcode Command Line Tools. On Windows, WebView2 is included with Windows 10/11. On Ubuntu 24.04 install `libgtk-4-dev` and `libwebkitgtk-6.0-dev` and a C compiler.

Install the Wails CLI and start the desktop app in development mode:

```sh
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0
task dev
```

To build a packaged desktop app, run `task build`. To run the checks and build:

```sh
task check
```

For individual Go checks, run `cd server && go test ./... && go vet ./...`. For a frontend-only build, generate Wails bindings first from `server/cmd/desktop` with `wails3 generate bindings -clean -ts`, then run `cd web && npm ci && npm run build`. The frontend source is in `web/`; Wails generates bindings and embeds the production frontend during packaging. Build outputs and generated bindings are ignored by Git.

## Google Routes API key

Each user supplies their own Google Maps Platform API key in **Configuration**. Enable Routes API and restrict the key to that API. Set project quotas and billing alerts. The operating system’s credential store holds the key. The app does not store it in IndexedDB or include it in exports. Do not put a personal API key in source code or a public desktop binary.

## Releases

Pushing a version tag such as `v0.1.0` runs the GitHub Actions release workflow for Linux x64, Windows x64 and macOS arm64/x64. Linux is a standalone executable, macOS assets are zipped `.app` bundles, and Windows is a `.exe`. macOS bundles are not Developer-ID signed or notarized, so operating-system warnings may appear when opening them.

To update the app, open **Configuration → Mises à jour** and check for updates. Choose **Installer et redémarrer**. The app downloads updates from this repository's GitHub Releases. It checks GitHub's SHA-256 asset digest and verifies a detached Ed25519 signature before replacing itself.

Before publishing releases, configure the updater signing keys in GitHub Actions: generate an Ed25519 key with `openssl genpkey -algorithm Ed25519 -out update-private.pem`; set the `UPDATE_SIGNING_PRIVATE_KEY` Actions secret to that PEM file, and set the `UPDATE_SIGNING_PUBLIC_KEY` repository variable to `$(openssl pkey -in update-private.pem -pubout -outform DER | tail -c 32 | base64 | tr -d '\n')`. Keep the private key out of the repository. Each release asset is signed, and the app verifies that signature before replacing itself.

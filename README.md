# Patient Dispatch Planner

**English** | [Français](docs/README.fr.md)

Patient Dispatch Planner is a local-first Windows/macOS desktop tool for helping maternity-care coordinators prepare draft assignments of patients to midwife teams. Each expected delivery month can be divided into one to four cohorts. The result is a recommendation for a coordinator to review—not an automatic or final assignment.

The app is built with Go, React, TypeScript, and Wails. The React interface runs in the desktop WebView, while a local Go service validates inputs, requests route times when asked, and runs the assignment optimizer on the device.

## How it works

- Configure midwife teams, their members and locations, and minimum/maximum cohort capacities.
- Split a delivery month into cohorts, then enter patient locations, parity and PEC 100% eligibility. Replacing an existing split deletes its cohorts and history after confirmation.
- When a coordinator explicitly starts a calculation, the app sends the team-member and patient locations to Google Routes API to compare bicycle and transit travel times. Names, parity, capacities, and assignment data are not sent to Google.
- The Go optimizer balances PEC 100% eligible patients across active teams (counts differ by at most one), while respecting capacities and considering route times and parity. Coordinators can review the explanation and make manual changes that preserve these constraints.
- Team and cohort records are stored in the desktop WebView’s local IndexedDB. They can be exported as JSON or deleted in the app. Google API keys are stored in the operating system’s credential store.

The release app has no remote application server, cloud database, analytics, or telemetry. Route calculation is the exception to local-only processing: Google receives the submitted locations and request metadata and handles them under the terms for the API key’s project. Route results for real Google calculations are held in app memory and are not saved in the local database. Local browser storage is not application-level encryption.

**Use synthetic records until your organization’s privacy/legal review and Google Maps Platform terms review approve real-data use.** See the [French data-processing and privacy notes](docs/traitement-des-donnees.md).

## Development

Requirements: Go version specified in `server/go.mod`, Node.js 22, Task (optional), and the Wails v3 platform prerequisites. On macOS install Xcode Command Line Tools. On Windows, WebView2 is included with Windows 10/11.

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

Each user supplies their own Google Maps Platform API key in **Configuration**. Enable Routes API, restrict the key to that API, and set project quotas and billing alerts. The key is stored in the operating system’s credential store; it is not stored in IndexedDB or included in exports. Do not put a personal API key in source code or a public desktop binary.

## Releases

Pushing a version tag such as `v0.1.0` runs the GitHub Actions release workflow for Windows x64 and macOS arm64/x64. macOS assets are zipped `.app` bundles; Windows is a `.exe`. macOS bundles are not Developer-ID signed or notarized, so operating-system warnings may appear when opening them.

For in-app updates, install the Windows executable at `%LOCALAPPDATA%\Programs\Patient Dispatch Planner\patient-dispatch-planner.exe` (rename the downloaded release asset to `patient-dispatch-planner.exe`) or place the unzipped macOS app at `~/Applications/patient-dispatch-planner.app`. In **Configuration → Mises à jour**, check for updates and choose **Installer et redémarrer**. Updates are downloaded from this repository's GitHub Releases; the app checks GitHub's SHA-256 asset digest and verifies a detached Ed25519 signature before replacing itself. The app folder must be writable by the current user.

Before publishing releases, configure the updater signing keys in GitHub Actions: generate an Ed25519 key with `openssl genpkey -algorithm Ed25519 -out update-private.pem`; set the `UPDATE_SIGNING_PRIVATE_KEY` Actions secret to that PEM file, and set the `UPDATE_SIGNING_PUBLIC_KEY` repository variable to `$(openssl pkey -in update-private.pem -pubout -outform DER | tail -c 32 | base64 | tr -d '\n')`. Keep the private key out of the repository. Each release asset is signed, and the app verifies that signature before replacing itself.

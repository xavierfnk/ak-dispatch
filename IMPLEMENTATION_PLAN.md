# Desktop implementation

The app is packaged with Wails v3. React, TypeScript, Vite, Dexie/IndexedDB, the Go dispatch optimizer, and the Go Google Routes client remain in use.

## Runtime

- Wails serves the embedded frontend in the system WebView and binds `PlannerService` directly to the UI. The app starts no localhost or remote application server.
- The optimizer and assignment calculation run in Go on the device.
- A user supplies their own Google Maps API key in Configuration. The key is kept in the OS credential store and is passed only to the local Go Routes client.
- The only app network calls are Google Routes API requests made after the user starts a calculation. Address entry has no Places autocomplete. Route results remain in memory.
- IndexedDB contains local team/cohort data; JSON export and local deletion remain available.

## Build and release

Run `wails3 dev -config ./build/config.yml` or `wails3 package` from `server/cmd/desktop`. Wails builds the Vite frontend, copies the static assets into the Go embed directory, generates bindings, and packages the desktop app. `task dev`, `task build`, and `task check` wrap these commands.

Pushing a `v*` tag runs the GitHub Actions release workflow for Windows x64 and macOS arm64/x64. Releases include a Windows executable and zipped macOS application bundles. Signing and notarization are optional release credentials and are not embedded in source or build configuration.

## Data-use gate

The app is local-first, but route calculations disclose origin/destination locations to Google Routes. The local optimizer, Dexie database, and export workflow do not change Google’s processing, applicable Maps terms, or the existing privacy/legal review requirement. Continue to use synthetic data until that gate is cleared.

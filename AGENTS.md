# Repository guide

Patient Dispatch Planner is a local-first desktop application for preparing draft patient-to-midwife-team assignments by delivery-month cohort. It is built with a Go service and optimizer, a React/TypeScript UI, and Wails v3.

## Project layout

- `server/cmd/desktop/`: Wails application entry point, frontend bindings, and packaging configuration.
- `server/internal/dispatch/`: request validation, route-provider interface, scoring, and local assignment optimizer.
- `server/internal/googlemaps/`: Google Routes API client; it receives route requests from the local Go service.
- `web/`: React UI, TypeScript models and validation, and Dexie/IndexedDB persistence.
- `docs/`: French user-facing project and data-processing documentation.

Wails binds the frontend directly to the local Go service; the release application does not run an application HTTP server. The optimizer runs on-device. The browser database stores the editable team/cohort data and local simulation history. Google API keys use the operating system credential store.

## Build, run, and test

Requirements: Go version from `server/go.mod`, Node.js 22, Wails v3 CLI, and platform prerequisites (Xcode Command Line Tools on macOS; WebView2 on Windows). Install frontend dependencies with `cd web && npm ci`.

- `task dev`: run the Wails desktop app with frontend hot reload.
- `task build`: package the desktop app for the current platform.
- `task test`: run `go test ./...` in `server/`.
- `task vet`: run `go vet ./...` in `server/`.
- `task check`: run tests, vet, and a desktop package build (including the strict TypeScript check and Vite build).
- For a frontend-only production/type check, first run `wails3 generate bindings -clean -ts` from `server/cmd/desktop`, then `cd web && npm run build`.

Go source should be formatted with `gofmt`. TypeScript uses the strict compiler settings in `web/tsconfig.json`; keep `npm run build` passing. Use the existing dependencies and project patterns rather than adding a library for a small utility.

## Architectural and data boundaries

- Keep patient/member names and stable browser IDs in the frontend. Calculation requests use request-scoped tokens; do not add names, parity, capacities, or assignment data to Google requests.
- Google receives locations only after an explicit route calculation. Do not introduce address autocomplete or other network calls without updating the privacy documentation and review requirements.
- Google route results are held in app memory rather than persisted. Do not change this retention behavior without checking the applicable Maps terms and updating `docs/traitement-des-donnees.md`.
- Persistent browser data changes may require a Dexie schema migration or a safe migration in the app’s existing startup migration path. Preserve user data when changing stored shapes.
- Wails bindings, `web/dist/`, `server/cmd/desktop/frontend/dist/`, binaries, and task caches are generated build artifacts; edit their source files, not the generated copies.
- Assignment results are drafts for human review. Preserve capacity validation and explicit unresolved/infeasible states.

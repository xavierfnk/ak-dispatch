# Repository guide

Patient Dispatch Planner is a local-first web application for preparing draft patient-to-midwife-team assignments by delivery-month cohort. It is built with React and TypeScript and runs entirely in the browser.

## Project layout

- `web/src/dispatch/`: request validation, scoring, branch-and-bound optimizer, and Google Routes client.
- `web/src/`: React UI, TypeScript models and validation, Dexie/IndexedDB persistence, and API-key storage.
- `docs/`: French user-facing project and data-processing documentation.

The app is served as static files; there is no application server. The TypeScript calculation module runs the optimizer and route lookup in the browser. The browser database stores the editable team/cohort data and local simulation history. The Google API key is stored in browser local storage.

## Build, run, and test

Requirements: Node.js 22. Install dependencies with `cd web && npm ci`.

- `task dev`: run Vite with frontend hot reload.
- `task test`: run the frontend and calculation tests.
- `task build`: type-check and build the static site in `web/dist`.
- `task check`: run tests and the production build.

Without Task, run `cd web && npm run dev`, `npm test`, or `npm run build`. TypeScript uses the strict compiler settings in `web/tsconfig.json`; keep `npm run build` passing. Use the existing dependencies and project patterns rather than adding a library for a small utility.

## Architectural and data boundaries

- Keep patient/member names and stable browser IDs in the frontend. Calculation requests use request-scoped tokens; do not add names, parity, capacities, or assignment data to Google requests.
- Google receives locations only after an explicit route calculation. Do not introduce address autocomplete or other network calls without updating the privacy documentation and review requirements.
- Google route results are held in app memory rather than persisted. Do not change this retention behavior without checking the applicable Maps terms and updating `docs/traitement-des-donnees.md`.
- The Google API key lives in browser local storage. Do not add it to IndexedDB, exports, or Google requests' local metadata. Anyone with access to the browser profile can read it; keep the UI and docs clear about restricting the key.
- Persistent browser data changes may require a Dexie schema migration or a safe migration in the app’s existing startup migration path. Preserve user data when changing stored shapes.
- `web/dist/` and task caches are generated build artifacts; edit their source files, not the generated copies.
- Assignment results are drafts for human review. Preserve capacity validation and explicit unresolved/infeasible states.

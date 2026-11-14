# Patient Dispatch Planner

**English** | [Français](docs/README.fr.md)

Patient Dispatch Planner is a local-first web app for preparing draft patient assignments to midwife teams. It helps maternity-care coordinators divide each expected delivery month into one to four cohorts. A coordinator must review the recommendation. The app does not make a final assignment.

The app uses React and TypeScript. It runs entirely in the browser. The calculation module validates inputs, requests route times on demand, and runs the assignment optimizer in the page. The only network request during planning goes to Google Routes API, after an explicit calculation.

## How it works

- Configure midwife teams, their members and locations, and minimum/maximum cohort capacities.
- Split a delivery month into cohorts. Enter patient locations, parity, and PEC 100% eligibility. If you confirm a replacement split, the app deletes the existing cohorts and their history.
- When a coordinator starts a calculation, the app sends team-member and patient locations to Google Routes API. It compares bicycle and transit travel times. It does not send names, parity, capacities, or assignment data to Google.
- The optimizer distributes PEC 100% eligible patients across active teams. Their counts differ by at most one. The optimizer respects capacities and considers travel times and parity. Coordinators can review the explanation and make manual changes that preserve these constraints.
- The app stores team and cohort records in the browser's IndexedDB. You can export them as JSON or delete them in the app. The Google API key is stored in the browser's local storage. It is not included in exports.

The deployed app has no application server, cloud database, analytics, or telemetry. Route calculation is an exception to local processing. Google receives the locations and request metadata under the terms for the API key's project. The app keeps Google route results in memory, not in the local database; they are lost when the page reloads. The app does not encrypt browser storage. Anyone with access to the browser profile can read the API key, so restrict it to the Routes API and to the app's origin in Google Cloud.

**Use synthetic records until your organization's privacy/legal review and Google Maps Platform terms review approve real-data use.** See the [French data-processing and privacy notes](docs/traitement-des-donnees.md).

## Using the app

The app is a static site. Open the deployed URL, or build `web/dist` and serve it from any static host. If GitHub Pages is enabled for this repository with **GitHub Actions** as the source, the deploy workflow publishes the app on pushes to `main`.

## Development

Requirements: Node.js 22 and optionally Task. Install dependencies with `cd web && npm ci`.

- `task dev`: run Vite with frontend hot reload.
- `task test`: run the frontend and calculation tests.
- `task build`: type-check and build the static site in `web/dist`.
- `task check`: run tests and the production build.

Without Task, run `cd web && npm run dev`, `npm test`, or `npm run build`. The frontend and calculation source are in `web/`; the optimizer is in `web/src/dispatch/`.

## Google Routes API key

Each user supplies their own Google Maps Platform API key in **Configuration**. Enable Routes API and restrict the key to that API and to the deployed origin (HTTP referrer). Set project quotas and billing alerts. The browser stores the key in local storage; it is not stored in IndexedDB or included in exports. Do not put a personal API key in source code or a public repository.

## Deployment

`web/dist` is a static bundle. The included GitHub Actions workflow builds the frontend and deploys the bundle to GitHub Pages. Any static host works.

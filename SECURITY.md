# Miyar security summary

For IT security and compliance review. Version **1.5.0** (git tag `v1.5.0`; 1.0.0 is commit 317134e).

## What to deploy

Use the **secured build** in [`secure/`](secure/). It is the same app as `index.html`, with every library and font included in the folder and a strict security policy added. The public copy on GitHub Pages is for evaluation only. For confidential data, host `secure/` (or the Docker image, which contains it) on your own servers.

| | Standard `index.html` | Secured `secure/` |
|---|---|---|
| Libraries and fonts | from cdnjs.cloudflare.com and Google Fonts | included, served from its own folder |
| Other sites the page may contact | any HTTPS site (for a gateway) | **none**: only the site it is served from |
| Library tampering check | none | SHA-384 integrity on every library |
| File list and hashes | none | `SHA256SUMS`, `build.json` |

## Where the data goes

- **Imported files** (Excel, CSV, JSON, PDF) are read **inside the browser**. Nothing is uploaded, and nothing is sent to Anthropic, Microsoft or any analytics service. *Ask Sahil* answers questions with code that runs in the page; it is not an online AI service.
- **Without a server**, reports and data are kept in the browser's local storage (`miyar-v2`) on that computer. That storage is **not encrypted**, and it stays until **Start over** is used or browser data is cleared. Do not use the browser-only mode on shared computers for sensitive data.
- **What changed snapshots** are kept in the browser's local storage (`miyar-snaps-v1`), with or without a server. They hold only aggregate figures: report totals, monthly values, and figures per breakdown value, which can include names such as employee names with their own figures. They never hold the rows. Up to 30 are kept per report; **Start over** or **Delete all snapshots** removes them.
- **With Miyar server**, reports are stored in your PostgreSQL database and kept by your own backup and retention rules.

## Network: what the secured build is allowed to do

The browser enforces this policy (`secure/csp.txt`):

```
default-src 'none'; script-src 'self' 'sha256-…' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self';
img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; base-uri 'none';
form-action 'self'; object-src 'none'
```

- `connect-src 'self'`: the page cannot send data to any other site, even if its code were changed to try.
- Inline code runs only if it matches the exact hash in the policy.
- `'unsafe-eval'` is needed for calculated fields (for example `[Revenue] - [Cost]`). Before a formula is compiled, the app checks it against an allow-list of field names, numbers, operators and a fixed set of functions. Anything else is rejected.
- `'unsafe-inline'` applies to styles only. The chart and PDF-export libraries need it to position elements.
- The policy is set in the page itself. Miyar server also sends it as an HTTP header, adding `frame-ancestors 'self'` (blocks embedding in other sites) and `Referrer-Policy: no-referrer`. If you host `secure/` on another web server, add the same header there, because `frame-ancestors` only works as a header.

Tested by loading the secured build with every request to another site blocked. Excel and PDF import, charts, calculated fields, PDF and Excel export and Ask Sahil all worked. There were no outside requests and no policy violations, and a deliberate request to another site was refused.

## Live data sources (optional)

- In the secured build, the page cannot reach a gateway directly. Live sources (SAP, Oracle, Databricks, SQL Server, …) work only through **Miyar server**, which calls the **Miyar gateway** inside your network.
- The gateway accepts only **read-only** queries (one `SELECT`, `WITH`, `SHOW` or `DESCRIBE` statement, with a row limit), and only against connections an administrator lists in `connections.json`. Database passwords stay on the gateway and are never sent to the browser. Also give it a database account that can only read.
- The server and gateway share a key (`MIYAR_GATEWAY_KEY`). Keep the gateway on an internal network.

## Miyar server (optional)

- **Sign-in:** your company's OpenID Connect provider (Entra ID, Okta, Google Workspace, Keycloak, …). Miyar stores no passwords.
- **Roles:** viewer, editor and admin, taken from your provider's groups.
- **Audit log** of sign-ins and sign-outs, and of every dataset, report and playground create, update and delete.
- Every record carries the organisation id.
- **My playground** items are visible only to their owner. The server checks this on every request, not just in the page.
- **Session cookies** are HttpOnly, SameSite=Lax, and Secure over HTTPS. Requests that change data must carry the `X-Miyar` header, which protects against cross-site request forgery.
- **Configuration** is held in environment variables (`.env.example`). Put `SESSION_SECRET`, `OIDC_CLIENT_SECRET` and the database password in your secret store.

## Third-party components

All are pinned in `tools/package.json`. Licence texts are in `secure/vendor/licenses/`.

| Component | Version | Licence | Used for |
|---|---|---|---|
| Apache ECharts | 5.4.3 | Apache-2.0 | charts |
| SheetJS (xlsx) | 0.18.5 | Apache-2.0 | reading and writing Excel |
| pdf.js | 3.11.174 | Apache-2.0 | reading tables from PDF |
| jsPDF | 2.5.1 | MIT | PDF export |
| html2canvas | 1.4.1 | MIT | PDF export |
| IBM Plex Sans, Sans Arabic, Mono; Space Grotesk | Fontsource 5.x | OFL-1.1 | fonts |

Miyar itself is MIT-licensed.

## Checking the files you were given

```bash
cd secure && sha256sum -c SHA256SUMS
```

Every line should end in `OK`. `build.json` records the version, the source commit, the security policy, each library's integrity hash, and the size and SHA-256 of every file. To reproduce the build from source:

```bash
git checkout v1.5.0 && cd tools && npm ci && npm run build:secure
```

## Versions

- Releases are git tags (`v1.0.0`, `v1.1.0`, `v1.2.0`, `v1.3.0`, `v1.3.1`, `v1.3.2`, `v1.4.0`, `v1.4.1`, `v1.5.0`, …).
- The version shows in the **Report** dialog and on the logo tooltip ("Miyar 1.5.0 · secured build").
- Approve a specific tag and its `SHA256SUMS`. A new version needs a new review.
- Report security issues privately to the repository owner, not as public issues.

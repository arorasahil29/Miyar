# Miyar server

The server turns Miyar from a single-person browser app into a shared tool for an organisation:

- **Sign-in with any OpenID Connect provider**: Microsoft Entra ID (Office 365), Google Workspace, Okta, Keycloak, Auth0, Ping, OneLogin and others.
- **Shared reports and datasets.** Report definitions and dataset details live in PostgreSQL; dataset rows are stored as compressed files on a disk volume or in S3-compatible storage.
- **Roles.** Viewers open, filter and export reports. Editors also build reports and import or connect data. Admins also manage users and see the activity log.
- **Activity log** of sign-ins, report and dataset changes, role changes and data-source queries.
- **Live data through Miyar Gateway**, called by the server so nobody's browser holds the gateway key.

It is built for **one organisation per installation**. Every table already carries an `org_id`, so the same database can later host several organisations without migrating data.

```
browser ──HTTPS──▶ Miyar server ──▶ PostgreSQL           (users, reports, dataset details, activity)
                        │      └──▶ /data volume or S3     (dataset rows, gzip)
                        └──────────▶ Miyar Gateway ──▶ SAP / Oracle / Databricks / …
```

## Quick start with Docker

```bash
cp .env.example .env                      # fill in secrets and the sign-in settings below
cp gateway/connections.example.json gateway/connections.json   # optional: live data sources
docker compose up -d --build
```

Open `PUBLIC_URL` (default http://localhost:8080) and sign in.

To try it without an identity provider, set `AUTH_MODE=dev` in `.env`. Everyone who opens it is then signed in as an administrator, so use this only on your own machine.

## Sign-in setup

Register Miyar as a web application in your identity provider with:

- **Redirect URI:** `<PUBLIC_URL>/auth/callback`, e.g. `https://bi.example.com/auth/callback`
- **Sign-out redirect URI (optional):** `<PUBLIC_URL>/`
- **Scopes:** `openid email profile`

Then set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` in `.env`.

| Provider | `OIDC_ISSUER` | Notes |
|---|---|---|
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | App registrations → New registration → Web redirect URI. Create a client secret. For groups, add the *groups* claim under Token configuration (the claim contains group object IDs). |
| Google Workspace | `https://accounts.google.com` | Google Cloud console → Credentials → OAuth client ID (Web application). Restrict with `ALLOWED_EMAIL_DOMAINS=yourcompany.com`. |
| Okta | `https://<org>.okta.com` or `https://<org>.okta.com/oauth2/default` | Create an OIDC Web App integration. For groups, add a `groups` claim to the authorization server. |
| Keycloak | `https://<host>/realms/<realm>` | Create a confidential OpenID Connect client. Add a *Group Membership* mapper named `groups` for group-based roles. |
| Auth0 | `https://<tenant>.auth0.com/` | Regular Web Application. |

## Roles

Pick one way to manage roles:

1. **In Miyar (default).** The first person to sign in becomes an admin, unless you list admins in `ADMIN_EMAILS`. Everyone else starts as `DEFAULT_ROLE` (viewer) and an admin changes roles under **Account → Users and roles**.
2. **From your identity provider's groups.** Set `ADMIN_GROUPS` and/or `EDITOR_GROUPS` (group names or IDs as they appear in the `OIDC_ROLE_CLAIM` claim, default `groups`). Roles are then refreshed at every sign-in. Emails in `ADMIN_EMAILS` are always admins.

`ALLOWED_EMAIL_DOMAINS` limits who may sign in at all.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | The address people use. With `https://` cookies are marked Secure. A path such as `https://intranet.example.com/miyar` works too. |
| `DATABASE_URL` | (required) | PostgreSQL connection string. `DATABASE_SSL=true` turns on TLS. |
| `SESSION_SECRET` | (required) | At least 32 random characters. |
| `SESSION_HOURS` | `12` | How long a sign-in lasts. |
| `ORG_NAME` | `My organisation` | Shown on the sign-in page. |
| `AUTH_MODE` | `oidc` | `dev` for a local trial without sign-in. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | | Your identity provider. Leave the secret empty for public clients (PKCE is always used). |
| `OIDC_SCOPES` | `openid email profile` | Add `groups` if your provider needs it for the groups claim. |
| `OIDC_PROVIDER_NAME` | `your company account` | Button text: "Sign in with …". |
| `OIDC_LOGOUT` | `true` | Also sign out at the identity provider. |
| `ADMIN_EMAILS`, `ADMIN_GROUPS`, `EDITOR_GROUPS`, `DEFAULT_ROLE`, `FIRST_USER_ADMIN` | | See Roles. |
| `ALLOWED_EMAIL_DOMAINS` | | Comma-separated. |
| `STORAGE_DRIVER` | `local` | `local` (files under `DATA_DIR`, default `/data`) or `s3`. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_SSE`, `S3_PREFIX` | | For AWS S3, MinIO, Cloudflare R2, Wasabi, Google Cloud Storage (interoperability keys) and similar. Leave the keys empty to use the cloud's own identity (e.g. an AWS IAM role). |
| `GATEWAY_URL`, `GATEWAY_KEY` | | Miyar Gateway for live data sources. |
| `MAX_UPLOAD` | `200mb` | Largest dataset upload. |

## Running in production

- Put the server behind HTTPS: your cloud's load balancer, a reverse proxy such as nginx, Caddy or Traefik, or your company's application gateway.
- Back up PostgreSQL (for example `pg_dump`, or your cloud's managed backups) **and** the `/data` volume or S3 bucket. Dataset rows live in storage, everything else in the database.
- Use a managed PostgreSQL in the cloud if you prefer: Amazon RDS, Azure Database for PostgreSQL, Google Cloud SQL.
- The server is stateless apart from the database and storage, so you can run several copies behind a load balancer.

## Security notes

- Sessions are random tokens stored hashed in the database, in `HttpOnly`, `SameSite=Lax` cookies (`Secure` over HTTPS).
- Sign-in uses the authorization code flow with PKCE, `state` and `nonce`.
- Requests that change data must carry a header that other websites cannot send, and must come from `PUBLIC_URL`.
- Every query is scoped to the organisation and checked against the user's role on the server; hiding buttons in the app is only for convenience.
- Calculated-field formulas are checked before they are compiled, so a formula in a shared report cannot run other code in a colleague's browser.
- When two people edit the same report, the second save is refused and that person chooses which version to keep.

## API

All endpoints are under `<PUBLIC_URL>/api` and use the session cookie. Requests that change data need the header `X-Miyar: 1`.

| Method | Path | Role |
|---|---|---|
| GET | `/config`, `/me` | anyone |
| GET | `/datasets`, `/datasets/:id/rows`, `/reports`, `/reports/:id` | viewer |
| POST | `/datasets` | editor |
| PUT | `/datasets/:id/rows`, `/reports/:id` (create or update; send the `version` you started from) | editor |
| PATCH | `/datasets/:id` | editor |
| DELETE | `/datasets/:id`, `/reports/:id` | editor |
| GET/POST | `/gateway/connections`, `/gateway/tables`, `/gateway/query` | editor |
| GET | `/users`, `/audit` | admin |
| PATCH | `/users/:id` | admin |

## Growing to several organisations later

The data model is ready: `orgs` is a table and every row has `org_id`. To serve several organisations from one installation you would add a way to tell organisations apart at sign-in (by email domain, by sub-domain such as `acme.miyar.app`, or by identity-provider tenant), store one OIDC configuration per organisation, and add an admin view for creating organisations. No existing data needs to move.

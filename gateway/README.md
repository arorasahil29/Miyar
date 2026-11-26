# Basira Gateway

A small read-only query service that connects Basira to live data: SAP, Oracle, Databricks, Snowflake, BigQuery, SQL Server, PostgreSQL, MySQL, Redshift, Synapse, SQLite and OData feeds.

Browsers cannot talk to databases directly, and database passwords must never sit in a web page. The gateway runs next to your data, keeps the credentials, accepts only read-only queries, and returns rows to Basira as JSON.

```
Basira (browser)  ──HTTPS + access key──▶  Basira Gateway  ──native driver──▶  SAP / Oracle / Databricks / …
```

## Supported sources

| `type` | Source | Driver (installed automatically) |
|---|---|---|
| `saphana` | SAP HANA, HANA Cloud, BW/4HANA and S/4HANA databases | `@sap/hana-client` |
| `odata` | SAP S/4HANA and SAP BW through SAP Gateway OData, Dynamics 365, any OData v2/v4 service | built in |
| `oracle` | Oracle Database 12c+, Autonomous Database (no Oracle client needed) | `oracledb` |
| `databricks` | Databricks SQL warehouses, Unity Catalog | `@databricks/sql` |
| `snowflake` | Snowflake | `snowflake-sdk` |
| `bigquery` | Google BigQuery | `@google-cloud/bigquery` |
| `sqlserver`, `azuresql`, `synapse` | SQL Server, Azure SQL, Azure Synapse, Fabric SQL endpoints | `mssql` |
| `postgres`, `redshift` | PostgreSQL, Amazon Redshift | `pg` |
| `mysql`, `mariadb` | MySQL, MariaDB | `mysql2` |
| `sqlite` | A SQLite file on the gateway machine | built in (Node 22.13+) |

## 1. Describe your connections

Copy `connections.example.json` to `connections.json` and keep only what you need. Write secrets as `${VARIABLE}`; the gateway reads them from environment variables, so passwords stay out of the file.

```json
{ "connections": [
  { "name": "Oracle – ERP", "type": "oracle", "user": "${ORACLE_USER}", "password": "${ORACLE_PASSWORD}",
    "connectString": "erp-db.example.com:1521/ERPPDB" },
  { "name": "Databricks – Lakehouse", "type": "databricks", "host": "adb-123.7.azuredatabricks.net",
    "path": "/sql/1.0/warehouses/abc123", "token": "${DATABRICKS_TOKEN}", "catalog": "main", "schema": "sales" },
  { "name": "SAP S/4HANA – Sales orders", "type": "odata",
    "url": "https://my-s4.example.com/sap/opu/odata/sap/API_SALES_ORDER_SRV",
    "user": "${S4_USER}", "password": "${S4_PASSWORD}", "client": "100" }
] }
```

The `name` is what people see in Basira. Use a **read-only database user** for every connection.

## 2. Run it

### With Docker (recommended)

The repository's `docker-compose.yml` runs the gateway next to Basira server, PostgreSQL and the web app (see the main README). The gateway is only reachable inside the Docker network; Basira server calls it with `BASIRA_GATEWAY_KEY` from `.env`, so people's browsers never see the key. Put the secrets your `connections.json` refers to in `gateway/.env` (one `NAME=value` per line).

To run the gateway on its own, for example on a machine inside the network where your databases are:

```bash
docker build -t basira-gateway ./gateway
docker run -d -p 8787:8787 -e BASIRA_GATEWAY_KEY=your-long-random-key \
  -v $PWD/gateway/connections.json:/app/connections.json:ro --env-file gateway/.env basira-gateway
```

### With Node.js 22.13 or later

```bash
cd gateway
npm install
BASIRA_GATEWAY_KEY=your-long-random-key ALLOWED_ORIGINS=https://yourname.github.io node server.js
```

`npm install` tries every driver; any that fail to install are skipped, and only that source is unavailable.

## 3. Connect from Basira

With Basira server, the connection is already made: editors open **Data → Data sources** and pick a source. Without a server, open **Data → Data sources**, enter the gateway address and access key, click **Connect**, choose a source, then pick a table or write a query and click **Preview**. Loaded data opens as a new report, and **Refresh from …** in the Fields pane reloads it later.

Live connections work in the self-hosted Basira (GitHub Pages, Docker, your own server). Inside claude.ai, pages cannot reach other servers.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `BASIRA_GATEWAY_KEY` | (required) | Shared access key. Basira sends it as `Authorization: Bearer …`. |
| `ALLOWED_ORIGINS` | `*` | Comma-separated sites allowed to call the gateway, e.g. `https://yourname.github.io`. Set this in production. |
| `CONNECTIONS_FILE` | `./connections.json` | Path to the connections file. Changes are picked up without a restart. |
| `MAX_ROWS` | `200000` | Most rows one query may return. |
| `QUERY_TIMEOUT_MS` | `120000` | Query time limit. |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Where the gateway listens. |

## Security

- Only single `SELECT`, `WITH`, `SHOW`, `DESCRIBE` and `EXPLAIN` statements run; writes and multiple statements are refused. Still use read-only database users: the check is a safety net, not a permission system.
- OData requests cannot leave the service URL configured for that connection.
- Serve the gateway over HTTPS (behind a load balancer, reverse proxy or your cloud's HTTPS front end), keep the access key secret, and restrict `ALLOWED_ORIGINS`.
- The access key is shared by everyone who uses the gateway. For per-user sign-in, put the gateway behind your identity provider (for example an OAuth2 proxy or your cloud's built-in authentication).

## API

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/health` | | `{ok, version}` (no key needed) |
| GET | `/connections` | | `{connections: [{name, type, description}]}` |
| GET | `/tables` | `?connection=NAME` | `{tables: [{schema, name}]}` |
| POST | `/query` | `{connection, query, limit}` or `{connection, table: {schema, name}, limit}` | `{columns, rows, truncated, ms}` |

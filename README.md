# Miyar · معيار

*Miyar* (معيار) is Arabic for a measure, standard or benchmark: the thing every dashboard tracks.

**Benchmark**

A self-service business intelligence app that runs entirely in the browser. It's a single HTML file, with no server, no build step and no account.

**Live app:** https://arorasahil29.github.io/Miyar/

## Run it

- **Locally:** double-click `index.html`, or serve the folder with any static server, e.g. `python3 -m http.server 8080`, then open http://localhost:8080.
- **Online:** upload `index.html` to any static host: GitHub Pages, Netlify, Vercel, Cloudflare Pages, S3, or an intranet web server.

It needs an internet connection the first time, to load these libraries from cdnjs: ECharts (charts), SheetJS (Excel), pdf.js (PDF import), jsPDF and html2canvas (PDF export). To run fully offline, download those files and change the URLs in the `<script>` tag and in the `LIBS` object near the top of the main script.

## Features

- Import Excel, PDF tables, CSV/TSV, JSON and HTML tables, with a preview before loading
- 27 visual types: charts, KPI cards, tables, matrix, slicers, gauges, Sankey diagrams, calendar heatmaps and more
- Company sign-in (Microsoft Entra ID, Google, Okta, Keycloak or any OpenID Connect provider), shared reports, roles and an activity log with **Miyar server**. See [server/README.md](server/README.md)
- Live data sources through **Miyar Gateway**: SAP HANA, SAP S/4HANA and BW (OData), Oracle, Databricks, Snowflake, BigQuery, SQL Server, Azure Synapse, PostgreSQL, Redshift, MySQL and OData feeds. See [gateway/README.md](gateway/README.md)
- Cross-filtering, drill-down hierarchies, drill-through detail pages, calculated fields
- Multiple reports and pages, undo/redo/reset, light and dark themes, phone layout
- Export to PDF and Excel

## Run it for your organisation (Docker)

Miyar server adds company sign-in (any OpenID Connect provider), shared reports and datasets, roles and an activity log. It runs anywhere Docker runs.

```bash
cp .env.example .env                                            # secrets and sign-in settings
cp gateway/connections.example.json gateway/connections.json    # optional: live data sources
docker compose up -d --build
```

This starts four pieces: the Miyar server (web app and API), PostgreSQL, and Miyar Gateway for live data. The same setup runs on a company server or in any cloud that runs containers: AWS ECS or App Runner, Azure Container Apps, Google Cloud Run, or Kubernetes. Setup for Microsoft Entra ID, Google, Okta and Keycloak is in [server/README.md](server/README.md).

## Where data is kept

- **With Miyar server:** reports, dataset details, users and the activity log are in your PostgreSQL database; dataset rows are in your storage (a Docker volume or an S3 bucket). Live data from SAP, Oracle, Databricks and others stays in those systems and is read through the gateway when someone loads or refreshes it.
- **Without a server** (opening `index.html` directly or from GitHub Pages): everything stays in the user's own browser (`localStorage`). Nothing is uploaded, nothing is shared, and clearing site data removes it.

## "Ask your data" chatbot

Inside claude.ai the chatbot uses the viewer's Claude account. Outside Claude it shows as unavailable. To enable it on your own deployment, connect it to an LLM API through a small server-side proxy that holds the API key. Never put an API key in this file. The chatbot's tools (`query_data`, `distinct_values`, `add_visual`, `apply_report_filter`) already run in the page, so only the call in `chatSend()` needs replacing.

## License

MIT. See [LICENSE](LICENSE).

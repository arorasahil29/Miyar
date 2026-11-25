# Basira · بصيرة

*Basira* is Arabic for insight, or clear vision.

A self-service business intelligence app that runs entirely in the browser. It's a single HTML file, with no server, no build step and no account.

**Live app:** https://arorasahil29.github.io/Basira/

## Run it

- **Locally:** double-click `index.html`, or serve the folder with any static server, e.g. `python3 -m http.server 8080`, then open http://localhost:8080.
- **Online:** upload `index.html` to any static host: GitHub Pages, Netlify, Vercel, Cloudflare Pages, S3, or an intranet web server.

It needs an internet connection the first time, to load these libraries from cdnjs: ECharts (charts), SheetJS (Excel), pdf.js (PDF import), jsPDF and html2canvas (PDF export). To run fully offline, download those files and change the URLs in the `<script>` tag and in the `LIBS` object near the top of the main script.

## Features

- Import Excel, PDF tables, CSV/TSV, JSON and HTML tables, with a preview before loading
- 27 visual types: charts, KPI cards, tables, matrix, slicers, gauges, Sankey diagrams, calendar heatmaps and more
- Cross-filtering, drill-down hierarchies, drill-through detail pages, calculated fields
- Multiple reports and pages, undo/redo/reset, light and dark themes, phone layout
- Export to PDF and Excel

## Where data is kept

Everything stays in the user's browser (`localStorage`). Nothing is uploaded. Each browser and device has its own copy, and clearing site data removes it. Large datasets (more than a few MB) may not persist between visits.

## "Ask your data" chatbot

Inside claude.ai the chatbot uses the viewer's Claude account. Outside Claude it shows as unavailable. To enable it on your own deployment, connect it to an LLM API through a small server-side proxy that holds the API key. Never put an API key in this file. The chatbot's tools (`query_data`, `distinct_values`, `add_visual`, `apply_report_filter`) already run in the page, so only the call in `chatSend()` needs replacing.

## License

MIT. See [LICENSE](LICENSE).

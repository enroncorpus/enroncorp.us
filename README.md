# Enron Corpus Browser

A jmail-style web viewer for the [Enron email corpus](https://www.cs.cmu.edu/~enron/): 517,401 emails from
150 employee mailboxes, released publicly by FERC during the Enron investigation and long used as a
standard research/ML dataset. Browse by employee and folder, run full-text search, or explore an
interactive network graph of who emailed whom.

Live at [enroncorp.us](https://enroncorp.us).

## How it works

`preprocess.py` walks the raw maildir once and builds a SQLite database: one `emails` row per message
(sender, recipients, subject, a 300-char body preview, and a `filepath` pointer back into the maildir),
an FTS5 index over subject + body for search, an `employees` table for the 150 accounts, and a
`graph_nodes`/`graph_edges` pair aggregating every sender→recipient relationship with an email count as
edge weight.

`server.py` is a stdlib-only HTTP server (`ThreadingHTTPServer`, zero pip dependencies) that answers a
small JSON API off that database: paginated email lists, FTS5 search, the graph data, and one endpoint
that reads a single email's raw file straight from the maildir and parses it with `email.message_from_bytes`
for the full body (the DB only stores a preview).

The frontend (`static/`) is vanilla JS with no build step or framework. It's a single-page app with three
panels: an employee/folder tree, an email list with infinite scroll, and a detail pane that shows either
an email body or a [vis.js](https://visjs.org/) force-directed graph. Every panel runs on `fetch()` calls
into the API above.

## Running it locally

This repo holds the code only. The corpus (~2.6 GB maildir) and the generated database (~600 MB) are
data, not code, and too large for git, so they aren't included.

1. Download the Enron corpus maildir, e.g. from [CMU's mirror](https://www.cs.cmu.edu/~enron/).
2. Build the database (a few minutes; add `--limit N` to build a small dev subset instead of the full corpus):
   ```bash
   python3 preprocess.py --maildir /path/to/maildir --db enron.db
   ```
3. Run the server:
   ```bash
   python3 server.py --db enron.db --maildir /path/to/maildir --port 8000
   ```
4. Open `http://localhost:8000`.

## File layout

```
server.py          HTTP server + JSON API (stdlib only)
preprocess.py       one-time maildir → SQLite ingestion
static/
├── index.html      SPA shell (About / Email / Network tabs)
├── style.css       light theme, three-panel CSS grid, mobile layout
├── app.js          all frontend logic, vanilla JS
└── vendor/
    └── vis-network.min.js   bundled locally, not loaded from a CDN
```

## Corpus facts

| Fact | Value |
|---|---|
| Emails | 517,401 |
| Employee mailboxes | 150 |
| Format | Plain-text MIME, numeric filenames (`1.`, `604.`) |
| Headers | Standard + Enron-specific: `X-From`, `X-To`, `X-Folder`, `X-Origin` |

## Database schema

**`emails`** (517,401 rows): `id`, `message_id` (unique), `owner` (maildir slug, e.g. `lay-k`), `folder`,
`filepath` (relative path back into the maildir), `date_ts`/`date_str`, `sender`, `sender_name`, `subject`,
`recipients`/`cc` (JSON arrays), `body_preview` (first 300 chars, quoted replies stripped).
Indexes on `(owner, folder)`, `sender`, `date_ts`.

**`emails_fts`**: FTS5 virtual table over `subject` + `body_preview`, `porter unicode61` tokenizer,
content-linked to `emails` by rowid.

**`employees`** (150 rows): `slug` (PK), `full_name`, `email`, `email_count`, `folders` (JSON array).

**`graph_nodes`** (79,894 rows): `email` (PK), `display_name`, `is_employee`, `owner_slug`, `email_count`.

**`graph_edges`** (310,968 rows): `src`, `dst`, `weight` (email count), PK `(src, dst)`.

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/employees` | All 150 employees with slug, name, email, folder counts |
| `GET /api/emails?owner=lay-k&folder=inbox&page=1&per_page=50` | Paginated email list |
| `GET /api/email/:id` | Full email, reads the raw file from the maildir on demand |
| `GET /api/search?q=california+energy&owner=lay-k&page=1` | FTS5 search, `owner` optional |
| `GET /api/graph?min_weight=5&max_nodes=200` | Node/edge data for the network tab |
| `GET /api/person_emails?email=x@enron.com&page=1` | All emails involving one address |
| `GET /api/stats` | Row counts across all tables |
| `GET /*` | Static files from `static/`, falling back to `index.html` for SPA routing |

Try it against a running server:
```bash
curl "http://localhost:8000/api/stats"
curl "http://localhost:8000/api/search?q=california+energy&per_page=3"
curl "http://localhost:8000/api/graph?min_weight=10&max_nodes=100"
```

## Frontend notes

- **State**: a single object tracks the current owner/folder, search query, pagination, and the vis.js
  dataset. See the `state` object at the top of `app.js`.
- **Infinite scroll**: an `IntersectionObserver` on a sentinel div at the bottom of the list triggers the
  next page; the same code path handles folder browsing, search results, and per-person email lists.
- **Network graph**: nodes are sized by connection *degree* within the filtered graph, not raw email
  volume. A shared mailbox that exchanges thousands of emails with one correspondent shouldn't read as
  well-connected, so degree is the more honest signal. Employees render as red dots (`#df0032`), external
  contacts as green dots (`#009655`), edges as light blue. The solver is `forceAtlas2Based` with
  `improvedLayout: false`, required past ~200 nodes since the alternative layout is O(n²).

## Known limitations (prototype)

- `person_emails` matches recipients with `LIKE '%addr%'`, a substring match that can false-positive on
  partial address matches. A proper fix is a junction table (`email_id`, `address`) instead.
- A handful of employees (e.g. `fastow-a`) have no matching sent mail, so their display name falls back
  to a slug-derived guess rather than a name pulled from headers.
- No authentication, CORS wide open (`Access-Control-Allow-Origin: *`). Acceptable here since the
  browser is read-only with no mutation endpoints. Don't carry that setting into anything that writes data.

## License

MIT, see `LICENSE`. The Enron corpus itself is a public research dataset, not covered by this license.
See the CMU link above for its provenance.

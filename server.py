#!/usr/bin/env python3
"""
Enron Corpus Browser - local server.
Usage: python3 server.py [--db enron.db] [--port 8000] [--maildir ../maildir]
"""

import argparse
import email
import email.policy
import json
import mimetypes
import sqlite3
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

def _fmt_name(name):
    if not name:
        return name
    name = name.strip().strip('"')
    if ',' in name:
        parts = [p.strip() for p in name.split(',', 1)]
        return f"{parts[1]} {parts[0]}" if parts[1] else parts[0]
    return name

# Defaults — resolved relative to this script's directory
SCRIPT_DIR = Path(__file__).parent
DEFAULT_DB      = SCRIPT_DIR / 'enron.db'
DEFAULT_MAILDIR = SCRIPT_DIR / '../maildir'
DEFAULT_STATIC  = SCRIPT_DIR / 'static'

DB_PATH      = DEFAULT_DB
MAILDIR_ROOT = DEFAULT_MAILDIR
STATIC_DIR   = DEFAULT_STATIC

_local = threading.local()
_db_lock = threading.Lock()


def get_db():
    if not hasattr(_local, 'conn') or _local.conn is None:
        _local.conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute('PRAGMA journal_mode=WAL')
        _local.conn.execute('PRAGMA cache_size=-32768')
    return _local.conn


def query(sql, params=()):
    conn = get_db()
    with _db_lock:
        return conn.execute(sql, params).fetchall()


def query_one(sql, params=()):
    conn = get_db()
    with _db_lock:
        return conn.execute(sql, params).fetchone()


class EnronHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress request logs for cleaner output

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path   = parsed.path
        params = dict(urllib.parse.parse_qsl(parsed.query))

        try:
            if path.startswith('/api/'):
                self.route_api(path, params)
            else:
                self.serve_static(path)
        except Exception as e:
            self.json_response({'error': str(e)}, status=500)

    def route_api(self, path, params):
        if path == '/api/employees':
            self.api_employees()
        elif path == '/api/emails':
            self.api_emails(params)
        elif path.startswith('/api/email/'):
            email_id = path[len('/api/email/'):]
            self.api_email_detail(email_id)
        elif path == '/api/search':
            self.api_search(params)
        elif path == '/api/graph':
            self.api_graph(params)
        elif path == '/api/person_emails':
            self.api_person_emails(params)
        elif path == '/api/stats':
            self.api_stats()
        else:
            self.json_response({'error': 'not found'}, status=404)

    # -------------------------------------------------------------------------
    # API handlers
    # -------------------------------------------------------------------------

    def api_employees(self):
        # Build a full email→slug map from graph_nodes (employees have many addresses)
        email_map_rows = query(
            'SELECT owner_slug, email FROM graph_nodes WHERE is_employee=1 AND owner_slug IS NOT NULL'
        )
        slug_to_emails = {}
        for er in email_map_rows:
            slug_to_emails.setdefault(er['owner_slug'], []).append(er['email'])

        folder_count_rows = query(
            'SELECT owner, folder, COUNT(*) as cnt FROM emails GROUP BY owner, folder'
        )
        folder_counts = {}
        for fr in folder_count_rows:
            folder_counts.setdefault(fr['owner'], {})[fr['folder']] = fr['cnt']

        rows = query(
            'SELECT slug, full_name, email, email_count, folders FROM employees ORDER BY slug'
        )
        result = []
        for r in rows:
            known_emails = slug_to_emails.get(r['slug'], [])
            if r['email'] and r['email'] not in known_emails:
                known_emails.append(r['email'])
            result.append({
                'slug':          r['slug'],
                'full_name':     r['full_name'] or r['slug'],
                'email':         r['email'],
                'emails':        known_emails,
                'email_count':   r['email_count'],
                'folders':       json.loads(r['folders']) if r['folders'] else [],
                'folder_counts': folder_counts.get(r['slug'], {}),
            })
        self.json_response(result)

    def api_emails(self, params):
        owner    = params.get('owner', '')
        folder   = params.get('folder', '')
        page     = max(1, int(params.get('page', 1)))
        per_page = min(100, int(params.get('per_page', 50)))
        offset   = (page - 1) * per_page

        if not owner:
            self.json_response({'error': 'owner required'}, status=400)
            return

        where = 'WHERE owner=?'
        args  = [owner]
        if folder:
            where += ' AND folder=?'
            args.append(folder)

        total_row = query_one(f'SELECT COUNT(*) as n FROM emails {where}', args)
        total = total_row['n'] if total_row else 0

        rows = query(
            f"""SELECT id, date_ts, date_str, sender, sender_name, subject, body_preview, folder
                FROM emails {where}
                ORDER BY COALESCE(date_ts, 0) DESC
                LIMIT ? OFFSET ?""",
            args + [per_page, offset]
        )
        emails = [dict(r) for r in rows]
        self.json_response({'total': total, 'page': page, 'per_page': per_page, 'emails': emails})

    def api_email_detail(self, email_id):
        try:
            eid = int(email_id)
        except ValueError:
            self.json_response({'error': 'invalid id'}, status=400)
            return

        row = query_one(
            'SELECT id, filepath, subject, sender, sender_name, recipients, cc, date_str, body_preview, owner, folder FROM emails WHERE id=?',
            (eid,)
        )
        if not row:
            self.json_response({'error': 'not found'}, status=404)
            return

        filepath = MAILDIR_ROOT / row['filepath']
        body = ''
        try:
            raw = filepath.read_bytes()
            msg = email.message_from_bytes(raw, policy=email.policy.compat32)
            if msg.is_multipart():
                for part in msg.walk():
                    if part.get_content_type() == 'text/plain':
                        charset = part.get_content_charset() or 'utf-8'
                        payload = part.get_payload(decode=True)
                        if payload:
                            body = payload.decode(charset, errors='replace')
                            break
            else:
                charset = msg.get_content_charset() or 'utf-8'
                payload = msg.get_payload(decode=True)
                if payload:
                    body = payload.decode(charset, errors='replace')
        except Exception as e:
            body = f'[Error reading email: {e}]'

        self.json_response({
            'id':          row['id'],
            'subject':     row['subject'] or '(no subject)',
            'sender':      row['sender'] or '',
            'sender_name': row['sender_name'] or '',
            'recipients':  json.loads(row['recipients']) if row['recipients'] else [],
            'cc':          json.loads(row['cc']) if row['cc'] else [],
            'date_str':    row['date_str'] or '',
            'body':        body,
            'owner':       row['owner'],
            'folder':      row['folder'],
        })

    def api_search(self, params):
        q        = params.get('q', '').strip()
        owner    = params.get('owner', '')
        page     = max(1, int(params.get('page', 1)))
        per_page = min(100, int(params.get('per_page', 50)))
        offset   = (page - 1) * per_page

        if not q:
            self.json_response({'total': 0, 'emails': []})
            return

        # Sanitize for FTS5: wrap in quotes for phrase search
        safe_q = '"' + q.replace('"', ' ') + '"'

        if owner:
            total_row = query_one(
                """SELECT COUNT(*) as n FROM emails e
                   JOIN emails_fts ON emails_fts.rowid = e.id
                   WHERE emails_fts MATCH ? AND e.owner = ?""",
                (safe_q, owner)
            )
            total = total_row['n'] if total_row else 0
            rows = query(
                """SELECT e.id, e.date_ts, e.date_str, e.sender, e.sender_name,
                          e.subject, e.body_preview, e.folder
                   FROM emails e
                   JOIN emails_fts ON emails_fts.rowid = e.id
                   WHERE emails_fts MATCH ? AND e.owner = ?
                   ORDER BY rank
                   LIMIT ? OFFSET ?""",
                (safe_q, owner, per_page, offset)
            )
        else:
            total_row = query_one(
                """SELECT COUNT(*) as n FROM emails e
                   JOIN emails_fts ON emails_fts.rowid = e.id
                   WHERE emails_fts MATCH ?""",
                (safe_q,)
            )
            total = total_row['n'] if total_row else 0
            rows = query(
                """SELECT e.id, e.date_ts, e.date_str, e.sender, e.sender_name,
                          e.subject, e.body_preview, e.folder
                   FROM emails e
                   JOIN emails_fts ON emails_fts.rowid = e.id
                   WHERE emails_fts MATCH ?
                   ORDER BY rank
                   LIMIT ? OFFSET ?""",
                (safe_q, per_page, offset)
            )

        self.json_response({
            'total': total,
            'page': page,
            'per_page': per_page,
            'query': q,
            'emails': [dict(r) for r in rows],
        })

    def api_graph(self, params):
        min_weight = max(1, int(params.get('min_weight', 3)))
        max_nodes  = min(1500, int(params.get('max_nodes', 200)))
        # Node count was capping out well below max_nodes because this was a
        # flat 5000 regardless of how many nodes were even candidates — most
        # of the extra node budget had no chance to end up in a surviving
        # edge. Scale it with max_nodes so more of that budget actually gets
        # represented in the drawn graph.
        edge_limit = max_nodes * 5

        # All 150 archived employees (red nodes) are always included —
        # they're the point of the graph, and ranking by total email_count
        # against ~79,894 external addresses could otherwise cut a
        # less-active employee before their edges are even considered.
        # Only external contacts compete for the remaining node budget.
        node_rows = query(
            """SELECT email, display_name, is_employee, owner_slug, email_count
               FROM graph_nodes WHERE is_employee = 1"""
        )
        remaining = max(0, max_nodes - len(node_rows))
        if remaining:
            node_rows += query(
                """SELECT email, display_name, is_employee, owner_slug, email_count
                   FROM graph_nodes
                   WHERE is_employee = 0
                   ORDER BY email_count DESC
                   LIMIT ?""",
                (remaining,)
            )

        node_set = set(r['email'] for r in node_rows)

        # Build edge query with node_set filter
        # SQLite IN clause limit is 999; use temp table for large sets
        if len(node_set) <= 900:
            placeholders = ','.join('?' * len(node_set))
            node_list = list(node_set)
            edge_rows = query(
                f"""SELECT src, dst, weight FROM graph_edges
                    WHERE src IN ({placeholders}) AND dst IN ({placeholders}) AND weight >= ? AND src != dst
                    ORDER BY weight DESC
                    LIMIT ?""",
                node_list + node_list + [min_weight, edge_limit]
            )
        else:
            # Use a temp table approach
            conn = get_db()
            with _db_lock:
                conn.execute('CREATE TEMP TABLE IF NOT EXISTS _top_nodes (email TEXT PRIMARY KEY)')
                conn.execute('DELETE FROM _top_nodes')
                conn.executemany('INSERT OR IGNORE INTO _top_nodes VALUES (?)', [(e,) for e in node_set])
                edge_rows = conn.execute(
                    """SELECT ge.src, ge.dst, ge.weight
                       FROM graph_edges ge
                       INNER JOIN _top_nodes n1 ON ge.src = n1.email
                       INNER JOIN _top_nodes n2 ON ge.dst = n2.email
                       WHERE ge.weight >= ? AND ge.src != ge.dst
                       ORDER BY ge.weight DESC
                       LIMIT ?""",
                    (min_weight, edge_limit)
                ).fetchall()

        edges = [{'from': r['src'], 'to': r['dst'], 'value': r['weight']} for r in edge_rows]

        # Only include external nodes that appear in at least one filtered
        # edge — employees are always shown, even isolated, since the point
        # of the graph is to be able to find and click any of the 150. Their
        # edges can otherwise get crowded out of the top-5000-by-weight cut
        # by heavier-traffic external addresses.
        connected = {e['from'] for e in edges} | {e['to'] for e in edges}

        nodes = []
        for r in node_rows:
            if not r['is_employee'] and r['email'] not in connected:
                continue
            nodes.append({
                'id':         r['email'],
                'label':      _fmt_name(r['display_name']) or r['email'].split('@')[0],
                'value':      r['email_count'],
                'group':      'employee' if r['is_employee'] else 'external',
                'owner_slug': r['owner_slug'],
                'email':      r['email'],
                'email_count': r['email_count'],
            })

        self.json_response({'nodes': nodes, 'edges': edges})

    def api_person_emails(self, params):
        addr     = params.get('email', '').strip().lower()
        page     = max(1, int(params.get('page', 1)))
        per_page = min(100, int(params.get('per_page', 50)))
        offset   = (page - 1) * per_page

        if not addr:
            self.json_response({'error': 'email required'}, status=400)
            return

        pattern = f'%{addr}%'
        total_row = query_one(
            """SELECT COUNT(*) as n FROM emails
               WHERE sender=? OR recipients LIKE ?""",
            (addr, pattern)
        )
        total = total_row['n'] if total_row else 0

        rows = query(
            """SELECT id, date_ts, date_str, sender, sender_name, subject, body_preview, folder, owner
               FROM emails
               WHERE sender=? OR recipients LIKE ?
               ORDER BY COALESCE(date_ts, 0) DESC
               LIMIT ? OFFSET ?""",
            (addr, pattern, per_page, offset)
        )
        self.json_response({
            'total': total,
            'page': page,
            'per_page': per_page,
            'email': addr,
            'emails': [dict(r) for r in rows],
        })

    def api_stats(self):
        n_emails    = query_one('SELECT COUNT(*) as n FROM emails')['n']
        n_employees = query_one('SELECT COUNT(*) as n FROM employees')['n']
        n_nodes     = query_one('SELECT COUNT(*) as n FROM graph_nodes')['n']
        n_edges     = query_one('SELECT COUNT(*) as n FROM graph_edges')['n']
        self.json_response({
            'emails': n_emails,
            'employees': n_employees,
            'graph_nodes': n_nodes,
            'graph_edges': n_edges,
        })

    # -------------------------------------------------------------------------
    # Static file serving
    # -------------------------------------------------------------------------

    def serve_static(self, path):
        if path == '/' or not path:
            path = '/index.html'
        # Prevent path traversal
        path = path.lstrip('/')
        filepath = (STATIC_DIR / path).resolve()
        if not str(filepath).startswith(str(STATIC_DIR.resolve())):
            self.json_response({'error': 'forbidden'}, status=403)
            return
        if not filepath.exists() or not filepath.is_file():
            # Fallback to index.html for SPA routing
            filepath = STATIC_DIR / 'index.html'
        try:
            content = filepath.read_bytes()
            ctype, _ = mimetypes.guess_type(str(filepath))
            ctype = ctype or 'application/octet-stream'
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', len(content))
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.json_response({'error': str(e)}, status=500)

    def json_response(self, data, status=200):
        body = json.dumps(data, default=str).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)


def main():
    global DB_PATH, MAILDIR_ROOT

    parser = argparse.ArgumentParser(description='Enron Corpus Browser server')
    parser.add_argument('--db',      default=str(DEFAULT_DB),      help='Path to enron.db')
    parser.add_argument('--maildir', default=str(DEFAULT_MAILDIR), help='Path to maildir root')
    parser.add_argument('--port',    type=int, default=8000,        help='Port to listen on')
    args = parser.parse_args()

    DB_PATH      = Path(args.db).resolve()
    MAILDIR_ROOT = Path(args.maildir).resolve()

    if not DB_PATH.exists():
        print(f'Error: database not found: {DB_PATH}')
        print('Run preprocess.py first.')
        sys.exit(1)

    if not MAILDIR_ROOT.exists():
        print(f'Warning: maildir not found: {MAILDIR_ROOT}')
        print('Email body reads will fail.')

    print('Enron Corpus Browser')
    print(f'  DB:      {DB_PATH}')
    print(f'  Maildir: {MAILDIR_ROOT}')
    print(f'  Static:  {STATIC_DIR}')
    print(f'  Serving: http://localhost:{args.port}')
    print()

    server = ThreadingHTTPServer(('', args.port), EnronHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down.')
        server.shutdown()


if __name__ == '__main__':
    main()

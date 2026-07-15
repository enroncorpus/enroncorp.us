#!/usr/bin/env python3
"""
One-time preprocessing script: walks the Enron maildir and builds enron.db.
Usage: python3 preprocess.py --maildir ../maildir --db enron.db [--limit N]
"""

import argparse
import email
import email.utils
import email.policy
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path


QUOTE_MARKERS = [
    '-----Original Message-----',
    '-----Forwarded',
    '________________________________',
    '> From:',
    'From:    ',
    '---------------------- Forwarded',
]


def create_schema(conn):
    conn.executescript("""
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA cache_size=-65536;

        CREATE TABLE IF NOT EXISTS emails (
            id           INTEGER PRIMARY KEY,
            message_id   TEXT UNIQUE,
            owner        TEXT NOT NULL,
            folder       TEXT NOT NULL,
            filepath     TEXT NOT NULL,
            date_ts      INTEGER,
            date_str     TEXT,
            sender       TEXT,
            sender_name  TEXT,
            subject      TEXT,
            recipients   TEXT,
            cc           TEXT,
            body_preview TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_emails_owner_folder ON emails(owner, folder);
        CREATE INDEX IF NOT EXISTS idx_emails_sender       ON emails(sender);
        CREATE INDEX IF NOT EXISTS idx_emails_date         ON emails(date_ts);

        CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
            subject,
            body_preview,
            content=emails,
            content_rowid=id,
            tokenize='porter unicode61'
        );

        CREATE TABLE IF NOT EXISTS employees (
            slug        TEXT PRIMARY KEY,
            full_name   TEXT,
            email       TEXT,
            email_count INTEGER DEFAULT 0,
            folders     TEXT
        );

        CREATE TABLE IF NOT EXISTS graph_nodes (
            email        TEXT PRIMARY KEY,
            display_name TEXT,
            is_employee  INTEGER DEFAULT 0,
            owner_slug   TEXT,
            email_count  INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS graph_edges (
            src    TEXT NOT NULL,
            dst    TEXT NOT NULL,
            weight INTEGER DEFAULT 1,
            PRIMARY KEY (src, dst)
        );

        CREATE INDEX IF NOT EXISTS idx_edges_src ON graph_edges(src);
        CREATE INDEX IF NOT EXISTS idx_edges_dst ON graph_edges(dst);
    """)
    conn.commit()


def extract_emails(header_val):
    if not header_val:
        return []
    try:
        pairs = email.utils.getaddresses([header_val])
        result = []
        for _name, addr in pairs:
            addr = addr.lower().strip()
            if addr and '@' in addr and len(addr) < 200:
                result.append(addr)
        return result
    except Exception:
        return []


def extract_display_name(x_from):
    if not x_from:
        return ''
    x_from = str(x_from)
    # Strip Exchange DN like </O=ENRON/...>
    x_from = re.sub(r'<[^>]*>', '', x_from).strip()
    # Strip trailing @ENRON and similar
    x_from = re.sub(r'\s*@\w+\s*$', '', x_from).strip()
    return x_from[:200] if x_from else ''


def parse_body(msg):
    body = ''
    try:
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
    except Exception:
        pass

    # Strip quoted reply chains
    lines = body.splitlines()
    trimmed = []
    for line in lines:
        if any(line.startswith(marker) or line.strip().startswith(marker) for marker in QUOTE_MARKERS):
            break
        trimmed.append(line)

    text = '\n'.join(trimmed).strip()
    return text[:300]


def ingest_employee(slug, maildir_root, conn, limit=None):
    emp_dir = maildir_root / slug
    if not emp_dir.is_dir():
        return 0

    batch = []
    count = 0
    folders_seen = set()

    for root, dirs, files in os.walk(emp_dir):
        dirs.sort()
        folder = os.path.relpath(root, emp_dir).replace(os.sep, '/')
        if folder == '.':
            folder = '_root'

        for fname in sorted(files):
            if limit and count >= limit:
                break
            fpath = Path(root) / fname
            rel_path = os.path.relpath(fpath, maildir_root).replace(os.sep, '/')

            try:
                raw = fpath.read_bytes()
                msg = email.message_from_bytes(raw, policy=email.policy.compat32)
            except Exception:
                continue

            message_id = str(msg.get('Message-ID') or '').strip()[:500]
            date_str = str(msg.get('Date') or '').strip()[:200]
            date_ts = None
            try:
                dt = email.utils.parsedate_to_datetime(date_str)
                date_ts = int(dt.timestamp())
            except Exception:
                pass

            from_header = str(msg.get('From') or '')
            sender_list = extract_emails(from_header)
            sender = sender_list[0] if sender_list else ''
            sender_name = extract_display_name(str(msg.get('X-From') or ''))
            if not sender_name:
                try:
                    pairs = email.utils.getaddresses([from_header])
                    if pairs:
                        sender_name = str(pairs[0][0])
                except Exception:
                    pass

            subject = str(msg.get('Subject') or '').strip()[:500]
            recipients = extract_emails(str(msg.get('To') or ''))
            cc = extract_emails(str(msg.get('Cc') or ''))
            body_preview = parse_body(msg)

            folders_seen.add(folder)
            batch.append((
                message_id or None,
                slug,
                folder,
                rel_path,
                date_ts,
                date_str,
                sender or None,
                sender_name or None,
                subject or None,
                json.dumps(recipients),
                json.dumps(cc),
                body_preview or None,
            ))
            count += 1

            if len(batch) >= 500:
                conn.executemany(
                    """INSERT OR IGNORE INTO emails
                       (message_id, owner, folder, filepath, date_ts, date_str,
                        sender, sender_name, subject, recipients, cc, body_preview)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    batch
                )
                conn.commit()
                batch = []

        if limit and count >= limit:
            break

    if batch:
        conn.executemany(
            """INSERT OR IGNORE INTO emails
               (message_id, owner, folder, filepath, date_ts, date_str,
                sender, sender_name, subject, recipients, cc, body_preview)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            batch
        )
        conn.commit()

    # Update employees table
    email_count = conn.execute(
        'SELECT COUNT(*) FROM emails WHERE owner=?', (slug,)
    ).fetchone()[0]
    folders_list = sorted(folders_seen)
    conn.execute(
        """INSERT OR REPLACE INTO employees (slug, email_count, folders)
           VALUES (?, ?, ?)""",
        (slug, email_count, json.dumps(folders_list))
    )
    conn.commit()
    return count


def slug_to_name(slug):
    """Derive a human-readable name from a maildir slug like 'lay-k' → 'K. Lay'."""
    parts = slug.split('-')
    if len(parts) == 2:
        last, first = parts
        return f"{first.upper()}. {last.title()}"
    return slug.replace('-', ' ').title()


def derive_employee_info(conn, maildir_root):
    """Fill in full_name and canonical email for each employee from sent mail."""
    slugs = [r[0] for r in conn.execute('SELECT slug FROM employees').fetchall()]
    for slug in slugs:
        # Derive the likely @enron.com email pattern from slug
        # slug "lay-k" → look for "k.lay@enron.com" or "kenneth.lay@enron.com" etc.
        parts = slug.split('-')
        last = parts[0] if parts else slug
        first_init = parts[1] if len(parts) > 1 else ''

        # Look for their canonical @enron.com email in sent-folder FROM headers
        # Strategy: find the most common @enron.com sender in their sent folders
        rows = conn.execute(
            """SELECT sender, COUNT(*) as cnt
               FROM emails
               WHERE owner=? AND (folder LIKE '%sent%' OR folder = '_sent')
               AND sender IS NOT NULL AND sender LIKE '%@enron.com'
               GROUP BY sender ORDER BY cnt DESC LIMIT 5""",
            (slug,)
        ).fetchall()

        best_email = None
        for row in rows:
            s = row[0].lower()
            # Prefer email that contains the last name of the slug
            if last.lower() in s:
                best_email = row[0]
                break
        if not best_email and rows:
            best_email = rows[0][0]

        # Look for their display name from sent-folder X-From (sender_name)
        # Strategy: find the most common sender_name associated with best_email
        best_name = None
        if best_email:
            name_row = conn.execute(
                """SELECT sender_name, COUNT(*) as cnt
                   FROM emails
                   WHERE owner=? AND sender=? AND sender_name IS NOT NULL AND sender_name != ''
                   GROUP BY sender_name ORDER BY cnt DESC LIMIT 1""",
                (slug, best_email)
            ).fetchone()
            if name_row and name_row[0]:
                best_name = name_row[0]

        # Fallback: derive from slug
        if not best_name:
            best_name = slug_to_name(slug)

        conn.execute(
            'UPDATE employees SET full_name=?, email=? WHERE slug=?',
            (best_name, best_email, slug)
        )
    conn.commit()


def build_graph_tables(conn):
    print('\nBuilding graph nodes and edges...')
    conn.execute('DELETE FROM graph_nodes')
    conn.execute('DELETE FROM graph_edges')
    conn.commit()

    # Build nodes from all senders
    print('  Aggregating sender nodes...')
    conn.execute("""
        INSERT OR IGNORE INTO graph_nodes (email, display_name, email_count)
        SELECT sender, MAX(sender_name), COUNT(*)
        FROM emails
        WHERE sender IS NOT NULL AND sender != ''
        GROUP BY sender
    """)
    conn.commit()

    # Add recipient nodes
    print('  Aggregating recipient nodes...')
    conn.execute("""
        INSERT INTO graph_nodes (email, email_count)
        SELECT value as email, COUNT(*) as cnt
        FROM emails, json_each(emails.recipients)
        WHERE json_valid(emails.recipients)
        AND value != '' AND value NOT LIKE '% %'
        GROUP BY value
        ON CONFLICT(email) DO UPDATE SET email_count = email_count + excluded.email_count
    """)
    conn.commit()

    # Mark employees
    print('  Marking employees...')
    conn.execute("""
        UPDATE graph_nodes SET is_employee=1, owner_slug=e.slug
        FROM (
            SELECT slug, email FROM employees WHERE email IS NOT NULL
        ) e
        WHERE graph_nodes.email = e.email
    """)
    conn.commit()

    # Build edges
    print('  Building edges (this may take a while)...')
    conn.execute("""
        INSERT INTO graph_edges (src, dst, weight)
        SELECT e.sender, r.value, COUNT(*)
        FROM emails e, json_each(e.recipients) r
        WHERE e.sender IS NOT NULL AND e.sender != ''
        AND r.value != '' AND r.value NOT LIKE '% %'
        AND json_valid(e.recipients)
        GROUP BY e.sender, r.value
        ON CONFLICT(src, dst) DO UPDATE SET weight = weight + excluded.weight
    """)
    conn.commit()
    print('  Graph built.')


def build_fts_index(conn):
    print('\nBuilding FTS5 index...')
    conn.execute("INSERT INTO emails_fts(emails_fts) VALUES('rebuild')")
    conn.commit()
    print('  FTS index built.')


def main():
    parser = argparse.ArgumentParser(description='Preprocess Enron maildir into SQLite')
    parser.add_argument('--maildir', required=True, help='Path to maildir root')
    parser.add_argument('--db', required=True, help='Path to output SQLite database')
    parser.add_argument('--limit', type=int, default=None, help='Limit emails per employee (for dev)')
    parser.add_argument('--skip-fts', action='store_true', help='Skip FTS index build')
    args = parser.parse_args()

    maildir_root = Path(args.maildir).resolve()
    db_path = Path(args.db).resolve()

    if not maildir_root.is_dir():
        print(f'Error: maildir not found: {maildir_root}')
        sys.exit(1)

    slugs = sorted(p.name for p in maildir_root.iterdir() if p.is_dir())
    print(f'Found {len(slugs)} employee directories')
    print(f'Database: {db_path}')

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    create_schema(conn)

    start = time.time()
    total = 0
    for i, slug in enumerate(slugs):
        already = conn.execute('SELECT email_count FROM employees WHERE slug=?', (slug,)).fetchone()
        if already and not args.limit:
            count = already['email_count']
            print(f'\r[{i+1:3d}/{len(slugs)}] {slug:<20} {count:6d} emails (skipped)', end='', flush=True)
            total += count
            continue

        count = ingest_employee(slug, maildir_root, conn, limit=args.limit)
        total += count
        elapsed = time.time() - start
        rate = total / elapsed if elapsed > 0 else 0
        print(f'\r[{i+1:3d}/{len(slugs)}] {slug:<20} {count:6d} emails | total={total:7d} | {rate:.0f}/s    ', end='', flush=True)

    print(f'\n\nIngested {total} emails in {time.time()-start:.1f}s')

    derive_employee_info(conn, maildir_root)
    build_graph_tables(conn)
    if not args.skip_fts:
        build_fts_index(conn)

    # Final stats
    n_emails = conn.execute('SELECT COUNT(*) FROM emails').fetchone()[0]
    n_nodes  = conn.execute('SELECT COUNT(*) FROM graph_nodes').fetchone()[0]
    n_edges  = conn.execute('SELECT COUNT(*) FROM graph_edges').fetchone()[0]
    print(f'\nDone. {n_emails} emails | {n_nodes} graph nodes | {n_edges} graph edges')
    conn.close()


if __name__ == '__main__':
    main()

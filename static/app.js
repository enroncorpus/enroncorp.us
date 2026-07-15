/* Enron Corpus Browser — frontend application */

'use strict';

// ============================================================
// State
// ============================================================

const state = {
  employees: [],
  currentOwner: null,
  currentFolder: null,
  emailPage: 1,
  emailTotal: 0,
  isLoadingMore: false,
  isSearching: false,
  searchQuery: '',
  browsePersonEmail: null,  // set when browsing emails for a single address
  network: null,
  networkNodes: null,
  networkEdges: null,
  graphLoaded: false,
  graphMinWeight: 1,
  graphMaxNodes: 1500,
  pendingNodeSelect: null,
};

// ============================================================
// API helpers
// ============================================================

async function api(path) {
  const r = await fetch('/api' + path);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error || r.statusText);
  }
  return r.json();
}

// ============================================================
// Utility helpers
// ============================================================

function fmt_date(ts, date_str) {
  if (!ts && !date_str) return '';
  try {
    const d = ts ? new Date(ts * 1000) : new Date(date_str);
    if (isNaN(d)) return date_str ? date_str.slice(0, 16) : '';
    const now = new Date();
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function fmt_date_long(date_str) {
  if (!date_str) return '';
  try {
    const d = new Date(date_str);
    if (isNaN(d)) return date_str;
    return d.toLocaleString('en-US', {
      weekday: 'short', year: 'numeric', month: 'short',
      day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return date_str;
  }
}

function esc(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function show_toast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ============================================================
// Mobile panel switching
// ============================================================

const IS_MOBILE = () => window.innerWidth <= 768;

function show_mobile_panel(name) {
  if (!IS_MOBILE()) return;
  const map = { employee: 'employee-panel', list: 'list-panel', detail: 'detail-panel' };
  Object.values(map).forEach(id => document.getElementById(id).classList.remove('mobile-active'));
  // employee and list are paired on mobile — asking for either one always
  // shows both, side by side, instead of one full-screen at a time.
  // #app.mobile-split lays them out at 50% width each.
  const paired = name === 'employee' || name === 'list';
  document.getElementById('app').classList.toggle('mobile-split', paired);
  if (paired) {
    document.getElementById('employee-panel').classList.add('mobile-active');
    document.getElementById('list-panel').classList.add('mobile-active');
  } else {
    document.getElementById(map[name]).classList.add('mobile-active');
  }
  document.getElementById('mobile-employees-btn').classList.toggle('active', paired);
}

function init_mobile() {
  // Start on the default About-tab view, same as desktop.
  show_mobile_panel('detail');

  // Single toggle: Employees panel <-> the default tabbed (About/Email/
  // Graph) view. Selecting a folder/email from within Employees still
  // navigates via the existing show_mobile_panel('list'/'detail') calls
  // elsewhere — this button only handles the two-state toggle.
  document.getElementById('mobile-employees-btn').addEventListener('click', () => {
    // employee and list are always paired now (see show_mobile_panel), so
    // checking either one tells us whether we're currently in that view.
    const onFileBrowser = document.getElementById('app').classList.contains('mobile-split');
    if (onFileBrowser) {
      switch_tab('about');
      show_mobile_panel('detail');
    } else {
      show_mobile_panel('employee');
    }
  });

  // On resize back to desktop, clear mobile classes
  window.addEventListener('resize', () => {
    if (!IS_MOBILE()) {
      document.querySelectorAll('#employee-panel, #list-panel, #detail-panel')
        .forEach(el => el.classList.remove('mobile-active'));
    } else if (!document.querySelector('#employee-panel.mobile-active, #list-panel.mobile-active, #detail-panel.mobile-active')) {
      show_mobile_panel('detail');
    }
  });
}

// ============================================================
// Initialization
// ============================================================

// Keeps the Enron logo the same width as the stats row ("517,401 / 150 /
// 79,894") below it — that row is text, so its width shifts with the
// viewport in ways a fixed % on the image can't track.
function sync_logo_width() {
  const stats = document.getElementById('intro-stats');
  const logo = document.getElementById('intro-logo-img');
  if (stats.offsetWidth) logo.style.width = stats.offsetWidth + 'px';
}

async function init() {
  init_mobile();
  sync_logo_width();
  window.addEventListener('resize', sync_logo_width);

  load_graph();

  try {
    state.employees = await api('/employees');
    render_employee_list();
    setup_observers();

  } catch (e) {
    document.getElementById('employee-list').innerHTML =
      `<div class="loading-msg" style="color:#df0032">Error: ${esc(e.message)}</div>`;
  }
}

// ============================================================
// Employee lookup helpers
// ============================================================

function find_employee_by_email(addr) {
  if (!addr) return null;
  const lower = addr.toLowerCase();
  return state.employees.find(e =>
    (e.email && e.email.toLowerCase() === lower) ||
    (e.emails && e.emails.some(em => em.toLowerCase() === lower))
  ) || null;
}

function best_folder(emp) {
  const folders = emp.folders || [];
  return folders.includes('inbox') ? 'inbox'
       : folders.includes('sent_items') ? 'sent_items'
       : folders[0] || '';
}

// ============================================================
// Employee sidebar
// ============================================================

function render_employee_list(filter = '') {
  const container = document.getElementById('employee-list');
  const lower = filter.toLowerCase();
  const filtered = filter
    ? state.employees.filter(e =>
        (e.full_name || e.slug).toLowerCase().includes(lower) ||
        e.slug.toLowerCase().includes(lower))
    : state.employees;

  if (!filtered.length) {
    container.innerHTML = '<div class="loading-msg">No matches.</div>';
    return;
  }

  container.innerHTML = filtered.map(emp => {
    const raw = emp.full_name || emp.slug;
    const name = esc(raw.includes(',') ? raw.split(',').map(s => s.trim()).reverse().join(' ') : raw);
    const slug = esc(emp.slug);
    const folders = emp.folders || [];
    const folder_counts = emp.folder_counts || {};
    const folder_html = folders.map(f => `
      <div class="folder-link" data-owner="${slug}" data-folder="${esc(f)}">
        <span class="folder-name">${esc(f)}</span>
        <span class="folder-count">${(folder_counts[f] || 0).toLocaleString()}</span>
      </div>`
    ).join('');
    return `
      <details class="emp-item" id="emp-${slug}">
        <summary class="emp-summary" data-slug="${slug}">
          <span class="emp-arrow">▶</span>
          <span class="emp-name">${name}</span>
          <span class="emp-count">${(emp.email_count || 0).toLocaleString()}</span>
        </summary>
        <div class="emp-folders">${folder_html}</div>
      </details>`;
  }).join('');

  // Toggle arrow on open/close
  container.querySelectorAll('details.emp-item').forEach(det => {
    det.addEventListener('toggle', () => {
      det.classList.toggle('emp-open', det.open);
    });
  });
}

function set_active_employee(slug) {
  document.querySelectorAll('.emp-summary').forEach(el => el.classList.remove('active-emp'));
  const el = document.querySelector(`.emp-summary[data-slug="${slug}"]`);
  if (el) el.classList.add('active-emp');
}

function set_active_folder(owner, folder) {
  document.querySelectorAll('.folder-link').forEach(el => el.classList.remove('active-folder'));
  const el = document.querySelector(`.folder-link[data-owner="${owner}"][data-folder="${folder}"]`);
  if (el) el.classList.add('active-folder');
}

// Employee filter input
document.getElementById('emp-filter').addEventListener('input', e => {
  render_employee_list(e.target.value);
});

// Inbox filter — drives FTS5 search
document.getElementById('inbox-filter').addEventListener('input', e => {
  clearTimeout(search_debounce);
  const q = e.target.value.trim();
  if (!q) { clear_search(); return; }
  search_debounce = setTimeout(() => do_search(q), 350);
});

document.getElementById('inbox-filter').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    clearTimeout(search_debounce);
    const q = document.getElementById('inbox-filter').value.trim();
    if (q) do_search(q);
  }
  if (e.key === 'Escape') clear_search();
});

// Employee sidebar click delegation
document.getElementById('employee-list').addEventListener('click', e => {
  const folder_link = e.target.closest('.folder-link');
  if (folder_link) {
    const owner = folder_link.dataset.owner;
    const folder = folder_link.dataset.folder;
    select_folder(owner, folder);
    return;
  }
  const summary = e.target.closest('.emp-summary');
  if (summary) {
    const slug = summary.dataset.slug;
    set_active_employee(slug);
    // This click handler (bubble phase on the ancestor list) runs before
    // the browser's native <details> toggle applies, so det.open still
    // reflects the pre-click state: true means this click is about to
    // CLOSE it. Only jump the graph focus when it's actually opening —
    // otherwise collapsing an employee re-selects the circle you just closed.
    const det = summary.closest('details.emp-item');
    const opening = det && !det.open;
    const emp = state.employees.find(x => x.slug === slug);
    if (opening) {
      // Accordion behavior — only one directory open at a time.
      document.querySelectorAll('details.emp-item[open]').forEach(d => {
        if (d !== det) { d.removeAttribute('open'); d.classList.remove('emp-open'); }
      });
      if (emp && emp.email) select_graph_node(emp.email);
    }
    // Closing the last open directory — nothing left selected, so drop
    // back to root instead of leaving the list showing a now-collapsed
    // employee's emails.
    if (!opening) {
      const anyOtherOpen = Array.from(document.querySelectorAll('details.emp-item[open]'))
        .some(d => d !== det);
      if (!anyOtherOpen) {
        // browse_corpus_wide() below already closes this (and any other
        // open) <details> itself. Without preventDefault, the browser's
        // native toggle — which hasn't run yet — fires right after this
        // handler, sees it already closed, and flips it back open.
        e.preventDefault();
        browse_corpus_wide();
      }
    }
  }
});

function select_folder(owner, folder, { expandSidebar = true } = {}) {
  state.currentOwner = owner;
  state.currentFolder = folder;
  state.emailPage = 1;
  state.emailTotal = 0;
  const inbox_input = document.getElementById('inbox-filter');
  if (inbox_input) inbox_input.value = '';
  state.isSearching = false;
  state.searchQuery = '';
  state.browsePersonEmail = null;
  document.getElementById('inbox-filter').value = '';

  const det = document.getElementById(`emp-${owner}`);

  // Collapse all other open employee sections — was gated behind
  // expandSidebar, so a graph node click (expandSidebar:false, e.g. red
  // circle) left whatever directory was already open in the sidebar.
  document.querySelectorAll('details.emp-item').forEach(d => {
    if (d.id !== `emp-${owner}` && d.open) {
      d.open = false;
      d.classList.remove('emp-open');
    }
  });

  if (expandSidebar) {
    // Expand the <details> element so folder links exist in the DOM
    if (det && !det.open) { det.open = true; det.classList.add('emp-open'); }
  }
  set_active_employee(owner);
  set_active_folder(owner, folder);
  // block:'nearest' snaps to whichever edge (top or bottom) the item is
  // closest to, so it reappears at the top or bottom of the sidebar
  // depending on where it already sits, instead of always recentering.
  if (det) det.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  document.getElementById('list-title').textContent =
    `/${owner}/${folder}`;
  document.querySelectorAll('#email-rows .email-row').forEach(el => el.remove());
  document.getElementById('list-empty').classList.add('hidden');
  show_mobile_panel('list');
  load_email_list();
}

// ============================================================
// Email list
// ============================================================

async function load_email_list(append = false) {
  if (state.isLoadingMore) return;
  state.isLoadingMore = true;

  try {
    let data;
    if (state.browsePersonEmail) {
      data = await api(`/person_emails?email=${encodeURIComponent(state.browsePersonEmail)}&page=${state.emailPage}&per_page=50`);
    } else if (state.isSearching) {
      const ownerParam = state.currentOwner ? `&owner=${encodeURIComponent(state.currentOwner)}` : '';
      data = await api(`/search?q=${encodeURIComponent(state.searchQuery)}&page=${state.emailPage}&per_page=50${ownerParam}`);
    } else {
      const folderParam = state.currentFolder ? `&folder=${encodeURIComponent(state.currentFolder)}` : '';
      data = await api(`/emails?owner=${encodeURIComponent(state.currentOwner)}&page=${state.emailPage}&per_page=50${folderParam}`);
    }

    state.emailTotal = data.total;
    if (!append) {
      // Not innerHTML='' — that would also delete #load-more-sentinel,
      // which render_email_rows relocates into this container below.
      document.querySelectorAll('#email-rows .email-row').forEach(el => el.remove());
    }

    render_email_rows(data.emails);
    document.getElementById('list-count').textContent =
      `${state.emailTotal.toLocaleString()} emails`;
    document.getElementById('list-empty').classList.toggle('hidden', state.emailTotal > 0);

  } catch (e) {
    show_toast('Error loading emails: ' + e.message, 4000);
  } finally {
    state.isLoadingMore = false;
  }
}

function render_email_rows(emails) {
  const container = document.getElementById('email-rows');
  const fragment = document.createDocumentFragment();
  for (const em of emails) {
    const div = document.createElement('div');
    div.className = 'email-row';
    div.dataset.id = em.id;
    const sender = em.sender || '(unknown)';
    const date   = fmt_date(em.date_ts, em.date_str);
    const subj   = em.subject || '(no subject)';
    const preview = em.body_preview || '';
    div.innerHTML = `
      <div class="email-row-top">
        <span class="email-row-sender">${esc(sender)}</span>
        <span class="email-row-date">${esc(date)}</span>
      </div>
      <div class="email-row-subject">${esc(subj)}</div>
      <div class="email-row-preview">${esc(preview)}</div>`;
    fragment.appendChild(div);
  }
  container.appendChild(fragment);
  // Move the sentinel to stay the last child — it needs to live inside
  // this scrolling container (not just below it) for IntersectionObserver
  // to ever see it cross into view as the list scrolls. appendChild on an
  // existing node relocates it rather than duplicating it.
  container.appendChild(document.getElementById('load-more-sentinel'));
}

// Click delegation for email rows
document.getElementById('email-rows').addEventListener('click', e => {
  const row = e.target.closest('.email-row');
  if (!row) return;
  const id = parseInt(row.dataset.id, 10);
  if (id) load_email(id, row);
});

// Infinite scroll via IntersectionObserver
function setup_observers() {
  const sentinel = document.getElementById('load-more-sentinel');
  const observer = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && !state.isLoadingMore) {
      const rows_count = document.getElementById('email-rows').children.length;
      if (rows_count < state.emailTotal) {
        state.emailPage += 1;
        load_email_list(true);
      }
    }
  }, { rootMargin: '200px' });
  observer.observe(sentinel);
}

// ============================================================
// Email detail view
// ============================================================

async function load_email(id, row_el) {
  // Highlight row
  document.querySelectorAll('.email-row.active').forEach(r => r.classList.remove('active'));
  if (row_el) row_el.classList.add('active');

  switch_tab('email');
  show_mobile_panel('detail');

  try {
    const em = await api(`/email/${id}`);
    render_email_detail(em);
  } catch (e) {
    show_toast('Error loading email: ' + e.message, 4000);
  }
}

function email_link(addr) {
  const cls = find_employee_by_email(addr) ? 'hdr-email-link emp' : 'hdr-email-link ext';
  return `<a class="${cls}" data-email="${esc(addr)}" href="#">${esc(addr)}</a>`;
}

function render_email_detail(em) {
  document.getElementById('email-placeholder').classList.add('hidden');
  const content = document.getElementById('email-content');
  content.classList.remove('hidden');

  document.getElementById('email-subject').textContent = em.subject || '(no subject)';

  const recipients = (em.recipients || []).slice(0, 20).map(addr =>
    email_link(addr)
  ).join(', ');

  const cc_list = (em.cc || []).slice(0, 20).map(addr =>
    email_link(addr)
  ).join(', ');

  const from_link = em.sender ? email_link(em.sender) : '(unknown)';

  const rows = [
    ['From',    from_link],
    ['To',      recipients || '—'],
    em.cc && em.cc.length ? ['Cc', cc_list] : null,
    ['Date',    esc(fmt_date_long(em.date_str))],
    ['Folder',  esc(`${em.owner} / ${em.folder}`)],
  ].filter(Boolean);

  document.getElementById('email-headers-body').innerHTML =
    rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

  document.getElementById('email-body').textContent = em.body || '(no body)';
}

// Click on email address links in detail view → browse person's emails
document.getElementById('tab-email').addEventListener('click', e => {
  const link = e.target.closest('.hdr-email-link');
  if (!link) return;
  e.preventDefault();
  const addr = link.dataset.email;
  if (addr) {
    // expandSidebar:false keeps the sidebar folder tree collapsed, same as
    // a graph circle click — but this one also jumps to the Graph tab and
    // highlights the matching dot there.
    browse_person(addr, { expandSidebar: false });
    switch_tab('network');
    requestAnimationFrame(() => select_graph_node(addr));
  }
});

function select_graph_node(addr) {
  if (!state.network || !state.networkNodes) {
    state.pendingNodeSelect = addr;
    return;
  }
  // Canvas still hidden means this tab's never been actually fit against
  // real dimensions yet — graphMinScale (if set at all) came from a 0×0
  // auto-fit. Defer instead of focusing now: that produces a corrupted
  // zoom level, and a real focus() started while hidden keeps animating
  // in the background regardless of visibility, racing whatever runs the
  // next time this tab is actually shown.
  if (document.getElementById('network-canvas').classList.contains('hidden')) {
    state.pendingNodeSelect = addr;
    return;
  }
  state.pendingNodeSelect = null;
  state.network.unselectAll();
  const node = state.networkNodes.get(addr);
  if (node) {
    state.network.selectNodes([addr]);
    // Suspended for the duration — enforce_zoom_lock runs every frame and
    // was clamping pan mid-animation using the not-yet-zoomed-in scale's
    // (small) slack, yanking the view back toward center each frame and
    // fighting this focus() before it could reach the actual node.
    state.suppressZoomLock = true;
    // Relative to the current zoomed-out floor rather than a fixed number —
    // a flat 1.5 was tuned before node sizes quadrupled (min:24/max:152),
    // and no longer reads as "zoomed in" against a floor that's now much
    // further out to fit the bigger nodes.
    state.network.focus(addr, {
      scale: (state.graphMinScale || 1) * 6,
      animation: { duration: 600, easingFunction: 'easeInOutQuad' },
    });
  }
}

// ============================================================
// Tab switching
// ============================================================

function switch_tab(name) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.classList.toggle('hidden', p.id !== `tab-${name}`));
  if (name === 'network') {
    const canvas = document.getElementById('network-canvas');
    // graphLoaded flips true as soon as the network is created, not once
    // stabilization actually finishes, so this branch can run while the
    // canvas is still mid-stabilization and hidden behind the loading
    // text. In that case there's nothing to redraw/fit yet —
    // 'stabilizationIterationsDone' will reveal it once ready.
    if (!state.graphLoaded) {
      load_graph();
    } else if (state.network && !canvas.classList.contains('hidden') && !state.suppressZoomLock) {
      // suppressZoomLock true means a select_graph_node() focus() is
      // already animating toward a specific node — e.g. the sidebar can
      // trigger that while this tab is still hidden, and vis's animation
      // loop keeps running regardless of visibility. Fitting to the whole
      // graph here would race that in-flight animation: our fit() shows
      // briefly, then the earlier animation finishes and overrides it,
      // looking like an unrelated snap. Leave it alone and let it land.
      state.graphMinScale = null;
      state.network.redraw();
      state.network.fit({ animation: false });
      // fit()'s own resulting scale/position are the zoom-out floor and
      // recenter target — see enforce_zoom_lock.
      state.graphMinScale = state.network.getScale();
      state.graphDefaultPosition = state.network.getViewPosition();
      set_label_draw_threshold();
      // A sidebar click before this tab was ever shown defers here via
      // select_graph_node's hidden-canvas guard — now that there's a real
      // fit to base the zoom level on, run it.
      if (state.pendingNodeSelect) {
        select_graph_node(state.pendingNodeSelect);
      }
    }
  }
}

document.getElementById('tab-bar').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (btn) switch_tab(btn.dataset.tab);
});

// ============================================================
// Search
// ============================================================

let search_debounce = null;


async function do_search(query) {
  state.isSearching = true;
  state.searchQuery = query;
  state.browsePersonEmail = null;
  state.emailPage = 1;
  state.emailTotal = 0;
  const scope = state.currentOwner ? ` in ${state.currentOwner}` : ' in /';
  document.getElementById('list-title').textContent = `Search: "${query}"${scope}`;
  document.querySelectorAll('#email-rows .email-row').forEach(el => el.remove());
  document.getElementById('list-empty').classList.add('hidden');
  await load_email_list();
}

function clear_search() {
  state.isSearching = false;
  state.searchQuery = '';
  state.browsePersonEmail = null;
  document.getElementById('inbox-filter').value = '';
  document.querySelectorAll('#email-rows .email-row').forEach(el => el.remove());
  if (state.currentOwner && state.currentFolder) {
    state.emailPage = 1;
    document.getElementById('list-title').textContent =
      `/${state.currentOwner}/${state.currentFolder}`;
    load_email_list();
  } else {
    document.getElementById('list-title').textContent = '/';
    document.getElementById('list-count').textContent = '';
  }
}

// ============================================================
// Network graph
// ============================================================

async function load_graph(force = false) {
  if (state.graphLoaded && !force) return;
  // init() kicks this off in the background; if the user reaches the Graph
  // tab before it resolves, switch_tab sees graphLoaded still false and
  // calls this a second time. Two overlapping runs both create/overwrite
  // state.network, leaving a duplicate instance racing the real one.
  if (state.graphLoading) return;
  state.graphLoading = true;
  // Suspend the lock for the whole (re)load — otherwise enforce_zoom_lock
  // keeps clamping the camera against the PREVIOUS layout's stale bounds
  // while physics is actively moving nodes into a new one underneath it.
  state.graphMinScale = null;
  state.graphDefaultPosition = null;

  const loading = document.getElementById('graph-loading');
  loading.textContent = 'Loading nodes.';
  loading.classList.remove('hidden');
  document.getElementById('network-canvas').classList.add('hidden');

  try {
    const min_w = state.graphMinWeight;
    const max_n = state.graphMaxNodes;
    const data = await api(`/graph?min_weight=${min_w}&max_nodes=${max_n}`);

    // Distinct connection count, not total email volume — a shared/system
    // mailbox (e.g. a meeting-room scheduler) can rack up huge email_count
    // through one correspondent, which read as "big = well-connected" when
    // it wasn't. Degree is a more honest proxy for that.
    const degree = new Map();
    for (const e of data.edges) {
      degree.set(e.from, (degree.get(e.from) || 0) + 1);
      degree.set(e.to, (degree.get(e.to) || 0) + 1);
    }

    const nodes_data = data.nodes.map(n => ({
      id:    n.id,
      label: n.email,
      value: degree.get(n.id) || 0,
      group: n.group,
      email: n.email,
      email_count: n.email_count,
    }));

    state.graphNodeTotal = nodes_data.length;
    loading.textContent = `Loading 0/${state.graphNodeTotal} nodes.`;

    const edges_data = data.edges.map((e, i) => ({
      id:    i,
      from:  e.from,
      to:    e.to,
      value: e.value,
    }));

    if (!state.networkNodes) {
      state.networkNodes = new vis.DataSet(nodes_data);
      state.networkEdges = new vis.DataSet(edges_data);
    } else {
      state.networkNodes.clear();
      state.networkEdges.clear();
      state.networkNodes.add(nodes_data);
      state.networkEdges.add(edges_data);
    }

    if (!state.network) {
      state.network = new vis.Network(
        document.getElementById('network-canvas'),
        { nodes: state.networkNodes, edges: state.networkEdges },
        get_network_options()
      );
      state.network.on('selectNode', handle_node_click);
      state.network.on('animationFinished', () => {
        state.suppressZoomLock = false;
      });
      state.network.on('click', params => {
        if (params.nodes.length === 0 && params.edges.length === 0) browse_corpus_wide();
      });
      state.network.on('stabilizationProgress', p => {
        const loaded = Math.round((p.iterations / p.total) * state.graphNodeTotal);
        loading.textContent = `Loading ${loaded}/${state.graphNodeTotal} nodes.`;
      });
      state.network.on('stabilizationIterationsDone', () => {
        state.network.setOptions({ physics: { enabled: false } });
        loading.classList.add('hidden');
        document.getElementById('network-canvas').classList.remove('hidden');
        // The network was constructed and internally auto-fit while this
        // container was still self-hidden (0×0) — that auto-fit is garbage.
        // Redraw+fit now that it has real dimensions, same as the "exit and
        // re-enter the tab" path does.
        state.network.redraw();
        state.network.fit({ animation: false });
        // fit()'s own resulting scale/position are the zoom-out floor and
        // recenter target — see enforce_zoom_lock.
        state.graphMinScale = state.network.getScale();
        state.graphDefaultPosition = state.network.getViewPosition();
        set_label_draw_threshold();
        if (state.pendingNodeSelect) {
          select_graph_node(state.pendingNodeSelect);
        }
      });
      // Checked every redraw frame instead of on 'zoom'/'dragEnd' — those
      // fire on discrete user actions, so a quick zoom-in-then-pan-back
      // could slip past before either handler ran. This has no such gap:
      // whatever moved the view, if it's at/below default scale, snap it back.
      state.network.on('afterDrawing', enforce_zoom_lock);
    } else {
      state.network.setOptions({ physics: { enabled: true, stabilization: { iterations: 300 } } });
      state.network.stabilize(300);
    }

    state.graphLoaded = true;

  } catch (e) {
    loading.textContent = 'Error: ' + e.message;
    setTimeout(() => loading.classList.add('hidden'), 4000);
  } finally {
    state.graphLoading = false;
  }
}

// vis's node label visibility check is `fontSize*scale >= drawThreshold-1`
// — an absolute scale value, not a percentage. graphMinScale is this
// specific graph's actual zoomed-out floor (varies with node spacing/
// count), so "50% zoom" only means something relative to it: 1.5x more
// zoomed in than the floor. A hardcoded absolute number (e.g. 0.5) could
// sit entirely outside this graph's real scale range and never be reached.
function set_label_draw_threshold() {
  const fontSize = 11;
  const targetScale = state.graphMinScale * 1.5;
  state.network.setOptions({
    nodes: { scaling: { label: { drawThreshold: fontSize * targetScale + 1 } } },
  });
}

// Can't zoom out past the default fit — same mechanism proven working for
// the initial load (graphMinScale/graphDefaultPosition captured straight
// from fit()'s own result), just applied every frame. No independent pan
// boundary while zoomed in — that's what kept breaking; this only ever
// acts once you cross back below the floor, snapping straight to exactly
// where fit() put the camera.
function enforce_zoom_lock() {
  if (state.suppressZoomLock || !state.graphMinScale || !state.graphDefaultPosition) return;
  if (state.network.getScale() < state.graphMinScale) {
    state.network.moveTo({
      scale: state.graphMinScale,
      position: state.graphDefaultPosition,
      animation: false,
    });
  }
}

function get_network_options() {
  return {
    nodes: {
      // Label draw threshold is set dynamically once graphMinScale is known
      // — see set_label_draw_threshold() — since vis's `scale` is a raw
      // world-to-pixel ratio specific to this graph's spread, not a percent.
      scaling: { min: 24, max: 152 },
      font: { color: '#111111', size: 11, face: 'Courier New' },
      borderWidth: 0.5,
      borderWidthSelected: 1.5,
      shadow: false,
    },
    edges: {
      scaling: { min: 0.3, max: 4 },
      color: { color: '#7dd3fc', highlight: '#007bc2', hover: '#007bc2', opacity: 0.7 },
      smooth: false,
      arrows: { to: { enabled: false } },
      hoverWidth: 2,
      selectionWidth: 3,
    },
    groups: {
      employee: {
        shape: 'dot',
        color: {
          background: '#df0032',
          border: '#fde8ec',
          highlight: { background: '#fde8ec', border: '#df0032' },
          hover:      { background: '#df0032', border: '#fde8ec' },
        },
      },
      external: {
        shape: 'dot',
        color: {
          background: '#009655',
          border: '#edf7f1',
          highlight: { background: '#edf7f1', border: '#009655' },
          hover:      { background: '#009655', border: '#edf7f1' },
        },
      },
    },
    physics: {
      enabled: true,
      solver: 'forceAtlas2Based',
      forceAtlas2Based: {
        gravitationalConstant: -300,
        centralGravity: 0.005,
        springLength: 300,
        springConstant: 0.08,
        damping: 0.9,
        avoidOverlap: 0.5,
      },
      stabilization: { enabled: true, iterations: 300, updateInterval: 10, fit: true },
      maxVelocity: 50,
      minVelocity: 0.5,
      timestep: 0.35,
    },
    layout: { improvedLayout: false },
    interaction: {
      hover: true,
      zoomView: true,
      zoomSpeed: 0.5, // vis default is 1 (±10%/tick) — halved for gentler steps
      dragView: true,
      navigationButtons: false,
      keyboard: false,
      multiselect: false,
    },
  };
}

function handle_node_click(params) {
  const node_id = params.nodes[0];
  const node = state.networkNodes.get(node_id);
  const addr = node.email || node.id;

  browse_person(addr, { expandSidebar: false });
  // Same zoom-in select_graph_node() does for a sidebar/email-link jump —
  // clicking the circle directly should feel the same as clicking its name.
  select_graph_node(addr);
}

// Graph controls
document.getElementById('graph-reload-btn').addEventListener('click', () => {
  state.graphLoaded = false;
  load_graph(true);
});

// ============================================================
// Corpus-wide mode (graph background click)
// ============================================================

function browse_corpus_wide() {
  document.querySelectorAll('.emp-summary').forEach(el => el.classList.remove('active-emp'));
  document.querySelectorAll('.folder-link').forEach(el => el.classList.remove('active-folder'));
  document.querySelectorAll('details.emp-item[open]').forEach(el => el.removeAttribute('open'));
  state.currentOwner = null;
  state.currentFolder = null;
  state.browsePersonEmail = null;
  state.isSearching = false;
  state.searchQuery = '';
  state.emailPage = 1;
  state.emailTotal = 0;
  document.getElementById('inbox-filter').value = '';
  document.querySelectorAll('#email-rows .email-row').forEach(el => el.remove());
  document.getElementById('list-empty').classList.add('hidden');
  document.getElementById('list-title').textContent = '/';
  document.getElementById('list-count').textContent = '';
}

// ============================================================
// Browse person emails (from network click or email address click)
// ============================================================

function browse_person(addr, options) {
  // If this address belongs to an Enron employee, navigate to their mailbox
  const emp = find_employee_by_email(addr);
  if (emp) {
    select_folder(emp.slug, best_folder(emp), options);
    return;
  }

  // External address — clear employee/folder highlights, close open directories
  document.querySelectorAll('.emp-summary').forEach(el => el.classList.remove('active-emp'));
  document.querySelectorAll('.folder-link').forEach(el => el.classList.remove('active-folder'));
  document.querySelectorAll('details.emp-item[open]').forEach(el => el.removeAttribute('open'));
  state.browsePersonEmail = addr;
  state.isSearching = false;
  state.searchQuery = '';
  state.emailPage = 1;
  state.emailTotal = 0;
  document.querySelectorAll('#email-rows .email-row').forEach(el => el.remove());
  document.getElementById('list-empty').classList.add('hidden');
  document.getElementById('list-title').textContent = `Emails: ${addr}`;
  show_mobile_panel('list');
  load_email_list();
}

// ============================================================
// Boot
// ============================================================

document.addEventListener('DOMContentLoaded', init);

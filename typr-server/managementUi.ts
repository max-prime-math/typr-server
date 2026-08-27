export const MANAGEMENT_LOGIN_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sign in · Typr Companion</title>
  <style>
    :root { color-scheme:dark; --bg:#0b0d12; --panel:#151b27; --line:#293245; --text:#edf2ff; --muted:#9aa6bd; --blue:#2864d7; --red:#ff9caf; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; padding:20px; background:radial-gradient(circle at 20% 0,#1a2948 0,transparent 42%),var(--bg); color:var(--text); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
    main { width:min(430px,100%); padding:28px; background:linear-gradient(145deg,#171e2bee,#10151fee); border:1px solid var(--line); border-radius:16px; box-shadow:0 20px 70px #0007; }
    h1 { margin:0 0 6px; font-size:25px; }
    p { margin:0 0 22px; color:var(--muted); }
    label { display:grid; gap:7px; margin:14px 0; font-weight:650; }
    input { width:100%; color:var(--text); background:#0c1018; border:1px solid var(--line); border-radius:9px; padding:11px 12px; font:inherit; }
    input:focus { outline:2px solid #3977ed; outline-offset:1px; }
    button { width:100%; margin-top:10px; color:white; background:var(--blue); border:1px solid #3977ed; border-radius:9px; padding:11px 14px; font:inherit; font-weight:700; cursor:pointer; }
    button:disabled { opacity:.55; cursor:wait; }
    #error { min-height:20px; margin:12px 0 0; color:var(--red); }
  </style>
</head>
<body>
  <main>
    <h1>Typr Companion</h1>
    <p>Sign in to the private management console.</p>
    <form id="login">
      <label>Username<input id="username" name="username" autocomplete="username" required minlength="3" maxlength="64"></label>
      <label>Password<input id="password" name="password" type="password" autocomplete="current-password" required minlength="24" maxlength="1024"></label>
      <button id="submit" type="submit">Sign in</button>
      <div id="error" role="alert" aria-live="polite"></div>
    </form>
  </main>
  <script>
    'use strict';
    document.getElementById('login').addEventListener('submit', async function (event) {
      event.preventDefault();
      var button = document.getElementById('submit');
      var error = document.getElementById('error');
      button.disabled = true; error.textContent = '';
      try {
        var response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value })
        });
        var value = await response.json();
        if (!response.ok) throw new Error(value && value.error ? value.error.message : 'Sign-in failed.');
        window.location.replace('/');
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : 'Sign-in failed.';
        document.getElementById('password').value = '';
        document.getElementById('password').focus();
      } finally { button.disabled = false; }
    });
  </script>
</body>
</html>`;

export const MANAGEMENT_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Typr Companion Console</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0d12; --panel:#121722; --panel2:#171e2b; --line:#293245; --text:#edf2ff; --muted:#8f9bb3; --blue:#76a9ff; --green:#43d7a2; --amber:#f5bd68; --red:#ff758f; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at 15% -10%,#1a2948 0,transparent 35%),var(--bg); color:var(--text); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
    button,input { font:inherit; }
    button { color:var(--text); border:1px solid var(--line); background:#1b2434; border-radius:9px; padding:8px 12px; cursor:pointer; }
    button:hover { border-color:#53627d; background:#222d41; }
    button.primary { background:#2864d7; border-color:#3977ed; }
    button.danger { color:#ffc4ce; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .shell { width:min(1420px,calc(100% - 32px)); margin:0 auto; padding:28px 0 50px; }
    header { display:flex; justify-content:space-between; align-items:flex-end; gap:24px; margin-bottom:24px; }
    .header-actions { display:flex; gap:12px; align-items:center; }
    h1 { font-size:26px; margin:0; letter-spacing:-.02em; }
    h2 { font-size:16px; margin:0; }
    .subtitle,.muted { color:var(--muted); }
    .statusline { display:flex; gap:12px; align-items:center; color:var(--muted); }
    .pulse { width:9px; height:9px; border-radius:50%; background:var(--green); box-shadow:0 0 0 5px #43d7a21b; }
    .grid { display:grid; grid-template-columns:minmax(0,1.65fr) minmax(330px,.85fr); gap:18px; }
    .panel { background:linear-gradient(145deg,#151b27ee,#10151fee); border:1px solid var(--line); border-radius:14px; overflow:hidden; box-shadow:0 16px 50px #0004; }
    .panelhead { padding:16px 18px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:12px; }
    .services { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:10px; padding:14px; }
    .service { text-align:left; min-height:126px; padding:14px; background:var(--panel2); }
    .service.active { outline:2px solid #4d83ee; border-color:transparent; }
    .service-top { display:flex; justify-content:space-between; gap:8px; align-items:center; }
    .service h3 { margin:0; font-size:14px; }
    .service p { color:var(--muted); margin:10px 0 0; min-height:40px; }
    .badge { display:inline-flex; border-radius:999px; padding:3px 8px; font-size:11px; font-weight:700; letter-spacing:.02em; background:#ffffff0c; border:1px solid var(--line); }
    .ready { color:var(--green); } .busy { color:var(--blue); } .degraded,.detected { color:var(--amber); } .unavailable,.error { color:var(--red); }
    .meta { margin-top:10px; font-size:12px; color:#aeb9cd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .logbar { padding:10px 14px; border-top:1px solid var(--line); border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    .logbar button.active { color:var(--blue); border-color:#4d83ee; }
    .log-option { display:flex; align-items:center; gap:7px; margin-left:auto; color:var(--muted); font-size:12px; white-space:nowrap; cursor:pointer; }
    .log-option input { width:16px; height:16px; margin:0; }
    .logs { height:420px; overflow:auto; padding:6px 0; background:#0c1018; }
    .empty { color:var(--muted); text-align:center; padding:60px 18px; }
    .event { padding:10px 14px; border-bottom:1px solid #202838; display:grid; grid-template-columns:90px 110px 1fr; gap:10px; }
    .event:hover { background:#ffffff05; }
    .event time,.event .kind { color:var(--muted); font:12px ui-monospace,SFMono-Regular,Consolas,monospace; }
    .event .message { overflow-wrap:anywhere; }
    .event details { grid-column:3; }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; color:#bdc8dd; font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; background:#080b11; border:1px solid #202838; border-radius:8px; padding:10px; max-height:240px; overflow:auto; }
    .sidebody { padding:16px; }
    .setting { padding:12px; background:var(--panel2); border:1px solid var(--line); border-radius:10px; margin-bottom:14px; }
    .setting label { display:flex; align-items:center; justify-content:space-between; gap:14px; font-weight:600; }
    .setting input { width:18px; height:18px; }
    .setting p { margin:7px 0 0; font-size:12px; color:var(--muted); }
    .sectiontitle { display:flex; align-items:center; justify-content:space-between; margin:20px 0 10px; }
    .provider { border:1px solid var(--line); background:var(--panel2); border-radius:10px; padding:12px; margin-bottom:9px; }
    .providerhead { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
    .provider p { margin:5px 0 0; color:var(--muted); font-size:12px; }
    .provider-actions { display:flex; align-items:center; gap:7px; flex-shrink:0; }
    .provider-actions button { padding:5px 8px; font-size:12px; }
    .provider-progress { margin-top:8px; color:var(--blue); font-size:12px; }
    .data-root { overflow-wrap:anywhere; }
    .user { border:1px solid var(--line); background:var(--panel2); border-radius:10px; padding:12px; margin-bottom:9px; }
    .userhead { display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .user-actions { display:flex; gap:6px; }
    .user-actions button { padding:5px 8px; font-size:12px; }
    .keys { margin-top:10px; display:grid; gap:6px; }
    .key { display:flex; justify-content:space-between; align-items:center; gap:8px; border-top:1px solid var(--line); padding-top:8px; color:#bdc8dd; font-size:12px; }
    code { color:#9ebeff; }
    dialog { width:min(620px,calc(100% - 30px)); color:var(--text); background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:20px; }
    dialog::backdrop { background:#000b; }
    dialog h2 { margin-bottom:8px; }
    .dialog-actions { display:flex; justify-content:flex-end; gap:8px; }
    .notice { border:1px solid #735a2d; background:#362c1b; color:#ffe1a7; border-radius:9px; padding:10px; margin:12px 0; }
    @media (max-width:900px) { .grid { grid-template-columns:1fr; } header { align-items:flex-start; flex-direction:column; } .event { grid-template-columns:74px 90px 1fr; } }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div><h1>Typr Companion Console</h1><div class="subtitle">Local services, access, and live activity</div></div>
      <div class="header-actions"><div class="statusline"><span class="pulse" id="pulse"></span><span id="connection">Connecting…</span><span id="ports"></span></div><button id="logout" hidden>Sign out</button></div>
    </header>
    <div class="grid">
      <section class="panel">
        <div class="panelhead"><div><h2>Services</h2><span class="muted" id="serviceSummary"></span></div><button id="refreshServices">Refresh providers</button></div>
        <div class="services" id="services"></div>
        <div class="logbar"><button class="active" data-service="*">All activity</button><span class="muted" id="logTitle">Newest events appear live</span><label class="log-option"><input type="checkbox" id="showApiRequests">Show API requests</label></div>
        <div class="logs" id="logs"></div>
      </section>
      <aside class="panel">
        <div class="panelhead"><h2>Access control</h2><span class="badge" id="persistence"></span></div>
        <div class="sidebody">
          <div class="sectiontitle"><h2>Providers and workspace</h2></div>
          <div class="setting"><strong>Managed data</strong><p class="data-root" id="dataRoot"></p><p id="workspaceSummary"></p></div>
          <div id="managedProviders"></div>
          <div class="setting">
            <label>Require API keys <input type="checkbox" id="requireKeys"></label>
            <p>When enabled, service HTTP and WebSocket requests must authenticate. Remote container management has a separate administrator sign-in.</p>
          </div>
          <div class="sectiontitle"><h2>Users and keys</h2><button class="primary" id="addUser">Add user</button></div>
          <div id="users"></div>
        </div>
      </aside>
    </div>
  </main>
  <dialog id="secretDialog"><h2>New API key</h2><p class="notice">Copy this value now. Companion stores only its hash and cannot show it again.</p><pre id="secret"></pre><div class="dialog-actions"><button id="copySecret">Copy</button><button id="closeSecret">Done</button></div></dialog>
  <script>
    'use strict';
    var state = { services: [], access: { users: [], keys: [], requireApiKeys: false }, activity: [], management: null, providerManagement: { enabled: false, providers: [], jobs: [] } };
    var selectedService = '*';
    var showApiRequests = false;
    var maxClientEvents = 1000;
    var providerPoll = null;
    var managementHeader = { 'Content-Type': 'application/json', 'X-Typr-Management': '1' };

    function el(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    async function request(path, options) {
      var response = await fetch(path, options);
      var value = response.status === 204 ? null : await response.json();
      if (response.status === 401) { window.location.replace('/login'); throw new Error('Your management session expired.'); }
      if (!response.ok) throw new Error(value && value.error ? value.error.message : 'Request failed (' + response.status + ').');
      return value;
    }

    async function load() {
      state = await request('/api/snapshot');
      if (state.management && state.management.csrfToken) managementHeader['X-Typr-CSRF'] = state.management.csrfToken;
      document.getElementById('logout').hidden = !(state.management && state.management.authenticated);
      document.getElementById('ports').textContent = 'Service :' + state.servicePort + ' · GUI :' + state.managementPort;
      render();
      connectEvents();
    }

    function render() {
      renderServices(); renderLogs(); renderProviders(); renderAccess();
      document.getElementById('persistence').textContent = state.access.persistent ? 'Persisted' : 'Session only';
      document.getElementById('requireKeys').checked = state.access.requireApiKeys;
      document.getElementById('showApiRequests').checked = showApiRequests;
    }

    function renderServices() {
      var root = document.getElementById('services'); root.replaceChildren();
      document.querySelector('[data-service="*"]').classList.toggle('active', selectedService === '*');
      var selected = state.services.find(function (service) { return service.id === selectedService; });
      document.getElementById('logTitle').textContent = selected ? selected.name + ' activity' : 'Newest events appear live';
      var ready = state.services.filter(function (service) { return service.status === 'ready' || service.status === 'busy'; }).length;
      document.getElementById('serviceSummary').textContent = ready + ' ready · ' + state.services.length + ' registered';
      state.services.forEach(function (service) {
        var card = el('button', 'service' + (selectedService === service.id ? ' active' : ''));
        card.type = 'button';
        var top = el('div', 'service-top');
        top.append(el('h3', '', service.name), el('span', 'badge ' + service.status, service.status));
        card.append(top, el('p', '', service.description));
        var meta = service.provider ? (service.provider.version || service.provider.executable || service.kind) : service.kind;
        card.append(el('div', 'meta', (service.advertised ? 'Advertised · ' : 'Provider · ') + meta));
        card.onclick = function () { selectedService = service.id; renderServices(); renderLogs(); };
        root.append(card);
      });
    }

    function renderLogs() {
      var root = document.getElementById('logs'); root.replaceChildren();
      var events = state.activity.filter(function (event) {
        var matchesService = selectedService === '*' || event.serviceId === selectedService;
        var isApiRequest = event.type === 'request-started' || event.type === 'request-completed';
        return matchesService && (showApiRequests || !isApiRequest);
      });
      if (!events.length) { root.append(el('div', 'empty', 'No activity matches the current filters.')); return; }
      events.slice().reverse().forEach(function (event) {
        var row = el('div', 'event ' + event.level);
        var time = el('time', '', new Date(event.timestamp).toLocaleTimeString());
        var kind = el('span', 'kind', event.serviceId);
        var message = el('div', 'message', event.message);
        row.append(time, kind, message);
        if (event.details) {
          var details = el('details'); details.append(el('summary', '', 'Service log'), el('pre', '', event.details)); row.append(details);
        }
        root.append(row);
      });
    }

    function renderAccess() {
      var root = document.getElementById('users'); root.replaceChildren();
      if (!state.access.users.length) { root.append(el('div', 'empty', 'Create a user, issue a key, then enable API-key enforcement.')); return; }
      state.access.users.forEach(function (user) {
        var card = el('div', 'user');
        var head = el('div', 'userhead');
        var title = el('div'); title.append(el('strong', '', user.name), el('div', 'muted', user.disabled ? 'Disabled' : 'Enabled'));
        var actions = el('div', 'user-actions');
        var keyButton = el('button', '', 'New key'); keyButton.disabled = user.disabled; keyButton.onclick = function () { createKey(user); };
        var toggle = el('button', user.disabled ? '' : 'danger', user.disabled ? 'Enable' : 'Disable'); toggle.onclick = function () { setUserDisabled(user, !user.disabled); };
        actions.append(keyButton, toggle); head.append(title, actions); card.append(head);
        var keys = el('div', 'keys');
        state.access.keys.filter(function (key) { return key.userId === user.id; }).forEach(function (key) {
          var row = el('div', 'key');
          var label = el('span', '', key.label + ' · '); label.append(el('code', '', key.prefix + '…'));
          if (key.revokedAt) label.append(document.createTextNode(' · revoked'));
          var revoke = el('button', 'danger', 'Revoke'); revoke.disabled = Boolean(key.revokedAt); revoke.onclick = function () { revokeKey(key); };
          row.append(label, revoke); keys.append(row);
        });
        card.append(keys); root.append(card);
      });
    }

    function renderProviders() {
      var management = state.providerManagement || { enabled: false, providers: [], jobs: [] };
      document.getElementById('dataRoot').textContent = management.enabled ? management.dataRoot : 'Disabled · configure TYPR_COMPANION_DATA_ROOT';
      var workspace = state.services.find(function (service) { return service.id === 'workspace'; });
      document.getElementById('workspaceSummary').textContent = workspace ? workspace.description : 'No managed workspace is configured.';
      var root = document.getElementById('managedProviders'); root.replaceChildren();
      management.providers.forEach(function (provider) {
        var card = el('div', 'provider');
        var head = el('div', 'providerhead');
        var title = el('div');
        title.append(el('strong', '', provider.name + ' ' + provider.version), el('p', '', provider.description));
        var actions = el('div', 'provider-actions');
        var job = management.jobs.find(function (candidate) {
          return candidate.providerId === provider.id && candidate.status !== 'completed' && candidate.status !== 'failed';
        });
        if (provider.installed) actions.append(el('span', 'badge ready', provider.active ? 'Active' : 'Installed'));
        else if (!provider.supported) actions.append(el('span', 'badge unavailable', 'Unsupported'));
        if (!provider.installed && provider.supported && management.enabled) {
          var install = el('button', 'primary', job ? 'Installing…' : 'Install');
          install.disabled = Boolean(job); install.onclick = function () { installProvider(provider); }; actions.append(install);
        }
        if (provider.installed && provider.kind === 'tex-distribution' && !provider.active) {
          var activate = el('button', '', 'Activate'); activate.onclick = function () { activateProvider(provider); }; actions.append(activate);
        }
        head.append(title, actions); card.append(head);
        if (job) {
          var percent = job.totalBytes ? Math.min(100, Math.round(job.downloadedBytes / job.totalBytes * 100)) : 0;
          card.append(el('div', 'provider-progress', job.status + (job.status === 'downloading' ? ' · ' + percent + '%' : '')));
        }
        var failed = management.jobs.find(function (candidate) { return candidate.providerId === provider.id && candidate.status === 'failed'; });
        if (failed) card.append(el('div', 'provider-progress unavailable', failed.error || 'Installation failed.'));
        root.append(card);
      });
      var pending = management.jobs.some(function (job) { return job.status !== 'completed' && job.status !== 'failed'; });
      if (providerPoll) { clearTimeout(providerPoll); providerPoll = null; }
      if (pending) providerPoll = setTimeout(function () { refreshSnapshot().catch(function () {}); }, 1000);
    }

    function connectEvents() {
      var stream = new EventSource('/api/events');
      stream.onopen = function () { document.getElementById('connection').textContent = 'Live'; document.getElementById('pulse').style.background = 'var(--green)'; };
      stream.onerror = function () { document.getElementById('connection').textContent = 'Reconnecting…'; document.getElementById('pulse').style.background = 'var(--amber)'; };
      stream.addEventListener('activity', function (message) {
        var event = JSON.parse(message.data);
        if (state.activity.some(function (current) { return current.id === event.id; })) return;
        state.activity.push(event); if (state.activity.length > maxClientEvents) state.activity.shift();
        var service = state.services.find(function (candidate) { return candidate.id === event.serviceId; });
        if (service && (event.type === 'request-started' || event.type === 'session-opened')) { service.active += 1; service.status = 'busy'; }
        if (service && (event.type === 'request-completed' || event.type === 'session-closed')) { service.active = Math.max(0, service.active - 1); if (service.active === 0 && service.status === 'busy') service.status = 'ready'; }
        renderServices(); renderLogs();
      });
    }

    async function refreshSnapshot() { state = await request('/api/snapshot'); render(); }
    async function mutate(path, method, body) { return request(path, { method: method, headers: managementHeader, body: body === undefined ? undefined : JSON.stringify(body) }); }

    document.getElementById('refreshServices').onclick = async function () {
      try { await mutate('/api/services/refresh', 'POST', {}); await refreshSnapshot(); } catch (error) { alert(error.message); }
    };
    async function installProvider(provider) {
      if (!confirm('Download and install verified ' + provider.name + ' ' + provider.version + '?')) return;
      try { await mutate('/api/providers/' + encodeURIComponent(provider.id) + '/install', 'POST', {}); await refreshSnapshot(); }
      catch (error) { alert(error.message); }
    }
    async function activateProvider(provider) {
      try { await mutate('/api/providers/' + encodeURIComponent(provider.id), 'PATCH', { active: true }); await refreshSnapshot(); }
      catch (error) { alert(error.message); }
    }
    document.getElementById('addUser').onclick = async function () {
      var name = prompt('User name'); if (!name) return;
      try { await mutate('/api/users', 'POST', { name: name }); await refreshSnapshot(); } catch (error) { alert(error.message); }
    };
    document.getElementById('requireKeys').onchange = async function (event) {
      try { await mutate('/api/settings', 'PATCH', { requireApiKeys: event.target.checked }); await refreshSnapshot(); }
      catch (error) { event.target.checked = !event.target.checked; alert(error.message); }
    };
    document.getElementById('showApiRequests').onchange = function (event) {
      showApiRequests = event.target.checked;
      try { localStorage.setItem('typr-companion.show-api-requests', String(showApiRequests)); } catch (error) {}
      renderLogs();
    };
    async function setUserDisabled(user, disabled) {
      try { await mutate('/api/users/' + encodeURIComponent(user.id), 'PATCH', { disabled: disabled }); await refreshSnapshot(); } catch (error) { alert(error.message); }
    }
    async function createKey(user) {
      var label = prompt('Key label', 'Typr client'); if (!label) return;
      try {
        var result = await mutate('/api/users/' + encodeURIComponent(user.id) + '/keys', 'POST', { label: label });
        document.getElementById('secret').textContent = result.secret; document.getElementById('secretDialog').showModal(); await refreshSnapshot();
      } catch (error) { alert(error.message); }
    }
    async function revokeKey(key) {
      if (!confirm('Revoke API key "' + key.label + '"?')) return;
      try { await mutate('/api/keys/' + encodeURIComponent(key.id), 'DELETE'); await refreshSnapshot(); } catch (error) { alert(error.message); }
    }
    document.getElementById('copySecret').onclick = function () { navigator.clipboard.writeText(document.getElementById('secret').textContent); };
    document.getElementById('closeSecret').onclick = function () { document.getElementById('secretDialog').close(); document.getElementById('secret').textContent = ''; };
    document.getElementById('logout').onclick = async function () {
      try { await mutate('/api/auth/logout', 'POST', {}); } finally { window.location.replace('/login'); }
    };
    document.querySelector('[data-service="*"]').onclick = function () { selectedService = '*'; renderServices(); renderLogs(); };
    try { showApiRequests = localStorage.getItem('typr-companion.show-api-requests') === 'true'; } catch (error) {}
    load().catch(function (error) { document.getElementById('connection').textContent = error.message; document.getElementById('pulse').style.background = 'var(--red)'; });
  </script>
</body>
</html>`;

/**
 * @file Remote Explorer 面板注入脚本
 * @description 此文件内容被注入到 dsh 主页面中，创建远程资源管理器面板。
 *              不使用 ES 模块语法（直接在页面全局作用域执行）。
 *              通过 webServer.tapIndex 在 </body> 前注入 <script> 标签。
 */
(function () {
  if (window.__dshRemoteSSH) return;
  window.__dshRemoteSSH = true;

  var ws = null;
  var pending = new Map();
  var nextId = 1;
  var hosts = [];

  function connectWS() {
    var wsUrl = 'ws://' + location.host + '/remote-ssh/ws';
    ws = new WebSocket(wsUrl);
    ws.onopen = function () { refreshHosts(); };
    ws.onclose = function () { setTimeout(connectWS, 3000); };
    ws.onmessage = function (e) {
      var msg = JSON.parse(e.data);
      if (msg.type === 'event' && msg.event === 'stateChange') { onStateChange(msg.data); return; }
      if (msg.id && pending.has(msg.id)) {
        var p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    };
  }

  function rpc(method, params) {
    return new Promise(function (resolve, reject) {
      var id = String(nextId++);
      pending.set(id, { resolve: resolve, reject: reject });
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }

  function refreshHosts() {
    rpc('refreshSshConfig').then(function () {
      return rpc('listSshHosts');
    }).then(function (h) {
      hosts = h;
      renderHostList();
      log('已读取 ~/.ssh/config，共 ' + hosts.length + ' 个主机', 'ok');
    }).catch(function (e) { log('刷新失败: ' + e.message, 'err'); });
  }

  function renderHostList() {
    var el = document.getElementById('drs-host-list');
    if (!el) return;
    el.innerHTML = '';
    if (hosts.length === 0) {
      el.innerHTML = '<div style="padding:12px;color:#555;font-size:12px;">~/.ssh/config 中无主机配置</div>';
      return;
    }
    hosts.forEach(function (h) {
      var item = document.createElement('div');
      item.style.cssText = 'padding:8px;border-bottom:1px solid #0f3460;display:flex;justify-content:space-between;align-items:center;cursor:pointer;';
      item.onmouseenter = function () { item.style.background = '#16213e'; };
      item.onmouseleave = function () { item.style.background = ''; };
      var info = (h.user ? h.user + '@' : '') + h.hostName + ':' + h.port;
      var jump = h.hasProxyJump ? '<div style="font-size:10px;color:#f0a500;margin-top:1px;">🔄 跳板机: ' + h.proxyJump + '</div>' : '';
      item.innerHTML = '<div style="flex:1;"><div style="font-weight:500;font-size:13px;">' + h.alias + '</div><div style="font-size:11px;color:#888;margin-top:2px;">' + info + '</div>' + jump + '</div>';
      var btn = document.createElement('button');
      btn.textContent = '连接';
      btn.style.cssText = 'background:#e94560;color:white;border:none;border-radius:3px;padding:4px 12px;cursor:pointer;font-size:11px;';
      btn.onclick = function (e) { e.stopPropagation(); connectHost(h.alias); };
      item.appendChild(btn);
      el.appendChild(item);
    });
  }

  function connectHost(alias) {
    log('正在连接 ' + alias + '...', 'info');
    rpc('activate', { alias: alias }).then(function (r) {
      log(r ? '连接成功' : '连接失败', r ? 'ok' : 'err');
    }).catch(function (e) { log('连接失败: ' + e.message, 'err'); });
  }

  function disconnectHost() {
    rpc('deactivate', {}).then(function () { log('已断开', 'info'); }).catch(function (e) { log('断开失败: ' + e.message, 'err'); });
  }

  function reconnectHost() {
    rpc('reconnect', {}).then(function (r) { log(r ? '重连成功' : '重连失败', r ? 'ok' : 'err'); }).catch(function (e) { log('重连失败: ' + e.message, 'err'); });
  }

  function loadHistory() {
    rpc('history', {}).then(function (r) {
      var el = document.getElementById('drs-history-list');
      if (!el) return;
      if (!r || r.length === 0) { el.innerHTML = '<div style="color:#555;">暂无历史</div>'; return; }
      el.innerHTML = r.slice(0, 8).map(function (h) {
        var rm = { manual: '手动断开', lost: '连接丢失', failed: '连接失败', null: '进行中' };
        return '<div style="padding:2px 0;border-bottom:1px solid #0f3460;"><span style="color:#aaa;">' + h.hostAlias + '</span><span style="color:#888;float:right;">' + (rm[h.endReason] || '—') + '</span>' + (h.lastError ? '<div style="color:#e94560;font-size:10px;">' + h.lastError.slice(0, 60) + '</div>' : '') + '</div>';
      }).join('');
    }).catch(function () {});
  }

  function onStateChange(event) {
    log('状态: ' + event.state + ' ' + (event.message || ''), event.state === 'ready' ? 'ok' : (event.state === 'failed' || event.state === 'lost') ? 'err' : 'info');
    var el = document.getElementById('drs-status');
    if (!el) return;
    var labels = { disconnected: '未连接', connecting: '连接中...', verifying: '验证中...', ready: '已连接', lost: '连接丢失', failed: '连接失败', reconnecting: '重连中...' };
    el.textContent = labels[event.state] || event.state;
    el.style.color = (event.state === 'ready') ? '#00b894' : (event.state === 'failed' || event.state === 'lost') ? '#e94560' : '#aaa';
    var rb = document.getElementById('drs-reconnect');
    if (rb) rb.style.display = (event.state === 'lost' || event.state === 'failed') ? '' : 'none';
    var ex = document.getElementById('drs-explorer');
    if (ex) ex.style.display = event.state === 'ready' ? 'block' : 'none';
    if (event.state === 'ready' || event.state === 'disconnected') loadHistory();
  }

  function browseRemote() {
    var path = document.getElementById('drs-path').value;
    if (!path) return;
    log('浏览: ' + path, 'info');
    rpc('listRemoteDir', { path: path }).then(function (entries) {
      var el = document.getElementById('drs-files');
      if (!entries || entries.length === 0) { el.innerHTML = '<div style="padding:6px;color:#555;">空目录</div>'; return; }
      el.innerHTML = entries.map(function (e) {
        var name = e.name || '?';
        var type = e.type || e.kind || 'unknown';
        var isDir = type === 'directory';
        var fp = path.endsWith('/') ? path + name : path + '/' + name;
        return '<div data-' + (isDir ? 'dir' : 'file') + '="' + fp + '" style="padding:3px 8px;cursor:pointer;border-bottom:1px solid #0f3460;"><span style="color:' + (isDir ? '#00b894' : '#aaa') + ';">' + (isDir ? '📁' : '📄') + '</span> <span style="color:#e0e0e0;">' + name + '</span>' + (e.size ? '<span style="color:#555;float:right;">' + e.size + 'B</span>' : '') + '</div>';
      }).join('');
      el.querySelectorAll('[data-dir]').forEach(function (d) { d.onclick = function () { document.getElementById('drs-path').value = d.getAttribute('data-dir'); browseRemote(); }; });
      el.querySelectorAll('[data-file]').forEach(function (f) { f.onclick = function () { readRemoteFile(f.getAttribute('data-file')); }; });
      log(entries.length + ' 个条目', 'ok');
    }).catch(function (e) { log('浏览失败: ' + e.message, 'err'); });
  }

  function readRemoteFile(fp) {
    log('读取: ' + fp, 'info');
    rpc('readRemoteFile', { path: fp }).then(function (content) {
      var el = document.getElementById('drs-file-content');
      el.style.display = 'block';
      el.textContent = content.length > 5000 ? content.slice(0, 5000) + '\n...(截断)' : content;
      log(content.length + ' 字节', 'ok');
    }).catch(function (e) { log('读取失败: ' + e.message, 'err'); });
  }

  function log(msg, level) {
    var el = document.getElementById('drs-log');
    if (!el) return;
    var t = new Date().toLocaleTimeString('zh-CN');
    var d = document.createElement('div');
    d.style.padding = '1px 0';
    d.style.color = level === 'ok' ? '#00b894' : level === 'err' ? '#e94560' : level === 'warn' ? '#f0a500' : '#aaa';
    d.innerHTML = '<span style="color:#555;">[' + t + ']</span> ' + msg;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }

  function openConfigFile() {
    var input = document.createElement('input');
    input.type = 'file';
    input.onchange = function (e) {
      var file = e.target.files[0];
      if (file) {
        rpc('setSshConfigPath', { path: file.name }).then(function () { refreshHosts(); }).catch(function (e) { log('配置失败: ' + e.message, 'err'); });
        log('已选择: ' + file.name, 'ok');
      }
    };
    input.click();
  }

  function createPanel() {
    if (document.getElementById('drs-panel')) return;
    var panel = document.createElement('div');
    panel.id = 'drs-panel';
    panel.style.cssText = 'position:fixed;top:0;right:0;width:420px;height:100vh;background:#1a1a2e;border-left:2px solid #0f3460;z-index:99998;box-shadow:-4px 0 20px rgba(0,0,0,.4);display:none;flex-direction:column;font-family:-apple-system,Segoe UI,sans-serif;color:#e0e0e0;overflow:hidden;';
    panel.innerHTML =
      '<div style="padding:10px 14px;background:#16213e;border-bottom:1px solid #0f3460;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">' +
        '<span style="font-size:14px;font-weight:600;">远程资源管理器</span>' +
        '<button id="drs-close" style="background:transparent;border:1px solid #0f3460;color:#aaa;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;">✕ 关闭</button>' +
      '</div>' +
      '<div style="flex:1;overflow-y:auto;padding:12px;">' +
        '<div style="margin-bottom:10px;"><label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">连接目标</label>' +
          '<select id="drs-target" style="width:100%;padding:6px 8px;background:#0d1b2a;border:1px solid #0f3460;border-radius:4px;color:#e0e0e0;font-size:13px;">' +
            '<option value="ssh">SSH</option>' +
            '<option value="container" disabled>开发容器 (敬请期待)</option>' +
            '<option value="wsl" disabled>WSL (敬请期待)</option>' +
          '</select>' +
        '</div>' +
        '<div style="margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">' +
          '<span style="font-size:12px;color:#888;">SSH 主机</span>' +
          '<div style="display:flex;gap:6px;">' +
            '<button id="drs-refresh" style="background:#0f3460;color:#e0e0e0;border:1px solid #1a4a7a;border-radius:3px;padding:3px 8px;cursor:pointer;font-size:11px;">刷新</button>' +
            '<button id="drs-config" style="background:#0f3460;color:#e0e0e0;border:1px solid #1a4a7a;border-radius:3px;padding:3px 8px;cursor:pointer;font-size:11px;">⚙ 配置</button>' +
          '</div>' +
        '</div>' +
        '<div id="drs-host-list" style="margin-bottom:10px;"></div>' +
        '<div style="margin-bottom:10px;display:flex;gap:6px;align-items:center;">' +
          '<span id="drs-status" style="font-size:12px;color:#aaa;flex:1;">未连接</span>' +
          '<button id="drs-disconnect" style="background:#0f3460;color:#e0e0e0;border:1px solid #1a4a7a;border-radius:3px;padding:3px 8px;cursor:pointer;font-size:11px;">断开</button>' +
          '<button id="drs-reconnect" style="background:#0f3460;color:#e0e0e0;border:1px solid #1a4a7a;border-radius:3px;padding:3px 8px;cursor:pointer;font-size:11px;display:none;">重连</button>' +
        '</div>' +
        '<div id="drs-explorer" style="display:none;margin-bottom:10px;">' +
          '<span style="font-size:12px;color:#888;">远端文件浏览器</span>' +
          '<div style="display:flex;gap:4px;margin:4px 0;">' +
            '<input id="drs-path" style="flex:1;padding:5px 8px;background:#0d1b2a;border:1px solid #0f3460;border-radius:4px;color:#e0e0e0;font-size:12px;" placeholder="/path/to/dir">' +
            '<button id="drs-browse" style="background:#0f3460;color:#e0e0e0;border:1px solid #1a4a7a;border-radius:3px;padding:5px 10px;cursor:pointer;font-size:11px;">浏览</button>' +
          '</div>' +
          '<div id="drs-files" style="background:#0d1b2a;border:1px solid #0f3460;border-radius:4px;max-height:160px;overflow-y:auto;font-size:12px;"></div>' +
          '<div id="drs-file-content" style="display:none;background:#0d1b2a;border:1px solid #0f3460;border-radius:4px;padding:8px;margin-top:6px;max-height:200px;overflow-y:auto;font-family:Consolas,monospace;font-size:11px;white-space:pre-wrap;"></div>' +
        '</div>' +
        '<div style="margin-top:8px;"><span style="font-size:12px;color:#888;">连接历史</span>' +
          '<div id="drs-history-list" style="background:#0d1b2a;border:1px solid #0f3460;border-radius:4px;padding:6px;max-height:80px;overflow-y:auto;font-size:11px;"></div>' +
        '</div>' +
        '<div id="drs-log" style="background:#0d1b2a;border:1px solid #0f3460;border-radius:4px;padding:6px;height:100px;overflow-y:auto;font-family:Consolas,monospace;font-size:11px;margin-top:8px;"></div>' +
      '</div>';
    document.body.appendChild(panel);
    document.getElementById('drs-close').onclick = togglePanel;
    document.getElementById('drs-refresh').onclick = refreshHosts;
    document.getElementById('drs-config').onclick = openConfigFile;
    document.getElementById('drs-disconnect').onclick = disconnectHost;
    document.getElementById('drs-reconnect').onclick = reconnectHost;
    document.getElementById('drs-browse').onclick = browseRemote;
  }

  function togglePanel() {
    var p = document.getElementById('drs-panel');
    if (p.style.display === 'none' || !p.style.display) {
      p.style.display = 'flex';
      document.body.style.overflow = 'hidden';
      if (!ws || ws.readyState !== WebSocket.OPEN) connectWS();
      if (hosts.length === 0) refreshHosts();
    } else {
      p.style.display = 'none';
      document.body.style.overflow = '';
    }
  }

  function createFloatBtn() {
    if (document.getElementById('drs-float-btn')) return;
    var b = document.createElement('button');
    b.id = 'drs-float-btn';
    b.title = '远程资源管理器';
    b.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;width:44px;height:44px;border:1px solid #0f3460;border-radius:10px;background:#16213e;color:#e0e0e0;cursor:pointer;font-size:20px;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;transition:all .2s;';
    b.textContent = '🖥';
    b.onmouseenter = function () { b.style.background = '#0f3460'; b.style.transform = 'scale(1.1)'; };
    b.onmouseleave = function () { b.style.background = '#16213e'; b.style.transform = 'scale(1)'; };
    b.onclick = togglePanel;
    document.body.appendChild(b);
  }

  function init() {
    createPanel();
    createFloatBtn();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 800); });
  } else {
    setTimeout(init, 800);
  }
})();

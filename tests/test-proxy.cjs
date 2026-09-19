// 测试远端代理是否可用
const { Client } = require('D:\\Project\\dsh_remote_ssh\\node_modules\\ssh2');
const { readFileSync } = require('fs');
const os = require('os');
const path = require('path');

const client = new Client();
client.on('ready', () => {
  // 测试代理是否可用
  const cmd = 'export http_proxy=http://127.0.0.1:18890 https_proxy=http://127.0.0.1:18890 && curl -fsSL --connect-timeout 5 -o /dev/null -w "%{http_code}" https://nodejs.org/dist/v22.20.0/ 2>&1 || echo "PROXY_FAILED"';
  console.log('测试代理:', cmd);
  client.exec(cmd, (err, stream) => {
    if (err) { console.error('exec err:', err); client.end(); return; }
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => out += '[stderr] ' + d);
    stream.on('close', () => { console.log('结果:', out.trim()); client.end(); });
  });
});
client.on('error', e => console.error('conn:', e));
client.connect({
  host: '192.168.1.82', port: 22, username: 'xlli67',
  privateKey: readFileSync(path.join(os.homedir(), '.ssh', 'xlli67')),
  readyTimeout: 15000,
});

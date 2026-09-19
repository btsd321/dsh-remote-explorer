// 手动测试 helper 启动
const { Client } = require('ssh2');
const { readFileSync } = require('fs');
const os = require('os');
const path = require('path');

const c = new Client();
c.on('ready', () => {
  const cmd = "NODE_PATH='/home/xlli67/.dsh/helper/node_modules' '/home/xlli67/.dsh/node/node' --disable-sigusr1 '/home/xlli67/.dsh/helper/helper.mjs'";
  console.log('exec:', cmd);
  c.exec(cmd, (err, stream) => {
    if (err) { console.error('exec err:', err); c.end(); return; }
    stream.on('data', d => console.log('stdout:', d.toString('hex').slice(0, 200)));
    stream.stderr.on('data', d => console.log('stderr:', d.toString()));
    stream.on('exit', code => console.log('exit:', code));
    stream.on('close', () => { console.log('closed'); c.end(); });
    setTimeout(() => {
      const hello = JSON.stringify({ type: 'request', id: 't1', method: 'hello', params: { protocol: 1, workspace: '/home/xlli67/projects', leaseMs: 30000 } });
      const body = Buffer.from(hello);
      const hdr = Buffer.alloc(4);
      hdr.writeUInt32BE(body.length);
      stream.write(Buffer.concat([hdr, body]));
      console.log('sent hello');
    }, 1000);
  });
});
c.on('error', e => console.error('conn:', e.message));
c.connect({ host: '192.168.1.82', port: 22, username: 'xlli67', privateKey: readFileSync(path.join(os.homedir(), '.ssh', 'xlli67')), readyTimeout: 15000 });

// 手动测试远端 helper 启动
const { Client } = require('D:\\Project\\dsh_remote_ssh\\node_modules\\ssh2');
const { readFileSync } = require('fs');
const os = require('os');
const path = require('path');

const client = new Client();
client.on('ready', () => {
  const cmd = "NODE_PATH='/home/xlli67/.dsh/helper/node_modules' '/home/xlli67/.dsh/node/node' --disable-sigusr1 '/home/xlli67/.dsh/helper/helper.mjs'";
  console.log('exec:', cmd);
  client.exec(cmd, (err, stream) => {
    if (err) { console.error('exec err:', err); client.end(); return; }
    stream.on('data', (d) => {
      console.log('stdout hex:', d.toString('hex').slice(0, 200));
    });
    stream.stderr.on('data', (d) => console.log('stderr:', d.toString()));
    stream.on('exit', (code) => console.log('exit:', code));
    stream.on('close', () => { console.log('channel closed'); client.end(); });

    setTimeout(() => {
      const hello = JSON.stringify({
        type: 'request', id: 'test-1', method: 'hello',
        params: { protocol: 1, workspace: '/home/xlli67/projects', leaseMs: 30000 }
      });
      const body = Buffer.from(hello);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      const frame = Buffer.concat([header, body]);
      console.log('sending hello frame:', frame.length, 'bytes');
      stream.write(frame);
    }, 500);
  });
});
client.on('error', (err) => console.error('conn err:', err));
client.connect({
  host: '192.168.1.82', port: 22, username: 'xlli67',
  privateKey: readFileSync(path.join(os.homedir(), '.ssh', 'xlli67')),
  readyTimeout: 15000,
});

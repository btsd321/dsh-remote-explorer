import { Ssh2Connection } from '../src/ssh2-connection.ts';
import { resolveHost } from '../src/ssh-config-parser.ts';

const alias = 'OrangePI';
const resolved = resolveHost(alias);
if (!resolved) { console.error('Host not found'); process.exit(1); }

const target = resolved.target;
console.log('Host:', target.host, target.port, target.username, target.identityFile);

const conn = new Ssh2Connection({
  host: target.host,
  port: target.port,
  username: target.username,
  ...(target.identityFile ? { privateKeyPath: target.identityFile } : {}),
  node: '/home/' + target.username + '/.dsh/node/node',
  helper: '/home/' + target.username + '/.dsh/helper/helper.mjs',
  helperHash: '',
  workspace: '/home/' + target.username,
});

conn.ready.then(h => {
  console.log('OK: protocol=' + h.protocol + ' hash=' + h.hash.slice(0, 16));
  return conn.dispose();
}).then(() => { console.log('disposed'); process.exit(0); }).catch(e => {
  console.error('FAIL:', e.message);
  process.exit(1);
});

setTimeout(() => { console.log('timeout'); process.exit(1); }, 15000);

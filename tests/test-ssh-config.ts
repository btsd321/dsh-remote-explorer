// 测试 ssh-config-parser
import { listHosts, resolveHost } from '../src/ssh-config-parser.ts';
import SSHConfig from 'ssh-config';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 直接测试 compute()
const text = readFileSync(join(homedir(), '.ssh', 'config'), 'utf8');
const config = SSHConfig.parse(text);
const computed = (config as any).compute('OrangePI', { ignoreCase: true });
console.log('=== compute OrangePI ===');
console.log(JSON.stringify(computed, null, 2));
console.log('HostName:', computed.HostName);
console.log('hostname:', computed.hostname);
console.log('User:', computed.User);
console.log('user:', computed.user);

console.log('=== listHosts ===');
const hosts = listHosts();
for (const h of hosts) {
  console.log('  ' + h.alias + ' -> ' + h.hostName + ':' + h.port + ' user=' + h.user + (h.hasProxyJump ? ' [跳板机: ' + h.proxyJump + ']' : ''));
}

console.log('\n=== resolveHost OrangePI ===');
const r1 = resolveHost('OrangePI');
if (r1) {
  console.log('target:', r1.target.host, r1.target.port, r1.target.username, r1.target.identityFile);
  console.log('jumpHosts:', r1.jumpHosts.length);
}

console.log('\n=== resolveHost LabRobot (含 ProxyJump) ===');
const r2 = resolveHost('LabRobot');
if (r2) {
  console.log('target:', r2.target.host, r2.target.port, r2.target.username);
  console.log('jumpHosts:', r2.jumpHosts.length);
  for (const jh of r2.jumpHosts) {
    console.log('  jump:', jh.host, jh.port, jh.username, jh.identityFile);
  }
}

console.log('\n=== resolveHost BJ-SF-Robot (含 ProxyJump) ===');
const r3 = resolveHost('BJ-SF-Robot');
if (r3) {
  console.log('target:', r3.target.host, r3.target.port, r3.target.username);
  console.log('jumpHosts:', r3.jumpHosts.length);
  for (const jh of r3.jumpHosts) {
    console.log('  jump:', jh.host, jh.port, jh.username, jh.identityFile);
  }
}

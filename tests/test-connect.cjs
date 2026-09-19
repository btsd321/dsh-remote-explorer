/**
 * @file 连接测试脚本
 * @description 测试 ssh2 库能否从 Windows 连接到 OrangePI 测试主机，
 *              验证跨平台 SSH 连接的基础功能。
 */

const { Client } = require('ssh2');
const { readFileSync } = require('fs');

// OrangePI 测试主机配置
const config = {
  host: '192.168.1.82',
  port: 22,
  username: 'xlli67',
  privateKey: readFileSync(require('os').homedir() + '/.ssh/xlli67'),
  readyTimeout: 15000,
};

console.log('正在连接 OrangePI...', config.host);

const client = new Client();
client.on('ready', () => {
  console.log('✓ SSH 连接成功');
  // 执行测试命令
  client.exec('uname -a && node --version 2>/dev/null || echo "node not installed"', (err, stream) => {
    if (err) {
      console.error('exec 失败:', err.message);
      client.end();
      return;
    }
    let output = '';
    stream.on('data', (data) => { output += data.toString(); });
    stream.stderr.on('data', (data) => { output += '[stderr] ' + data.toString(); });
    stream.on('close', () => {
      console.log('远端信息:');
      console.log(output);
      // 测试 SFTP
      client.sftp((err, sftp) => {
        if (err) {
          console.error('SFTP 失败:', err.message);
          client.end();
          return;
        }
        console.log('✓ SFTP 通道可用');
        // 列出 home 目录
        sftp.readdir('.', (err, list) => {
          if (err) console.error('readdir 失败:', err.message);
          else console.log('✓ home 目录列出成功:', list.length, '个条目');
          client.end();
        });
      });
    });
  });
});

client.on('error', (err) => {
  console.error('✗ SSH 连接失败:', err.message);
  process.exit(1);
});

client.connect(config);

/**
 * @file transport/wsl-network.ts 单元测试
 * @description 覆盖网络模式/默认路由网关的解析、探测命令的构造与参数校验、
 *              回环连通性与反向链路 HTTP 自检输出的解析。全部为纯函数测试。
 *              IPv4 判据已收口到 util/ipv4（isValidIpv4），其行为覆盖保留
 *              在本文件（与 wsl-network 的消费语义一起验证）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidIpv4 } from '../../src/util/ipv4.js';
import {
  buildDefaultRouteCommand,
  buildLoopbackProbeCommand,
  buildNetworkingModeProbeCommand,
  buildReverseHttpProbeCommand,
  parseDefaultRouteGateway,
  parseLoopbackProbeResult,
  parseNetworkingMode,
  parseReverseHttpProbeResult,
} from '../../src/transport/wsl-network.js';

// ─── isValidIpv4 ─────────────────────────────────────────────────────────

describe('isValidIpv4', () => {
  describe('合法输入', () => {
    it('回环地址合法', () => {
      assert.equal(isValidIpv4('127.0.0.1'), true);
    });

    it('NAT 网关段地址合法', () => {
      assert.equal(isValidIpv4('172.30.96.1'), true);
    });

    it('全零与全广播地址合法', () => {
      assert.equal(isValidIpv4('0.0.0.0'), true);
      assert.equal(isValidIpv4('255.255.255.255'), true);
    });

    it('每段边界值 255 与 0 合法', () => {
      assert.equal(isValidIpv4('255.0.255.0'), true);
      assert.equal(isValidIpv4('1.2.3.4'), true);
    });
  });

  describe('非法输入', () => {
    it('段超 255 拒绝', () => {
      assert.equal(isValidIpv4('256.1.1.1'), false);
      assert.equal(isValidIpv4('1.256.1.1'), false);
      assert.equal(isValidIpv4('999.999.999.999'), false);
    });

    it('段数不足或过多拒绝', () => {
      assert.equal(isValidIpv4('1.2.3'), false);
      assert.equal(isValidIpv4('1.2.3.4.5'), false);
    });

    it('非数字内容拒绝（含注入面）', () => {
      assert.equal(isValidIpv4(''), false);
      assert.equal(isValidIpv4('abc'), false);
      assert.equal(isValidIpv4('1.2.3.x'), false);
      assert.equal(isValidIpv4('172.30.96.1; rm -rf /'), false);
      assert.equal(isValidIpv4("1'2'3'4'"), false);
    });

    it('前导零拒绝（收窄判据）', () => {
      assert.equal(isValidIpv4('01.2.3.4'), false);
    });
  });
});

// ─── parseNetworkingMode ─────────────────────────────────────────────────

describe('parseNetworkingMode', () => {
  it('标准输出 nat（含换行）解析为 nat', () => {
    assert.equal(parseNetworkingMode('nat\n'), 'nat');
  });

  it('标准输出 mirrored 解析为 mirrored', () => {
    assert.equal(parseNetworkingMode('mirrored\n'), 'mirrored');
  });

  it('CRLF 换行容忍', () => {
    assert.equal(parseNetworkingMode('nat\r\n'), 'nat');
  });

  it('wslinfo 不存在时的空输出返回 undefined', () => {
    assert.equal(parseNetworkingMode(''), undefined);
  });

  it('非精确匹配返回 undefined（未来新值宁可判未知）', () => {
    assert.equal(parseNetworkingMode('NAT'), undefined);
    assert.equal(parseNetworkingMode('nat mirrored'), undefined);
    assert.equal(parseNetworkingMode('something-new'), undefined);
  });
});

// ─── parseDefaultRouteGateway ────────────────────────────────────────────

describe('parseDefaultRouteGateway', () => {
  it('标准单行输出解析出网关', () => {
    const output = 'default via 172.30.96.1 dev eth0 proto kernel metric 100\n';
    assert.equal(parseDefaultRouteGateway(output), '172.30.96.1');
  });

  it('多条默认路由取第一条', () => {
    const output = [
      'default via 172.30.96.1 dev eth0 proto kernel metric 100',
      'default via 192.168.1.1 dev wlan0 proto dhcp metric 600',
    ].join('\n');
    assert.equal(parseDefaultRouteGateway(output), '172.30.96.1');
  });

  it('无 via 段返回 undefined（点对点链路交由调用方降级）', () => {
    assert.equal(parseDefaultRouteGateway('default dev eth0 proto kernel\n'), undefined);
  });

  it('via 值非 IPv4 返回 undefined（外部输出不可默认可信）', () => {
    assert.equal(parseDefaultRouteGateway('default via 999.1.1.1 dev eth0\n'), undefined);
    assert.equal(parseDefaultRouteGateway('default via not-an-ip dev eth0\n'), undefined);
  });

  it('空输出返回 undefined', () => {
    assert.equal(parseDefaultRouteGateway(''), undefined);
  });
});

// ─── 命令构造 ─────────────────────────────────────────────────────────────

describe('buildNetworkingModeProbeCommand', () => {
  it('静态命令无动态值', () => {
    assert.equal(buildNetworkingModeProbeCommand(), 'wslinfo --networking-mode');
  });
});

describe('buildDefaultRouteCommand', () => {
  it('静态命令并兜住 ip 缺失与报错', () => {
    assert.equal(buildDefaultRouteCommand(), 'ip route show default 2>/dev/null || true');
  });
});

describe('buildLoopbackProbeCommand', () => {
  it('生成对 127.0.0.1 的 /dev/tcp 探测命令', () => {
    const command = buildLoopbackProbeCommand(47123);
    assert.ok(command.includes('/dev/tcp/127.0.0.1/47123'));
    assert.ok(command.includes('LOOPBACK_REACHABLE'));
    assert.ok(command.includes('LOOPBACK_UNREACHABLE'));
  });

  it('非法端口抛错', () => {
    assert.throws(() => buildLoopbackProbeCommand(0), /端口/);
    assert.throws(() => buildLoopbackProbeCommand(70_000), /端口/);
    assert.throws(() => buildLoopbackProbeCommand(1.5), /端口/);
  });
});

describe('buildReverseHttpProbeCommand', () => {
  it('生成对端点的 HTTP 探测命令（含 /dev/tcp 与请求行）', () => {
    const command = buildReverseHttpProbeCommand('172.30.96.1', 47123);
    assert.ok(command.includes('/dev/tcp/172.30.96.1/47123'));
    assert.ok(command.includes('GET / HTTP/1.0'));
    assert.ok(command.includes('Host: 172.30.96.1'));
    assert.ok(command.includes('PROBE_HTTP='));
  });

  it('非 IPv4 主机抛错（注入防线）', () => {
    assert.throws(() => buildReverseHttpProbeCommand('abc', 47123), /IPv4/);
    assert.throws(() => buildReverseHttpProbeCommand('172.30.96.1; rm -rf /', 47123), /IPv4/);
    assert.throws(() => buildReverseHttpProbeCommand('', 47123), /IPv4/);
  });

  it('非法端口抛错', () => {
    assert.throws(() => buildReverseHttpProbeCommand('127.0.0.1', 0), /端口/);
    assert.throws(() => buildReverseHttpProbeCommand('127.0.0.1', 65_536), /端口/);
  });
});

// ─── 探测输出解析 ─────────────────────────────────────────────────────────

describe('parseLoopbackProbeResult', () => {
  it('REACHABLE 判定可达', () => {
    assert.equal(parseLoopbackProbeResult('LOOPBACK_REACHABLE\n'), 'reachable');
  });

  it('UNREACHABLE 判定不可达', () => {
    assert.equal(parseLoopbackProbeResult('LOOPBACK_UNREACHABLE\n'), 'unreachable');
  });

  it('空或未知输出按不可达处理（保守判定）', () => {
    assert.equal(parseLoopbackProbeResult(''), 'unreachable');
    assert.equal(parseLoopbackProbeResult('garbage'), 'unreachable');
  });
});

describe('parseReverseHttpProbeResult', () => {
  it('拿到 HTTP 状态行即判可达（401 也算通）', () => {
    const result = parseReverseHttpProbeResult('PROBE_HTTP=HTTP/1.1 401 Unauthorized\n');
    assert.equal(result.reachable, true);
    assert.equal(result.outcome, 'http');
    assert.equal(result.statusLine, 'HTTP/1.1 401 Unauthorized');
  });

  it('404 状态行同样判可达', () => {
    const result = parseReverseHttpProbeResult('PROBE_HTTP=HTTP/1.0 404 Not Found\n');
    assert.equal(result.reachable, true);
    assert.equal(result.statusLine, 'HTTP/1.0 404 Not Found');
  });

  it('连接建立但无响应判不可达（connected-no-response）', () => {
    const result = parseReverseHttpProbeResult('PROBE_CONNECTED_NO_RESPONSE\n');
    assert.equal(result.reachable, false);
    assert.equal(result.outcome, 'connected-no-response');
    assert.equal(result.statusLine, undefined);
  });

  it('连接被拒判不可达（refused）', () => {
    const result = parseReverseHttpProbeResult('PROBE_REFUSED\n');
    assert.equal(result.reachable, false);
    assert.equal(result.outcome, 'refused');
  });

  it('空或未知输出按 refused 处理（保守判定）', () => {
    assert.equal(parseReverseHttpProbeResult('').outcome, 'refused');
    assert.equal(parseReverseHttpProbeResult('totally-unexpected').outcome, 'refused');
  });
});

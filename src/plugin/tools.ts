/**
 * @file agent 工具注册
 * @description 给模型用的五个 remote_* 工具：列主机、列 WSL 发行版、发起连接、查状态、断开会话。
 *              全部是**非阻塞语义**：connect 立即返回（引导与启动在后台跑，
 *              进度用 remote_status 轮询），避免模型的一次工具调用挂住几分钟。
 *
 * 命名纪律（scripts/check-plugin.ts 强制）：统一 remote_ 前缀（用户拍板），
 * 与第三方 dsh-remote 插件的 rw_* 不冲突。
 *
 * schema 硬约束（dsh-tools 源码核实）：每个显式 `type:'object'` 节点必须写
 * `additionalProperties`——缺失是 authorError，宿主启动即崩。parameters 的
 * 根是隐式开放对象（逐属性 map），required 用属性级 `required: true` 标注。
 *
 * 凭据纪律：**工具永不接受密码参数**——模型不经手秘密。无 IdentityFile 的
 * 主机需要密码时，引导用户走 Web 面板表单或 CLI 交互模式（错误消息里写明）。
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { listHosts, refreshConfig } from '../hosts/ssh-config-parser.js';
import { listWslDistros, refreshWslCache } from '../hosts/wsl-distro-parser.js';
import { toErrorMessage } from '../util/errors.js';
import { SessionSupervisor, SupervisorError, type SessionSnapshot } from './supervisor.js';

/** 统一错误出参：code 供模型分支，message 是中文定位信息 */
const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: {
      type: 'string',
      required: true,
      description: '错误类别：bad_usage / invalid_cwd / already_active / not_found / still_connecting / external_session / internal',
    },
    message: { type: 'string', required: true, description: '中文错误消息（含定位信息与下一步建议）' },
  },
} as const;

/** remote_kill 的超时：停远端进程经 SSH 往返，慢链路上要留足余量 */
const KILL_TIMEOUT_MS = 120_000;

/**
 * 注册全部 agent 工具。
 *
 * @param ctx - 插件上下文（tools 是硬依赖，inject 已声明，直接属性访问）
 * @param supervisor - 会话监督器
 * @returns 清理函数
 */
export function registerTools(ctx: Context, supervisor: SessionSupervisor): () => void {
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'remote_hosts_list',
      description: '列出可用的远程主机（SSH 别名来自 ~/.ssh/config，含地址、用户、端口、是否经跳板机）。连接远程主机前先用它确认别名。',
      parameters: {},
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                hosts: {
                  type: 'array',
                  description: '主机列表',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      alias: { type: 'string', description: 'SSH config 别名' },
                      host_name: { type: 'string', description: '主机地址' },
                      user: { type: 'string', description: '用户名（空串 = 未配置）' },
                      port: { type: 'integer', description: '端口' },
                      has_proxy_jump: { type: 'boolean', description: '是否经跳板机' },
                    },
                  },
                },
              },
            },
            ERROR_SCHEMA,
          ],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute() {
        try {
          // 长驻进程里 config 可能被改过——每次刷新缓存（读文件很便宜）
          refreshConfig();
          return {
            hosts: listHosts().map(host => ({
              alias: host.alias,
              host_name: host.hostName,
              user: host.user,
              port: host.port,
              has_proxy_jump: host.hasProxyJump,
            })),
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'remote_wsl_list',
      description: '列出本机已安装的 WSL 发行版（名称、状态、版本、是否默认）。WSL 不可用时返回空列表。',
      parameters: {},
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                distros: {
                  type: 'array',
                  description: 'WSL 发行版列表',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string', description: '发行版名称（如 Ubuntu-22.04）' },
                      state: { type: 'string', description: '运行状态：Running / Stopped / Installing / Converting' },
                      version: { type: 'integer', description: 'WSL 版本（1 或 2）' },
                      is_default: { type: 'boolean', description: '是否为默认发行版' },
                    },
                  },
                },
              },
            },
            ERROR_SCHEMA,
          ],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute() {
        try {
          refreshWslCache();
          const distros = await listWslDistros();
          return {
            distros: distros.map(d => ({
              name: d.name,
              state: d.state,
              version: d.version,
              is_default: d.isDefault,
            })),
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'remote_connect',
      description: '后台连接一台远程主机并启动远端 dsh 会话（装 Node 与 dsh、建隧道、起凭据代理）。立即返回会话 id，'
        + '引导进度用 remote_status 轮询；就绪后会给出浏览器可打开的会话 URL。'
        + '注意：不接受密码参数——需要密码认证的主机请让用户走 Web 面板或 CLI。',
      parameters: {
        host_alias: { type: 'string', required: true, description: 'SSH 别名（来自 ~/.ssh/config，remote_hosts_list 可查）或 user@host[:port] 直连语法' },
        cwd: { type: 'string', description: '远端工作目录（POSIX 绝对路径，如 /home/user/project）；缺省用插件配置或远端家目录' },
        local_port: { type: 'integer', description: '本机转发端口；缺省自动分配' },
        force_restart: { type: 'boolean', description: '探测到既有远端会话时强制重启它' },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                session_id: { type: 'string', description: '会话 id（远端身份）' },
                state: { type: 'string', description: '发起后的即时状态（通常是 connecting）' },
                hint: { type: 'string', description: '下一步提示' },
              },
            },
            ERROR_SCHEMA,
          ],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const snapshot = supervisor.startConnect({
            hostAlias: args.host_alias,
            ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
            ...(args.local_port !== undefined ? { localPort: args.local_port } : {}),
            ...(args.force_restart !== undefined ? { forceRestart: args.force_restart } : {}),
          });
          return {
            session_id: snapshot.sessionId,
            state: snapshot.connecting ? 'connecting' : snapshot.state.tag,
            hint: '引导在后台进行（首次要下载 Node 与 dsh，可能数分钟）；用 remote_status 轮询，state 变 connected 后取 url',
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'remote_status',
      description: '查询当前进程维持的远程会话状态（含连接中/已连接/重连/失败），以及其他本机进程维持的只读视图。remote_connect 之后用它轮询进度。',
      parameters: {
        session_id: { type: 'string', description: '只看某个会话（id 前缀或主机别名）；缺省列全部' },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessions: {
                  type: 'array',
                  description: '会话列表',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      session_id: { type: 'string' },
                      host_alias: { type: 'string' },
                      remote_cwd: { type: 'string', description: '远端目录（空串 = 家目录）' },
                      state: { type: 'string', description: '状态标签：connecting/connected/reconnecting/reconnect-exhausted/disconnected 等' },
                      connect_error: { type: 'string', description: '连接失败原因（仅失败时）' },
                      local_port: { type: 'integer', description: '本机转发端口（就绪后）' },
                      url: { type: 'string', description: '浏览器访问地址（含远端令牌；就绪后）' },
                      external: { type: 'boolean', description: 'true = 其他本机进程维持的视图（只读）' },
                      recent_log: { type: 'array', items: { type: 'string' }, description: '最近几条进度日志' },
                    },
                  },
                },
              },
            },
            ERROR_SCHEMA,
          ],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          let snapshots = supervisor.list();
          if (args.session_id !== undefined) {
            const target = args.session_id;
            snapshots = snapshots.filter(snapshot =>
              snapshot.sessionId.startsWith(target) || snapshot.hostAlias === target);
          }
          return { sessions: snapshots.map(toToolSession) };
        } catch (error) {
          return errorResult(error);
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'remote_kill',
      description: '断开一个远程会话；默认连远端 dsh 进程一起停止（keep_remote=true 可保留远端供下次复用）。这是高影响操作：会终止远端正在服务的会话。',
      parameters: {
        target: { type: 'string', required: true, description: '会话 id（或前缀）或主机别名' },
        keep_remote: { type: 'boolean', description: '保留远端 dsh 进程（默认停止）' },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                disconnected: { type: 'string', description: '被断开的会话 id' },
                remote_stopped: { type: 'boolean', description: '远端 dsh 是否已停止' },
              },
            },
            ERROR_SCHEMA,
          ],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: KILL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const stopRemote = args.keep_remote !== true;
          const sessionId = await supervisor.disconnect(args.target, stopRemote);
          return { disconnected: sessionId, remote_stopped: stopRemote };
        } catch (error) {
          return errorResult(error);
        }
      },
    })),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/**
 * 把监督器快照压成工具出参（字段名转 snake_case，日志只留文本尾部）。
 *
 * @param snapshot - 会话快照
 * @returns 工具出参条目
 */
function toToolSession(snapshot: SessionSnapshot): Record<string, unknown> {
  return {
    session_id: snapshot.sessionId,
    host_alias: snapshot.hostAlias,
    remote_cwd: snapshot.remoteCwd,
    state: snapshot.connecting ? 'connecting' : snapshot.state.tag,
    ...(snapshot.connectError !== undefined ? { connect_error: snapshot.connectError } : {}),
    ...(snapshot.localPort !== undefined ? { local_port: snapshot.localPort } : {}),
    ...(snapshot.url !== undefined ? { url: snapshot.url } : {}),
    ...(snapshot.external === true ? { external: true } : {}),
    recent_log: (snapshot.logTail ?? []).slice(-5).map(entry => `[${entry.kind}] ${entry.text}`),
  };
}

/**
 * 把异常归一化为工具错误出参（工具约定：错误也是返回值，不抛异常）。
 *
 * @param error - 捕获的异常
 * @returns { code, message } 出参
 */
function errorResult(error: unknown): { code: string; message: string } {
  if (error instanceof SupervisorError) {
    // 无 IdentityFile 又没密码的主机：给用户指条明路（模型不经手密码）
    const hint = error.message.includes('IdentityFile')
      ? '（该主机需要密码认证：请用户在 Web 面板的密码框输入，或在终端用 dsh-remote-explorer connect 交互登录）'
      : '';
    return { code: error.code, message: `${error.message}${hint}` };
  }
  return { code: 'internal', message: toErrorMessage(error) };
}

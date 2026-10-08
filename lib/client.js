window.__ModuleLoader__.load({ id: "dsh-remote-explorer", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/plugin-client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var React14 = __toESM(require("react"), 1);

// src/plugin-client/locales.ts
var zh = {
  nav: "\u8FDC\u7A0B\u4F1A\u8BDD",
  sectionIntro: "\u7BA1\u7406 SSH \u4E0E WSL \u8FDC\u7A0B\u4F1A\u8BDD\uFF1A\u628A dsh \u88C5\u5230\u8FDC\u7A0B\u73AF\u5883\u4E0A\u8FD0\u884C\uFF0C\u672C\u673A\u53EA\u7559\u6D4F\u89C8\u5668\uFF1BLLM \u51ED\u636E\u4E0D\u79BB\u5F00\u672C\u673A\u3002",
  sshSectionIntro: "\u901A\u8FC7 SSH \u8FDE\u63A5\u8FDC\u7A0B\u4E3B\u673A\uFF0C\u628A dsh \u88C5\u5230\u8FDC\u7AEF\u8FD0\u884C\uFF1B\u4F1A\u8BDD\u7EF4\u6301\u5728\u672C dsh \u8FDB\u7A0B\u91CC\u2014\u2014\u9000\u51FA dsh \u4F1A\u6309\u914D\u7F6E\u65AD\u5F00\u6216\u4FDD\u7559\u8FDC\u7AEF\u3002",
  wslSectionIntro: "\u901A\u8FC7 WSL\uFF08Windows Subsystem for Linux\uFF09\u8FDE\u63A5\u672C\u5730 Linux \u53D1\u884C\u7248\uFF0C\u628A dsh \u88C5\u5230\u53D1\u884C\u7248\u5185\u8FD0\u884C\uFF1B\u65E0\u9700 SSH \u914D\u7F6E\u3002",
  menuSsh: "SSH \u4F1A\u8BDD",
  menuWsl: "WSL \u4F1A\u8BDD",
  host: "\u4E3B\u673A",
  hostPlaceholder: "ssh config \u522B\u540D\uFF0C\u6216 user@host[:port]",
  refreshHosts: "\u5237\u65B0\u4E3B\u673A\u5217\u8868",
  hostPickerNoMatch: "\u6CA1\u6709\u5339\u914D\u7684\u4E3B\u673A\uFF08\u4E5F\u53EF\u76F4\u586B user@host[:port]\uFF09",
  hostDisconnectExternal: "\u8BE5\u4E3B\u673A\u7684\u4F1A\u8BDD\u7531\u5176\u4ED6\u672C\u673A\u8FDB\u7A0B\u7EF4\u6301\uFF0C\u8BF7\u5728\u5BF9\u5E94\u8FDB\u7A0B\u6216 CLI \u4E2D\u65AD\u5F00",
  cwd: "\u8FDC\u7AEF\u76EE\u5F55",
  cwdPlaceholder: "/home/you/project\uFF08\u7559\u7A7A = \u8FDC\u7AEF\u5BB6\u76EE\u5F55\uFF09",
  advanced: "\u9AD8\u7EA7\u9009\u9879",
  localPort: "\u672C\u673A\u7AEF\u53E3\uFF080 = \u81EA\u52A8\u5206\u914D\uFF09",
  forceRestart: "\u5F3A\u5236\u91CD\u542F\u8FDC\u7AEF dsh",
  refreshMirrors: "\u91CD\u65B0\u6D4B\u901F\u955C\u50CF\u6E90",
  nodeVersion: "Node \u7248\u672C\uFF08\u7559\u7A7A = \u9ED8\u8BA4\uFF09",
  dshVersion: "dsh \u7248\u672C\uFF08\u7559\u7A7A = \u9ED8\u8BA4\uFF09",
  privateKey: "\u79C1\u94A5\u8DEF\u5F84\uFF08\u7559\u7A7A = \u7528 ssh config\uFF09",
  password: "SSH \u5BC6\u7801",
  passwordWarning: "\u5BC6\u7801\u4EC5\u5B58\u5BBF\u4E3B dsh \u8FDB\u7A0B\u5185\u5B58\uFF0C\u4E0D\u843D\u76D8\u3001\u4E0D\u8FDB\u65E5\u5FD7\uFF1B\u7559\u7A7A\u5219\u8981\u6C42\u4E3B\u673A\u5DF2\u914D\u7F6E IdentityFile",
  connect: "\u8FDE\u63A5",
  connecting: "\u8FDE\u63A5\u4E2D\u2026",
  connectCurrent: "\u5728\u5F53\u524D\u6807\u7B7E\u9875\u8FDE\u63A5",
  connectNew: "\u5728\u65B0\u6807\u7B7E\u9875\u8FDE\u63A5",
  enterCurrent: "\u8FDB\u5165\uFF08\u5F53\u524D\u6807\u7B7E\uFF09",
  openNew: "\u65B0\u6807\u7B7E\u6253\u5F00",
  countdown: "\u4F1A\u8BDD\u5DF2\u5C31\u7EEA\uFF0C\u5207\u5165\u8FDC\u7AEF\u7A97\u53E3\u5012\u8BA1\u65F6",
  cancelCountdown: "\u53D6\u6D88",
  connectWindow: "\u5728\u65B0\u7A97\u53E3\u8FDE\u63A5",
  openWindow: "\u65B0\u7A97\u53E3\u6253\u5F00",
  overlayLoading: "\u6B63\u5728\u6253\u5F00\u8FDC\u7A0B\u684C\u9762\u2026",
  overlayStopping: "\u6B63\u5728\u65AD\u5F00\u8FDC\u7A0B\u8FDE\u63A5\u2026",
  overlayStoppingRemote: "\u6B63\u5728\u505C\u6B62\u8FDC\u7AEF dsh\u2026",
  overlayLeaseFailed: "\u6253\u5F00\u8FDC\u7A0B\u684C\u9762\u5931\u8D25",
  overlayReturnHint: "\u6309 Esc \u8FD4\u56DE\u7BA1\u7406\u9875",
  intentDisconnect: "\u8FDC\u7AEF\u7A97\u53E3\u8BF7\u6C42\u5173\u95ED\u6B64\u8FDC\u7A0B\u8FDE\u63A5\uFF08\u672C\u673A\u96A7\u9053\u4E0E\u4F1A\u8BDD\u767B\u8BB0\u5C06\u89E3\u9664\uFF0C\u8FDC\u7AEF dsh \u4FDD\u7559\uFF09",
  intentStop: "\u8FDC\u7AEF\u7A97\u53E3\u8BF7\u6C42\u505C\u6B62\u8FDC\u7AEF dsh \u5E76\u5173\u95ED\u6B64\u8FDC\u7A0B\u8FDE\u63A5",
  intentExecute: "\u6267\u884C",
  intentCancel: "\u53D6\u6D88",
  sessions: "\u4F1A\u8BDD",
  noSessions: "\u5F53\u524D\u6CA1\u6709\u4F1A\u8BDD",
  disconnect: "\u65AD\u5F00",
  stopRemote: "\u540C\u65F6\u505C\u6B62\u8FDC\u7AEF dsh",
  open: "\u6253\u5F00",
  external: "\u5916\u90E8\uFF08\u5176\u4ED6\u672C\u673A\u8FDB\u7A0B\u7EF4\u6301\uFF0C\u53EA\u8BFB\uFF1B\u7BA1\u7406\u8BF7\u7528\u5BF9\u5E94\u8FDB\u7A0B\u6216 CLI\uFF09",
  stateIdle: "\u672A\u5F00\u59CB",
  stateConnecting: "\u8FDE\u63A5\u4E2D",
  stateConnected: "\u5DF2\u8FDE\u63A5",
  stateHeartbeatMissed: "\u5FC3\u8DF3\u4E22\u5931",
  stateReconnecting: "\u91CD\u8FDE\u4E2D",
  stateReconnectFailed: "\u91CD\u8FDE\u5931\u8D25",
  stateReconnectExhausted: "\u91CD\u8FDE\u6B21\u6570\u7528\u5C3D",
  stateDisconnected: "\u5DF2\u65AD\u5F00",
  log: "\u8FDB\u5EA6\u65E5\u5FD7",
  logEmpty: "\u70B9\u51FB\u4F1A\u8BDD\u884C\u67E5\u770B\u8FDB\u5EA6\u65E5\u5FD7",
  connectError: "\u8FDE\u63A5\u5931\u8D25",
  loadError: "\u52A0\u8F7D\u5931\u8D25",
  retry: "\u91CD\u8BD5",
  missingKeys: "\u672C\u673A\u7F3A\u5C11\u7684 LLM key \u73AF\u5883\u53D8\u91CF",
  advancedJump: "\u8DF3\u677F\u673A",
  advancedEnv: "\u73AF\u5883\u53D8\u91CF",
  advancedProxy: "\u4EE3\u7406",
  dlgSave: "\u4FDD\u5B58",
  dlgSaving: "\u4FDD\u5B58\u4E2D\u2026",
  dlgCancel: "\u53D6\u6D88",
  dlgClose: "\u5173\u95ED",
  dlgLoading: "\u52A0\u8F7D\u4E2D\u2026",
  dlgLoadError: "\u52A0\u8F7D\u5931\u8D25\uFF1A",
  dlgSaveError: "\u4FDD\u5B58\u5931\u8D25\uFF1A",
  envDialogTitle: "\u73AF\u5883\u53D8\u91CF",
  envDialogHint: "\u5168\u5C40\u4FDD\u5B58\uFF08\u8BB0\u4F4F\u4E0A\u4E00\u6B21\u8F93\u5165\uFF0C\u6362\u4E3B\u673A\u6CBF\u7528\u540C\u4E00\u4EFD\uFF09\uFF0C\u4EC5\u5B58\u5BBF\u4E3B\u4FA7 ~/.dsh/remote-advanced.json\uFF1B\u8FDE\u63A5\u65F6\u6CE8\u5165\u8FDC\u7AEF dsh \u8FDB\u7A0B",
  envDialogDomainHint: "\u914D\u7F6E\u6309\u8FDE\u63A5\u5F62\u6001\uFF08SSH / WSL\uFF09\u5206\u5F00\u4FDD\u5B58\uFF0C\u4E92\u4E0D\u5F71\u54CD\uFF1B\u6B64\u5904\u7F16\u8F91\u7684\u662F\u5F53\u524D\u8868\u5355\u5BF9\u5E94\u5F62\u6001\u7684\u914D\u7F6E",
  envDialogApplyHint: "\u4FDD\u5B58\u540E\u4E0B\u4E00\u6B21\u8FDE\u63A5\u65F6\u751F\u6548\uFF1B\u5DF2\u8FD0\u884C\u7684\u4F1A\u8BDD\u9700\u65AD\u5F00\uFF08\u52FE\u9009\u300C\u540C\u65F6\u505C\u6B62\u8FDC\u7AEF dsh\u300D\uFF09\u540E\u91CD\u8FDE\u624D\u4F1A\u6CE8\u5165",
  envKey: "\u53D8\u91CF\u540D",
  envValue: "\u503C",
  envAddRow: "\u6DFB\u52A0\u4E00\u884C",
  envRemoveRow: "\u5220\u9664\u6B64\u884C",
  envSkipHint: "\u672A\u586B\u53D8\u91CF\u540D\u7684\u7A7A\u884C\u4FDD\u5B58\u65F6\u81EA\u52A8\u5FFD\u7565",
  envInvalidKey: "\u53D8\u91CF\u540D\u975E\u6CD5\uFF08\u4EC5\u5B57\u6BCD/\u6570\u5B57/\u4E0B\u5212\u7EBF\uFF0C\u9996\u5B57\u7B26\u4E0D\u80FD\u662F\u6570\u5B57\uFF09\uFF1A",
  envReservedKey: "\u4FDD\u7559\u952E\u4E0D\u53EF\u914D\u7F6E\uFF08\u7531\u5DE5\u5177\u81EA\u8EAB\u7BA1\u7406\uFF09\uFF1A",
  envDuplicateKey: "\u53D8\u91CF\u540D\u91CD\u590D\uFF1A",
  envInvalidValue: "\u503C\u542B\u63A7\u5236\u5B57\u7B26\uFF1A",
  proxyDialogTitle: "\u4EE3\u7406",
  proxyDialogHint: "\u8FDC\u7A0B dsh \u8D70 HTTP(S) \u7684\u51FA\u7AD9\u4EE3\u7406\uFF08\u5982\u5B89\u88C5 GitHub \u63D2\u4EF6\uFF09\uFF1B\u5168\u5C40\u4FDD\u5B58\uFF0C\u6362\u4E3B\u673A\u6CBF\u7528\u540C\u4E00\u4EFD\u3002\u7559\u7A7A\u4FDD\u5B58 = \u6E05\u9664",
  proxyDialogApplyHint: "\u8FDE\u63A5\u65F6\u5C55\u5F00\u4E3A http_proxy/https_proxy/no_proxy \u7B49\u516B\u4E2A\u73AF\u5883\u53D8\u91CF\u6CE8\u5165\u8FDC\u7AEF\uFF1B\u5DF2\u8FD0\u884C\u7684\u4F1A\u8BDD\u9700\u65AD\u5F00\u91CD\u8FDE\u624D\u4F1A\u6CE8\u5165",
  proxyPlaceholder: "http://127.0.0.1:18890\uFF08SSH \u53CD\u5411\u96A7\u9053\u7684\u8FDC\u7AEF\u7AEF\u53E3\uFF09",
  jumpDialogTitle: "\u8DF3\u677F\u673A",
  jumpDirectHint: "\u76F4\u8FDE\u4E3B\u673A\uFF08user@host[:port]\uFF09\u53EF\u914D\u7F6E\u8DF3\u677F\u673A\u94FE\uFF1A\u6BCF\u6761\u4E00\u4E2A ssh config \u522B\u540D\u6216 user@host[:port]\uFF0C\u6309\u5217\u8868\u987A\u5E8F\u9010\u7EA7\u8FDE\u63A5\u3002\u5168\u5C40\u4FDD\u5B58\uFF08\u8BB0\u4F4F\u4E0A\u4E00\u6B21\u8F93\u5165\uFF0C\u4EC5\u5BF9\u76F4\u8FDE\u4E3B\u673A\u751F\u6548\uFF09",
  jumpConfigHint: "\u8BE5\u4E3B\u673A\u5728 ssh config \u4E2D\u5DF2\u6709\u5B9A\u4E49\uFF0C\u8DF3\u677F\u673A\u7531 config \u7684 ProxyJump \u81EA\u52A8\u8BC6\u522B\uFF0C\u6B64\u5904\u53EA\u8BFB\u3002\u5982\u9700\u4FEE\u6539\u8BF7\u7F16\u8F91 ~/.ssh/config \u6587\u4EF6",
  jumpNoChain: "\u65E0\uFF08\u76F4\u8FDE\uFF09",
  jumpUnknownHost: "\u5148\u5728\u4E0A\u65B9\u9009\u62E9\u6216\u8F93\u5165\u4E3B\u673A",
  jumpTarget: "\u8DF3\u677F\u673A\uFF08\u522B\u540D\u6216 user@host[:port]\uFF09",
  jumpIdentity: "\u79C1\u94A5\u8DEF\u5F84\uFF08\u7559\u7A7A = \u7528 config / \u4EA4\u4E92\u8F93\u5165\uFF09",
  jumpPassword: "\u5BC6\u7801",
  jumpPasswordHint: "\u5BC6\u7801\u4E0D\u843D\u76D8\uFF1A\u4EC5\u968F\u8FDE\u63A5\u8BF7\u6C42\u5185\u5B58\u4F20\u9012\uFF0C\u6BCF\u6B21\u8FDE\u63A5\u9700\u91CD\u65B0\u8F93\u5165\uFF1B\u4F18\u5148\u7EA7\u4F4E\u4E8E\u79C1\u94A5\u8DEF\u5F84",
  jumpAddRow: "\u6DFB\u52A0\u4E00\u7EA7",
  jumpRemoveRow: "\u5220\u9664\u6B64\u7EA7",
  jumpChainSourceConfig: "\uFF08config \u8BC6\u522B\uFF09",
  jumpChainSourcePanel: "\uFF08\u9762\u677F\u914D\u7F6E\uFF09",
  wslDistro: "\u53D1\u884C\u7248",
  wslDistroPlaceholder: "\u9009\u62E9 WSL \u53D1\u884C\u7248",
  wslUser: "\u7528\u6237\u540D",
  wslUserPlaceholder: "\u7559\u7A7A = \u9ED8\u8BA4\u7528\u6237",
  wslNoDistros: "\u672A\u68C0\u6D4B\u5230 WSL \u53D1\u884C\u7248",
  wslVersion: "\u7248\u672C",
  wslState: "\u72B6\u6001",
  wslStateRunning: "\u8FD0\u884C\u4E2D",
  wslStateStopped: "\u5DF2\u505C\u6B62",
  wslDefault: "\u9ED8\u8BA4",
  refreshDistros: "\u5237\u65B0\u53D1\u884C\u7248\u5217\u8868",
  wslNotInstalledTitle: "WSL \u672A\u5B89\u88C5\u6216\u65E0\u53EF\u7528\u53D1\u884C\u7248",
  wslNotInstalledHint: "\u8BF7\u5148\u5B89\u88C5 WSL \u5E76\u6DFB\u52A0 Linux \u53D1\u884C\u7248\u3002\u5728 PowerShell\uFF08\u7BA1\u7406\u5458\uFF09\u4E2D\u8FD0\u884C\uFF1Awsl --install -d Ubuntu\uFF0C\u7136\u540E\u91CD\u542F\u5E94\u7528\u518D\u8BD5\u3002"
};
var en = {
  nav: "Remote Sessions",
  sectionIntro: "Manage SSH and WSL remote sessions: installs dsh on a remote environment and serves its UI to this browser; LLM credentials never leave this machine.",
  sshSectionIntro: "Connect to a remote host via SSH and run dsh there; sessions live in this dsh process \u2014 quitting dsh disconnects or keeps the remote per config.",
  wslSectionIntro: "Connect to a local WSL (Windows Subsystem for Linux) distribution and run dsh inside it; no SSH configuration needed.",
  menuSsh: "SSH Sessions",
  menuWsl: "WSL Sessions",
  host: "Host",
  hostPlaceholder: "ssh config alias, or user@host[:port]",
  refreshHosts: "Refresh host list",
  hostPickerNoMatch: "No matching host (you can also type user@host[:port])",
  hostDisconnectExternal: "The sessions of this host are maintained by other local processes; disconnect from that process or the CLI",
  cwd: "Remote directory",
  cwdPlaceholder: "/home/you/project (empty = remote home)",
  advanced: "Advanced",
  localPort: "Local port (0 = auto)",
  forceRestart: "Force-restart remote dsh",
  refreshMirrors: "Re-run mirror speed test",
  nodeVersion: "Node version (empty = default)",
  dshVersion: "dsh version (empty = default)",
  privateKey: "Private key path (empty = ssh config)",
  password: "SSH password",
  passwordWarning: "The password stays in the host dsh process memory only \u2014 never written to disk or logged; leave empty to require an IdentityFile on the host",
  connect: "Connect",
  connecting: "Connecting\u2026",
  connectCurrent: "Connect in current tab",
  connectNew: "Connect in new tab",
  enterCurrent: "Enter (current tab)",
  openNew: "Open in new tab",
  countdown: "Session ready \u2014 entering remote window in",
  cancelCountdown: "Cancel",
  connectWindow: "Connect in new window",
  openWindow: "Open in new window",
  overlayLoading: "Opening remote desktop\u2026",
  overlayStopping: "Disconnecting remote session\u2026",
  overlayStoppingRemote: "Stopping remote dsh\u2026",
  overlayLeaseFailed: "Failed to open remote desktop",
  overlayReturnHint: "Press Esc to return to the manager",
  intentDisconnect: "The remote window asked to close this remote connection (local tunnel and session registration go away; remote dsh stays)",
  intentStop: "The remote window asked to stop the remote dsh and close this remote connection",
  intentExecute: "Execute",
  intentCancel: "Cancel",
  sessions: "Sessions",
  noSessions: "No sessions",
  disconnect: "Disconnect",
  stopRemote: "Also stop remote dsh",
  open: "Open",
  external: "External (kept by another local process, read-only; manage it there or via the CLI)",
  stateIdle: "Idle",
  stateConnecting: "Connecting",
  stateConnected: "Connected",
  stateHeartbeatMissed: "Heartbeat missed",
  stateReconnecting: "Reconnecting",
  stateReconnectFailed: "Reconnect failed",
  stateReconnectExhausted: "Reconnect exhausted",
  stateDisconnected: "Disconnected",
  log: "Progress log",
  logEmpty: "Select a session row to view its progress log",
  connectError: "Connect failed",
  loadError: "Load failed",
  retry: "Retry",
  missingKeys: "LLM key env vars missing on this machine",
  advancedJump: "Jump hosts",
  advancedEnv: "Environment variables",
  advancedProxy: "Proxy",
  dlgSave: "Save",
  dlgSaving: "Saving\u2026",
  dlgCancel: "Cancel",
  dlgClose: "Close",
  dlgLoading: "Loading\u2026",
  dlgLoadError: "Load failed: ",
  dlgSaveError: "Save failed: ",
  envDialogTitle: "Environment variables",
  envDialogHint: "Saved globally (remembers your last input, shared across hosts) in the host-side ~/.dsh/remote-advanced.json only; injected into the remote dsh process when connecting",
  envDialogDomainHint: "Settings are stored per transport form (SSH / WSL) and never affect each other; this dialog edits the configuration of the form it was opened from",
  envDialogApplyHint: 'Takes effect on the next connection; running sessions must be disconnected (with "Also stop remote dsh" checked) and reconnected to pick it up',
  envKey: "Variable name",
  envValue: "Value",
  envAddRow: "Add a row",
  envRemoveRow: "Remove this row",
  envSkipHint: "Rows without a variable name are skipped on save",
  envInvalidKey: "Invalid variable name (letters/digits/underscore only, must not start with a digit): ",
  envReservedKey: "Reserved key (managed by the tool itself): ",
  envDuplicateKey: "Duplicate variable name: ",
  envInvalidValue: "Value contains control characters: ",
  proxyDialogTitle: "Proxy",
  proxyDialogHint: "Outbound HTTP(S) proxy for the remote dsh (e.g. installing GitHub plugins); saved globally, shared across hosts. Save empty to clear",
  proxyDialogApplyHint: "Expanded into eight proxy env vars (http_proxy/https_proxy/no_proxy \u2026) at connect time; running sessions must be reconnected to pick it up",
  proxyPlaceholder: "http://127.0.0.1:18890 (remote end of the SSH reverse tunnel)",
  jumpDialogTitle: "Jump hosts",
  jumpDirectHint: "Direct hosts (user@host[:port]) can configure a jump chain: one ssh config alias or user@host[:port] per row, connected in list order. Saved globally (remembers your last input; applies to direct hosts only)",
  jumpConfigHint: "This host is defined in ssh config \u2014 its jump hosts come from the config ProxyJump and are read-only here. Edit ~/.ssh/config to change them",
  jumpNoChain: "None (direct)",
  jumpUnknownHost: "Select or type a host above first",
  jumpTarget: "Jump host (alias or user@host[:port])",
  jumpIdentity: "Private key path (empty = config / interactive)",
  jumpPassword: "Password",
  jumpPasswordHint: "Passwords are never written to disk: they travel in memory with the connect request and must be re-entered each time; lower priority than the private key",
  jumpAddRow: "Add a hop",
  jumpRemoveRow: "Remove this hop",
  jumpChainSourceConfig: " (from config)",
  jumpChainSourcePanel: " (panel-configured)",
  wslDistro: "Distribution",
  wslDistroPlaceholder: "Select a WSL distribution",
  wslUser: "Username",
  wslUserPlaceholder: "empty = default user",
  wslNoDistros: "No WSL distributions found",
  wslVersion: "Version",
  wslState: "State",
  wslStateRunning: "Running",
  wslStateStopped: "Stopped",
  wslDefault: "Default",
  refreshDistros: "Refresh distributions",
  wslNotInstalledTitle: "WSL not installed or no distributions available",
  wslNotInstalledHint: "Please install WSL and add a Linux distribution. Run in PowerShell (Admin): wsl --install -d Ubuntu, then restart the app."
};

// src/plugin-client/icon.tsx
var React = __toESM(require("react"), 1);
function RemoteSessionsIcon({ size }) {
  return /* @__PURE__ */ React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.2",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true"
    },
    /* @__PURE__ */ React.createElement("rect", { x: "2.5", y: "2.5", width: "11", height: "4.5", rx: "1" }),
    /* @__PURE__ */ React.createElement("circle", { cx: "5", cy: "4.75", r: "0.4", fill: "currentColor", stroke: "none" }),
    /* @__PURE__ */ React.createElement("path", { d: "M8 4.75h3.5" }),
    /* @__PURE__ */ React.createElement("rect", { x: "2.5", y: "9", width: "11", height: "4.5", rx: "1" }),
    /* @__PURE__ */ React.createElement("circle", { cx: "5", cy: "11.25", r: "0.4", fill: "currentColor", stroke: "none" }),
    /* @__PURE__ */ React.createElement("path", { d: "M8 11.25h3.5" })
  );
}

// src/plugin-client/intent-banner.tsx
var React2 = __toESM(require("react"), 1);

// src/plugin-client/api.ts
var BASE = "/api/dsh-remote-explorer";
var ApiError = class extends Error {
  /**
   * @param code - 宿主错误类别（bad_usage/invalid_cwd/already_active/not_found/…）
   * @param message - 中文消息
   * @param status - HTTP 状态码
   */
  constructor(code, message, status) {
    super(message);
    __publicField(this, "code", code);
    __publicField(this, "status", status);
    this.name = "ApiError";
  }
};
function messageOf(error) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
async function request(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  if (!response.ok) {
    let code = "http_error";
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body.code === "string") code = body.code;
      if (typeof body.message === "string") message = body.message;
    } catch {
    }
    throw new ApiError(code, message, response.status);
  }
  return await response.json();
}
async function fetchHosts(refresh = false) {
  const result = await request(`/hosts${refresh ? "?refresh=1" : ""}`);
  return result.hosts;
}
async function fetchSessions() {
  const result = await request("/sessions");
  return result.sessions;
}
async function fetchSessionLog(sessionId, since) {
  const params = new URLSearchParams({ id: sessionId, since: String(since) });
  return request(`/session?${params.toString()}`);
}
async function postConnect(body) {
  const result = await request("/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return result.session;
}
async function postDisconnect(target, stopRemote) {
  await request("/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, stopRemote })
  });
}
async function fetchAdvanced(transportType) {
  return request(`/advanced?transportType=${transportType}`);
}
async function postAdvanced(transportType, payload) {
  await request("/advanced", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transportType, ...payload })
  });
}
async function fetchWslDistros(refresh = false) {
  const result = await request(
    `/wsl-distros${refresh ? "?refresh=1" : ""}`
  );
  return result.distros;
}
async function fetchDshVersions() {
  return request("/dsh-versions");
}

// src/plugin-client/intent-banner.tsx
function parseIntent() {
  const match = /^#handoff-(disconnect|stop)=([^&]+)$/.exec(window.location.hash);
  if (match === null) return null;
  return { id: decodeURIComponent(match[2] ?? ""), stop: match[1] === "stop" };
}
function clearIntentHash() {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}
function IntentBanner(props) {
  const { t } = props;
  const [intent, setIntent] = React2.useState(() => parseIntent());
  const [error, setError] = React2.useState("");
  React2.useEffect(() => {
    const onHash = () => {
      setIntent(parseIntent());
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
    };
  }, []);
  if (intent === null) return null;
  const dismiss = () => {
    setIntent(null);
    clearIntentHash();
  };
  const run = async () => {
    const { id, stop } = intent;
    dismiss();
    try {
      await postDisconnect(id, stop);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const buttonStyle2 = {
    background: "transparent",
    color: "inherit",
    border: "1px solid rgba(127,127,127,0.5)",
    borderRadius: 6,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 12
  };
  return /* @__PURE__ */ React2.createElement(
    "div",
    {
      style: {
        position: "fixed",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1300,
        display: "flex",
        gap: 8,
        alignItems: "center",
        maxWidth: 560,
        padding: "8px 12px",
        fontSize: 13,
        background: "rgba(30,30,30,0.92)",
        color: "#e5e5e5",
        border: "1px solid rgba(245,158,11,0.6)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)"
      }
    },
    /* @__PURE__ */ React2.createElement("span", { style: { flex: 1 } }, intent.stop ? t("intentStop") : t("intentDisconnect"), error !== "" ? /* @__PURE__ */ React2.createElement("span", { style: { color: "#ef4444" } }, "\uFF08", error, "\uFF09") : null),
    /* @__PURE__ */ React2.createElement(
      "button",
      {
        type: "button",
        style: { ...buttonStyle2, fontWeight: 600 },
        onClick: () => {
          void run();
        }
      },
      t("intentExecute")
    ),
    /* @__PURE__ */ React2.createElement("button", { type: "button", style: buttonStyle2, onClick: dismiss }, t("intentCancel"))
  );
}

// src/plugin-client/remote-window.tsx
var React3 = __toESM(require("react"), 1);

// src/plugin-client/desktop-bridge.ts
function isDesktopShell() {
  return typeof window.dshDesktop === "object" && typeof window.dshDesktop.browser?.acquire === "function";
}
function desktopBrowser() {
  return window.dshDesktop?.browser;
}

// src/plugin-client/overlay-inset.ts
var CSS_VAR_CHROME_TOP = "--dsh-frame-chrome-top";
var CSS_VAR_TOP_CLEARANCE = "--dsh-frame-top-clearance";
var VAR_CHAIN = "var(--dsh-frame-chrome-top, var(--dsh-frame-top-clearance, 0px))";
var MACOS_FALLBACK = "52px";
var WINDOWS_FALLBACK = "40px";
var ZERO_FALLBACK = "0px";
function adaptOverlayRoot(root) {
  return {
    getComputedStyleValue(name2) {
      return window.getComputedStyle(root).getPropertyValue(name2);
    },
    hasDataAttribute(name2) {
      return root.hasAttribute(name2);
    },
    get platform() {
      return root.dataset.platform;
    }
  };
}
function overlayTopInset(root) {
  const chromeTop = root.getComputedStyleValue(CSS_VAR_CHROME_TOP).trim();
  const topClearance = root.getComputedStyleValue(CSS_VAR_TOP_CLEARANCE).trim();
  if (chromeTop !== "" || topClearance !== "") {
    return VAR_CHAIN;
  }
  if (root.hasDataAttribute("data-fullscreen")) {
    return ZERO_FALLBACK;
  }
  if (root.hasDataAttribute("data-windows-titlebar")) {
    return WINDOWS_FALLBACK;
  }
  if (root.platform === "darwin") {
    return MACOS_FALLBACK;
  }
  return ZERO_FALLBACK;
}

// src/util/logger.ts
function formatTimestamp() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function formatMessage(level, module2, message, data) {
  const ts = formatTimestamp();
  const base = `[${ts}] [${level}] [${module2}] ${message}`;
  if (data === void 0) return base;
  try {
    return `${base} ${JSON.stringify(data)}`;
  } catch {
    return `${base} [\u6570\u636E\u5E8F\u5217\u5316\u5931\u8D25]`;
  }
}
function createLogger(module2) {
  return {
    debug(message, data) {
      const text = formatMessage("DEBUG", module2, message, data);
      console.debug(text);
    },
    info(message, data) {
      const text = formatMessage("INFO", module2, message, data);
      console.info(text);
    },
    warn(message, data) {
      const text = formatMessage("WARN", module2, message, data);
      console.warn(text);
    },
    error(message, data) {
      const text = formatMessage("ERROR", module2, message, data);
      console.error(text);
    }
  };
}

// src/plugin-client/remote-window.tsx
var log = createLogger("remote-window");
var OVERLAY_INTENT_ORIGIN = "https://dsh-remote-handoff.overlay";
var currentTarget = null;
var listeners = /* @__PURE__ */ new Set();
function publish() {
  for (const listener of [...listeners]) listener();
}
function subscribe(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function getTarget() {
  return currentTarget;
}
function openRemoteWindow(next) {
  log.info("\u6253\u5F00\u8FDC\u7A0B\u7A97\u53E3", { sessionId: next.sessionId, hostAlias: next.hostAlias });
  currentTarget = next;
  publish();
}
function closeRemoteWindow() {
  if (currentTarget !== null) {
    currentTarget = null;
    publish();
  }
}
function messageOf2(error) {
  return error instanceof Error ? error.message : String(error);
}
function RemoteWindowOverlay(props) {
  const { t } = props;
  const target = React3.useSyncExternalStore(subscribe, getTarget);
  React3.useEffect(() => {
    if (target === null) return;
    log.info("\u8FDC\u7A0B\u7A97\u53E3\u6D6E\u5C42\u542F\u52A8", { sessionId: target.sessionId });
    const bridge = desktopBrowser();
    let disposed = false;
    let lease;
    let offOpenRequested;
    const topInset = overlayTopInset(adaptOverlayRoot(document.documentElement));
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:0;right:0;bottom:0;top:0;z-index:2147483647;background:var(--dsw-alias-bg-base,#101014);";
    const captionBar = document.createElement("div");
    captionBar.style.cssText = `position:absolute;left:0;right:0;top:0;height:${topInset};background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#101014));z-index:2;-webkit-app-region:drag;`;
    const status = document.createElement("div");
    status.style.cssText = `position:absolute;left:0;right:0;bottom:0;top:${topInset};z-index:1;display:flex;align-items:center;justify-content:center;color:#e5e5e5;font-size:13px;font-family:inherit;text-align:center;padding:24px;white-space:pre-wrap;background:var(--dsw-alias-bg-base,#101014);`;
    status.textContent = t("overlayLoading");
    container.appendChild(captionBar);
    container.appendChild(status);
    document.body.appendChild(container);
    const showStatus = (message) => {
      status.textContent = message;
      status.style.display = "flex";
    };
    const showWebview = () => {
      status.style.display = "none";
    };
    const runStop = (sessionId, stop) => {
      showStatus(stop ? t("overlayStoppingRemote") : t("overlayStopping"));
      void postDisconnect(sessionId, stop).then(() => {
        closeRemoteWindow();
      }).catch((error) => {
        if (!disposed) showStatus(`${messageOf2(error)}
${t("overlayReturnHint")}`);
      });
    };
    const handleIntentUrl = (url) => {
      if (!url.startsWith(OVERLAY_INTENT_ORIGIN)) return false;
      const match = /#handoff-(disconnect|stop)=([^&]+)/.exec(url);
      if (match !== null) {
        runStop(decodeURIComponent(match[2] ?? ""), match[1] === "stop");
        return true;
      }
      closeRemoteWindow();
      return true;
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeRemoteWindow();
    };
    window.addEventListener("keydown", onKeyDown);
    if (bridge === void 0) {
      log.warn("bridge \u4E0D\u53EF\u7528\uFF0C\u663E\u793A\u9519\u8BEF\u72B6\u6001");
      showStatus(`${t("overlayLeaseFailed")}
${t("overlayReturnHint")}`);
    } else {
      log.info("\u5F00\u59CB acquire lease...");
      void bridge.acquire(`dsh-remote-explorer:${target.sessionId}`).then((result) => {
        log.info("lease \u83B7\u53D6\u6210\u529F", { lease: result.lease, partition: result.partition });
        if (disposed) {
          void bridge.release(result.lease).catch(() => {
          });
          return;
        }
        lease = result.lease;
        offOpenRequested = bridge.onOpenRequested(result.lease, (url) => {
          handleIntentUrl(url);
        });
        const element = document.createElement("webview");
        element.setAttribute("src", `about:blank#${result.lease}`);
        element.setAttribute("partition", result.partition);
        element.style.cssText = `position:absolute;left:0;right:0;bottom:0;top:${topInset};border:none;`;
        element.addEventListener("dom-ready", () => {
          if (element.dataset.loaded === "1") return;
          element.dataset.loaded = "1";
          log.info("webview dom-ready\uFF0C\u5F00\u59CB loadURL", target.url);
          element.loadURL(target.url).then(() => {
            log.info("loadURL \u6210\u529F\uFF0C\u663E\u793A webview");
            if (!disposed) showWebview();
          }).catch((error) => {
            log.error("loadURL \u5931\u8D25", messageOf2(error));
            if (!disposed) showStatus(`${t("overlayLeaseFailed")}\uFF1A${messageOf2(error)}
${t("overlayReturnHint")}`);
          });
        });
        element.addEventListener("will-navigate", (event) => {
          const url = event.url ?? element.getURL();
          handleIntentUrl(url);
        });
        container.appendChild(element);
      }).catch((error) => {
        log.error("acquire \u5931\u8D25", messageOf2(error));
        if (!disposed) showStatus(`${t("overlayLeaseFailed")}\uFF1A${messageOf2(error)}
${t("overlayReturnHint")}`);
      });
    }
    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      offOpenRequested?.();
      if (lease !== void 0 && bridge !== void 0) {
        void bridge.release(lease).catch(() => {
        });
      }
      container.remove();
    };
  }, [target, t]);
  return null;
}

// src/plugin-client/ssh-panel.tsx
var React12 = __toESM(require("react"), 1);

// src/plugin-client/ssh-connect-form.tsx
var React10 = __toESM(require("react"), 1);

// src/plugin-client/host-picker.tsx
var React4 = __toESM(require("react"), 1);

// src/plugin-client/styles.ts
var inputStyle = {
  background: "transparent",
  color: "inherit",
  border: "1px solid rgba(127,127,127,0.4)",
  borderRadius: 6,
  padding: "4px 8px",
  minWidth: 0
};
var buttonStyle = {
  background: "transparent",
  color: "inherit",
  border: "1px solid rgba(127,127,127,0.5)",
  borderRadius: 6,
  padding: "4px 12px",
  cursor: "pointer"
};

// src/plugin-client/host-picker.tsx
var DROPDOWN_MAX_HEIGHT = 240;
function matchText(host) {
  const target = `${host.user === "" ? "" : `${host.user}@`}${host.hostName}:${host.port}`;
  return `${host.alias}
${target}`.toLowerCase();
}
function HostPicker(props) {
  const { value, onChange, hosts, connectedHosts, t } = props;
  const [open, setOpen] = React4.useState(false);
  const rootRef = React4.useRef(null);
  React4.useEffect(() => {
    if (!open) return void 0;
    const onDocMouseDown = (event) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
    };
  }, [open]);
  const filter = value.trim().toLowerCase();
  const visible = filter === "" ? hosts : hosts.filter((host) => matchText(host).includes(filter));
  return /* @__PURE__ */ React4.createElement("div", { ref: rootRef, style: { position: "relative", flex: 1 } }, /* @__PURE__ */ React4.createElement(
    "input",
    {
      value,
      placeholder: t("hostPlaceholder"),
      style: { ...inputStyle, width: "100%", boxSizing: "border-box" },
      onChange: (event) => onChange(event.target.value),
      onFocus: (event) => {
        event.target.select();
        setOpen(true);
      },
      onKeyDown: (event) => {
        if (event.key === "Escape") setOpen(false);
      }
    }
  ), open ? /* @__PURE__ */ React4.createElement("div", { role: "listbox", style: {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    zIndex: 1e3,
    marginTop: 2,
    maxHeight: DROPDOWN_MAX_HEIGHT,
    overflowY: "auto",
    background: "var(--dsw-alias-bg-base, #1e1e22)",
    color: "inherit",
    border: "1px solid rgba(127,127,127,0.4)",
    borderRadius: 6,
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
    fontSize: 13
  } }, visible.length === 0 ? /* @__PURE__ */ React4.createElement("div", { style: { padding: "6px 10px", opacity: 0.6 } }, t("hostPickerNoMatch")) : visible.map((host) => {
    const connected = connectedHosts.has(host.alias);
    const target = `${host.user === "" ? "" : `${host.user}@`}${host.hostName}:${host.port}`;
    return /* @__PURE__ */ React4.createElement(
      "div",
      {
        key: host.alias,
        role: "option",
        "aria-selected": host.alias === value,
        onClick: () => {
          onChange(host.alias);
          setOpen(false);
        },
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 10px",
          cursor: "pointer",
          background: host.alias === value ? "rgba(127,127,127,0.15)" : "transparent"
        }
      },
      /* @__PURE__ */ React4.createElement("span", { style: { fontWeight: 600 } }, host.alias),
      /* @__PURE__ */ React4.createElement("span", { style: { fontSize: 12, opacity: 0.6 } }, target),
      /* @__PURE__ */ React4.createElement("span", { style: { flex: 1 } }),
      connected ? /* @__PURE__ */ React4.createElement("span", { style: { fontSize: 11, color: "#34d399" } }, "\u25CF ", t("stateConnected")) : null
    );
  })) : null);
}

// src/plugin-client/use-dsh-versions.ts
var React5 = __toESM(require("react"), 1);
function useDshVersions() {
  const [versions, setVersions] = React5.useState([]);
  React5.useEffect(() => {
    void (async () => {
      try {
        const result = await fetchDshVersions();
        setVersions(result.versions);
      } catch {
      }
    })();
  }, []);
  return versions;
}

// src/plugin-client/dialogs/env-dialog.tsx
var React7 = __toESM(require("react"), 1);

// src/plugin-client/dialogs/dialog-shell.tsx
var React6 = __toESM(require("react"), 1);
var rowButtonStyle = {
  background: "transparent",
  color: "inherit",
  border: "1px solid rgba(127,127,127,0.5)",
  borderRadius: 6,
  padding: "2px 8px",
  cursor: "pointer",
  fontSize: 12
};
function DialogShell(props) {
  const { title, ariaLabel, onClose, children, footer, width } = props;
  React6.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);
  return /* @__PURE__ */ React6.createElement("div", { style: {
    position: "fixed",
    inset: 0,
    zIndex: 2147483647,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.45)",
    padding: 24,
    boxSizing: "border-box"
  } }, /* @__PURE__ */ React6.createElement(
    "div",
    {
      role: "dialog",
      "aria-modal": "true",
      "aria-label": ariaLabel ?? title,
      style: {
        width: width ?? "min(560px, 100%)",
        maxHeight: "80vh",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        background: "var(--dsw-alias-bg-base, #1e1e22)",
        color: "inherit",
        border: "1px solid rgba(127,127,127,0.4)",
        borderRadius: 8,
        padding: "14px 16px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
        fontSize: 13
      }
    },
    /* @__PURE__ */ React6.createElement("h3", { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, title),
    children,
    footer !== void 0 ? /* @__PURE__ */ React6.createElement("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } }, footer) : null
  ));
}
function dialogLoadState(phase, loadError, onRetry, t) {
  if (phase === "loading") return /* @__PURE__ */ React6.createElement("div", { style: { opacity: 0.6 } }, t("dlgLoading"));
  if (phase === "error") {
    return /* @__PURE__ */ React6.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" } }, /* @__PURE__ */ React6.createElement("div", { style: { color: "#ef4444", fontSize: 12 } }, t("dlgLoadError"), loadError), /* @__PURE__ */ React6.createElement("button", { type: "button", style: buttonStyle, onClick: onRetry }, t("retry")));
  }
  return null;
}

// src/plugin-client/dialogs/env-dialog.tsx
var KEY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
var RESERVED_KEYS = ["DSH_HOME", "DSH_AGENTS_HOME", "PATH"];
var CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
var MONO_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
function EnvDialog(props) {
  const { transportType, onClose, t } = props;
  const [rows, setRows] = React7.useState([]);
  const [loadPhase, setLoadPhase] = React7.useState("loading");
  const [loadError, setLoadError] = React7.useState("");
  const [saveError, setSaveError] = React7.useState("");
  const [busy, setBusy] = React7.useState(false);
  const [reloadTick, setReloadTick] = React7.useState(0);
  React7.useEffect(() => {
    let stopped = false;
    setLoadPhase("loading");
    setLoadError("");
    void fetchAdvanced(transportType).then((advanced) => {
      if (stopped) return;
      const entries = Object.entries(advanced.env);
      setRows(entries.length > 0 ? entries.map(([name2, value]) => ({ name: name2, value })) : [{ name: "", value: "" }]);
      setLoadPhase("ready");
    }).catch((error) => {
      if (stopped) return;
      setLoadError(messageOf(error));
      setLoadPhase("error");
    });
    return () => {
      stopped = true;
    };
  }, [transportType, reloadTick]);
  const onSave = async () => {
    if (busy || loadPhase !== "ready") return;
    setSaveError("");
    const filled = rows.filter((row) => row.name.trim() !== "");
    const env = {};
    for (const row of filled) {
      const name2 = row.name.trim();
      if (!KEY_NAME_PATTERN.test(name2)) {
        setSaveError(`${t("envInvalidKey")}${name2}`);
        return;
      }
      if (RESERVED_KEYS.includes(name2)) {
        setSaveError(`${t("envReservedKey")}${name2}`);
        return;
      }
      if (Object.hasOwn(env, name2)) {
        setSaveError(`${t("envDuplicateKey")}${name2}`);
        return;
      }
      if (CONTROL_CHAR_PATTERN.test(row.value)) {
        setSaveError(`${t("envInvalidValue")}${name2}`);
        return;
      }
      env[name2] = row.value;
    }
    setBusy(true);
    try {
      await postAdvanced(transportType, { env });
      onClose();
    } catch (error) {
      setSaveError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const updateRow = (index, patch) => {
    setRows((prev) => prev.map((row, i) => i === index ? { ...row, ...patch } : row));
  };
  const removeRow = (index) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };
  const addRow = () => {
    setRows((prev) => [...prev, { name: "", value: "" }]);
  };
  return /* @__PURE__ */ React7.createElement(
    DialogShell,
    {
      title: t("envDialogTitle"),
      onClose,
      footer: /* @__PURE__ */ React7.createElement(React7.Fragment, null, /* @__PURE__ */ React7.createElement("button", { type: "button", style: buttonStyle, disabled: busy, onClick: onClose }, t("dlgCancel")), /* @__PURE__ */ React7.createElement(
        "button",
        {
          type: "button",
          style: { ...buttonStyle, fontWeight: 600 },
          disabled: busy || loadPhase !== "ready",
          onClick: () => {
            void onSave();
          }
        },
        busy ? t("dlgSaving") : t("dlgSave")
      ))
    },
    /* @__PURE__ */ React7.createElement("div", { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.5 } }, t("envDialogHint")),
    /* @__PURE__ */ React7.createElement("div", { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.5 } }, t("envDialogDomainHint")),
    dialogLoadState(loadPhase, loadError, () => {
      setReloadTick((value) => value + 1);
    }, t),
    loadPhase === "ready" ? /* @__PURE__ */ React7.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, rows.map((row, index) => /* @__PURE__ */ React7.createElement("div", { key: index, style: { display: "flex", gap: 6, alignItems: "center" } }, /* @__PURE__ */ React7.createElement(
      "input",
      {
        value: row.name,
        placeholder: t("envKey"),
        spellCheck: false,
        style: { ...inputStyle, flex: "0 0 38%", fontFamily: MONO_FONT_FAMILY },
        onChange: (event) => updateRow(index, { name: event.target.value })
      }
    ), /* @__PURE__ */ React7.createElement(
      "input",
      {
        value: row.value,
        placeholder: t("envValue"),
        spellCheck: false,
        style: { ...inputStyle, flex: 1, fontFamily: MONO_FONT_FAMILY },
        onChange: (event) => updateRow(index, { value: event.target.value })
      }
    ), /* @__PURE__ */ React7.createElement(
      "button",
      {
        type: "button",
        style: rowButtonStyle,
        title: t("envRemoveRow"),
        onClick: () => removeRow(index)
      },
      "\u2715"
    ))), /* @__PURE__ */ React7.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } }, /* @__PURE__ */ React7.createElement("button", { type: "button", style: rowButtonStyle, onClick: addRow }, "+ ", t("envAddRow")), /* @__PURE__ */ React7.createElement("span", { style: { fontSize: 11, opacity: 0.6 } }, t("envSkipHint")))) : null,
    /* @__PURE__ */ React7.createElement("div", { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.5 } }, t("envDialogApplyHint")),
    saveError !== "" ? /* @__PURE__ */ React7.createElement("div", { style: { color: "#ef4444", fontSize: 12 } }, t("dlgSaveError"), saveError) : null
  );
}

// src/plugin-client/dialogs/proxy-dialog.tsx
var React8 = __toESM(require("react"), 1);
function ProxyDialog(props) {
  const { onClose, t } = props;
  const [proxy, setProxy] = React8.useState("");
  const [loadPhase, setLoadPhase] = React8.useState("loading");
  const [loadError, setLoadError] = React8.useState("");
  const [saveError, setSaveError] = React8.useState("");
  const [busy, setBusy] = React8.useState(false);
  const [reloadTick, setReloadTick] = React8.useState(0);
  React8.useEffect(() => {
    let stopped = false;
    setLoadPhase("loading");
    setLoadError("");
    void fetchAdvanced("ssh").then((advanced) => {
      if (stopped) return;
      setProxy(advanced.proxy ?? "");
      setLoadPhase("ready");
    }).catch((error) => {
      if (stopped) return;
      setLoadError(messageOf(error));
      setLoadPhase("error");
    });
    return () => {
      stopped = true;
    };
  }, [reloadTick]);
  const onSave = async () => {
    if (busy || loadPhase !== "ready") return;
    setSaveError("");
    setBusy(true);
    try {
      await postAdvanced("ssh", { proxy: proxy.trim() });
      onClose();
    } catch (error) {
      setSaveError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ React8.createElement(
    DialogShell,
    {
      title: t("proxyDialogTitle"),
      onClose,
      footer: /* @__PURE__ */ React8.createElement(React8.Fragment, null, /* @__PURE__ */ React8.createElement("button", { type: "button", style: buttonStyle, disabled: busy, onClick: onClose }, t("dlgCancel")), /* @__PURE__ */ React8.createElement(
        "button",
        {
          type: "button",
          style: { ...buttonStyle, fontWeight: 600 },
          disabled: busy || loadPhase !== "ready",
          onClick: () => {
            void onSave();
          }
        },
        busy ? t("dlgSaving") : t("dlgSave")
      ))
    },
    /* @__PURE__ */ React8.createElement("div", { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.5 } }, t("proxyDialogHint")),
    dialogLoadState(loadPhase, loadError, () => {
      setReloadTick((value) => value + 1);
    }, t),
    loadPhase === "ready" ? /* @__PURE__ */ React8.createElement(
      "input",
      {
        value: proxy,
        placeholder: t("proxyPlaceholder"),
        spellCheck: false,
        style: inputStyle,
        onChange: (event) => setProxy(event.target.value)
      }
    ) : null,
    /* @__PURE__ */ React8.createElement("div", { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.5 } }, t("proxyDialogApplyHint")),
    saveError !== "" ? /* @__PURE__ */ React8.createElement("div", { style: { color: "#ef4444", fontSize: 12 } }, t("dlgSaveError"), saveError) : null
  );
}

// src/plugin-client/dialogs/jump-host-dialog.tsx
var React9 = __toESM(require("react"), 1);
var MONO_FONT_FAMILY2 = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
var AD_HOC_HOST_RE = /^([^@\s]+)@([^@\s]+?)(?::(\d+))?$/;
function JumpHostDialog(props) {
  const { hostValue, hosts, onClose, onSaved, t } = props;
  const trimmed = hostValue.trim();
  const configHost = trimmed !== "" ? hosts.find((item) => item.alias.toLowerCase() === trimmed.toLowerCase()) : void 0;
  const isAdHoc = configHost === void 0 && trimmed !== "" && AD_HOC_HOST_RE.test(trimmed);
  const mode = configHost !== void 0 ? "config" : isAdHoc ? "adHoc" : "unknown";
  const [rows, setRows] = React9.useState([]);
  const [loadPhase, setLoadPhase] = React9.useState("loading");
  const [loadError, setLoadError] = React9.useState("");
  const [saveError, setSaveError] = React9.useState("");
  const [busy, setBusy] = React9.useState(false);
  const [reloadTick, setReloadTick] = React9.useState(0);
  React9.useEffect(() => {
    if (mode !== "adHoc") return;
    let stopped = false;
    setLoadPhase("loading");
    setLoadError("");
    void fetchAdvanced("ssh").then((advanced) => {
      if (stopped) return;
      const stored = advanced.jumpHosts ?? [];
      setRows(stored.length > 0 ? stored.map((entry) => ({
        target: entry.target,
        identityFile: entry.identityFile ?? "",
        password: ""
      })) : [{ target: "", identityFile: "", password: "" }]);
      setLoadPhase("ready");
    }).catch((error) => {
      if (stopped) return;
      setLoadError(messageOf(error));
      setLoadPhase("error");
    });
    return () => {
      stopped = true;
    };
  }, [mode, reloadTick]);
  const updateRow = (index, patch) => {
    setRows((prev) => prev.map((row, i) => i === index ? { ...row, ...patch } : row));
  };
  const removeRow = (index) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };
  const addRow = () => {
    setRows((prev) => [...prev, { target: "", identityFile: "", password: "" }]);
  };
  const onSave = async () => {
    if (busy || loadPhase !== "ready") return;
    setSaveError("");
    const filled = rows.filter((row) => row.target.trim() !== "");
    for (const row of filled) {
      if (/\s/.test(row.target.trim())) {
        setSaveError(`${t("jumpTarget")}\uFF1A${row.target.trim()}`);
        return;
      }
    }
    const stored = filled.map((row) => ({
      target: row.target.trim(),
      ...row.identityFile.trim() !== "" ? { identityFile: row.identityFile.trim() } : {}
    }));
    setBusy(true);
    try {
      await postAdvanced("ssh", { jumpHosts: stored });
      onSaved(filled.map((row) => ({
        target: row.target.trim(),
        ...row.identityFile.trim() !== "" ? { identityFile: row.identityFile.trim() } : {},
        ...row.password !== "" ? { password: row.password } : {}
      })));
      onClose();
    } catch (error) {
      setSaveError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  if (mode === "config") {
    const chain = configHost?.jumpChain;
    return /* @__PURE__ */ React9.createElement(
      DialogShell,
      {
        title: `${t("jumpDialogTitle")}\uFF1A${configHost?.alias ?? ""}`,
        onClose,
        footer: /* @__PURE__ */ React9.createElement("button", { type: "button", style: buttonStyle, onClick: onClose }, t("dlgClose"))
      },
      /* @__PURE__ */ React9.createElement("div", { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.5 } }, t("jumpConfigHint")),
      configHost?.hasProxyJump !== true ? /* @__PURE__ */ React9.createElement("div", { style: { opacity: 0.7 } }, t("jumpNoChain")) : chain !== void 0 && chain.length > 0 ? /* @__PURE__ */ React9.createElement("ol", { style: { margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4 } }, chain.map((hop, index) => /* @__PURE__ */ React9.createElement("li", { key: index, style: { fontFamily: MONO_FONT_FAMILY2, fontSize: 12 } }, hop.username !== "" ? `${hop.username}@` : "", hop.host, ":", hop.port))) : (
        // 有 ProxyJump 但链解析失败（坏引用）：显示原文供排查
        /* @__PURE__ */ React9.createElement("div", { style: { fontFamily: MONO_FONT_FAMILY2, fontSize: 12, opacity: 0.8 } }, configHost?.proxyJump)
      )
    );
  }
  if (mode === "unknown") {
    return /* @__PURE__ */ React9.createElement(
      DialogShell,
      {
        title: t("jumpDialogTitle"),
        onClose,
        footer: /* @__PURE__ */ React9.createElement("button", { type: "button", style: buttonStyle, onClick: onClose }, t("dlgClose"))
      },
      /* @__PURE__ */ React9.createElement("div", { style: { opacity: 0.7 } }, t("jumpUnknownHost"))
    );
  }
  return /* @__PURE__ */ React9.createElement(
    DialogShell,
    {
      title: `${t("jumpDialogTitle")}\uFF1A${trimmed}`,
      onClose,
      footer: /* @__PURE__ */ React9.createElement(React9.Fragment, null, /* @__PURE__ */ React9.createElement("button", { type: "button", style: buttonStyle, disabled: busy, onClick: onClose }, t("dlgCancel")), /* @__PURE__ */ React9.createElement(
        "button",
        {
          type: "button",
          style: { ...buttonStyle, fontWeight: 600 },
          disabled: busy || loadPhase !== "ready",
          onClick: () => {
            void onSave();
          }
        },
        busy ? t("dlgSaving") : t("dlgSave")
      ))
    },
    /* @__PURE__ */ React9.createElement("div", { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.5 } }, t("jumpDirectHint")),
    dialogLoadState(loadPhase, loadError, () => {
      setReloadTick((value) => value + 1);
    }, t),
    loadPhase === "ready" ? /* @__PURE__ */ React9.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, rows.map((row, index) => /* @__PURE__ */ React9.createElement("div", { key: index, style: { display: "flex", flexDirection: "column", gap: 3 } }, /* @__PURE__ */ React9.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } }, /* @__PURE__ */ React9.createElement(
      "input",
      {
        value: row.target,
        placeholder: t("jumpTarget"),
        spellCheck: false,
        style: { ...inputStyle, flex: 1, fontFamily: MONO_FONT_FAMILY2 },
        onChange: (event) => updateRow(index, { target: event.target.value })
      }
    ), /* @__PURE__ */ React9.createElement(
      "button",
      {
        type: "button",
        style: rowButtonStyle,
        title: t("jumpRemoveRow"),
        onClick: () => removeRow(index)
      },
      "\u2715"
    )), /* @__PURE__ */ React9.createElement("div", { style: { display: "flex", gap: 6 } }, /* @__PURE__ */ React9.createElement(
      "input",
      {
        value: row.identityFile,
        placeholder: t("jumpIdentity"),
        spellCheck: false,
        style: { ...inputStyle, flex: 1, fontSize: 12 },
        onChange: (event) => updateRow(index, { identityFile: event.target.value })
      }
    ), /* @__PURE__ */ React9.createElement(
      "input",
      {
        type: "password",
        value: row.password,
        placeholder: t("jumpPassword"),
        autoComplete: "off",
        style: { ...inputStyle, flex: "0 0 32%", fontSize: 12 },
        onChange: (event) => updateRow(index, { password: event.target.value })
      }
    )))), /* @__PURE__ */ React9.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } }, /* @__PURE__ */ React9.createElement("button", { type: "button", style: rowButtonStyle, onClick: addRow }, "+ ", t("jumpAddRow"))), /* @__PURE__ */ React9.createElement("div", { style: { fontSize: 11, opacity: 0.6 } }, t("jumpPasswordHint"))) : null,
    saveError !== "" ? /* @__PURE__ */ React9.createElement("div", { style: { color: "#ef4444", fontSize: 12 } }, t("dlgSaveError"), saveError) : null
  );
}

// src/plugin-client/constants.ts
var SESSIONS_POLL_MS = 2e3;
var LOG_POLL_MS = 1500;
var HANDOFF_COUNTDOWN_SECONDS = 3;
var DESKTOP = isDesktopShell();

// src/plugin-client/ssh-connect-form.tsx
var LAST_CWD_KEY_PREFIX = "dsh-remote-explorer:lastCwd:";
var AD_HOC_HOST_RE2 = /^([^@\s]+)@([^@\s]+?)(?::(\d+))?$/;
function SshConnectForm(props) {
  const { t, hosts, connectedHostAliases, onConnected, onDisconnectHost, onRefreshHosts } = props;
  const [host, setHost] = React10.useState("");
  const [cwd, setCwd] = React10.useState("");
  const [password, setPassword] = React10.useState("");
  const [privateKey, setPrivateKey] = React10.useState("");
  const [localPort, setLocalPort] = React10.useState("");
  const [nodeVersion, setNodeVersion] = React10.useState("");
  const [dshVersion, setDshVersion] = React10.useState("");
  const [forceRestart, setForceRestart] = React10.useState(false);
  const [refreshMirrors, setRefreshMirrors] = React10.useState(false);
  const [busy, setBusy] = React10.useState(false);
  const [formError, setFormError] = React10.useState("");
  const [openDialog, setOpenDialog] = React10.useState(null);
  const closeDialog = React10.useCallback(() => {
    setOpenDialog(null);
  }, []);
  const [jumpEntries, setJumpEntries] = React10.useState(void 0);
  const dshVersions = useDshVersions();
  const hostIsAdHoc = (value) => {
    const trimmed = value.trim();
    if (trimmed === "") return false;
    if (AD_HOC_HOST_RE2.test(trimmed) === false) return false;
    return !hosts.some((item) => item.alias.toLowerCase() === trimmed.toLowerCase());
  };
  const onHostChange = (value) => {
    setHost(value);
    try {
      setCwd(localStorage.getItem(`${LAST_CWD_KEY_PREFIX}${value}`) ?? "");
    } catch {
    }
  };
  const onConnect = async (mode) => {
    if (host.trim() === "" || busy) return;
    setBusy(true);
    setFormError("");
    try {
      const port = Number.parseInt(localPort, 10);
      const session = await postConnect({
        hostAlias: host.trim(),
        ...cwd.trim() !== "" ? { cwd: cwd.trim() } : {},
        ...password !== "" ? { password } : {},
        ...privateKey.trim() !== "" ? { privateKey: privateKey.trim() } : {},
        ...Number.isFinite(port) && port > 0 ? { localPort: port } : {},
        ...nodeVersion.trim() !== "" ? { nodeVersion: nodeVersion.trim() } : {},
        ...dshVersion.trim() !== "" ? { dshVersion: dshVersion.trim() } : {},
        forceRestart,
        refreshMirrors,
        // 跳板机条目：仅直连目标携带（分流规则见文件头）；面板未配置过弹窗
        // 时不带（宿主回落全局存储的持久化子集）
        ...hostIsAdHoc(host) && jumpEntries !== void 0 && jumpEntries.length > 0 ? { jumpHosts: jumpEntries } : {},
        // 管理页 origin：浏览器端给真实 origin（handoff「返回」同标签导航回
        // 管理页）；桌面端给假意图 origin——webview 策略拒绝导航回应用
        // origin，改用这个 origin 让 handoff 三个动作变成可被整窗浮层拦截
        // 的意图信号（见 remote-window.tsx 文件头）
        managerUrl: DESKTOP ? OVERLAY_INTENT_ORIGIN : window.location.origin
      });
      try {
        localStorage.setItem(`${LAST_CWD_KEY_PREFIX}${host.trim()}`, cwd.trim());
      } catch {
      }
      onConnected(session, mode);
    } catch (error) {
      setFormError(messageOf(error));
    } finally {
      setPassword("");
      setJumpEntries((prev) => prev === void 0 ? void 0 : stripJumpPasswords(prev));
      setBusy(false);
    }
  };
  return /* @__PURE__ */ React10.createElement("section", { style: { display: "flex", flexDirection: "column", gap: 8 } }, /* @__PURE__ */ React10.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } }, /* @__PURE__ */ React10.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 2, flex: "1 1 220px" } }, /* @__PURE__ */ React10.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("host")), /* @__PURE__ */ React10.createElement("span", { style: { display: "flex", gap: 4 } }, /* @__PURE__ */ React10.createElement(
    HostPicker,
    {
      value: host,
      onChange: onHostChange,
      hosts,
      connectedHosts: connectedHostAliases,
      t
    }
  ), /* @__PURE__ */ React10.createElement(
    "button",
    {
      type: "button",
      style: buttonStyle,
      title: t("refreshHosts"),
      onClick: onRefreshHosts
    },
    "\u21BB"
  ))), /* @__PURE__ */ React10.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 2, flex: "2 1 300px" } }, /* @__PURE__ */ React10.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("cwd")), /* @__PURE__ */ React10.createElement(
    "input",
    {
      value: cwd,
      placeholder: t("cwdPlaceholder"),
      style: inputStyle,
      onChange: (event) => setCwd(event.target.value)
    }
  ))), /* @__PURE__ */ React10.createElement("details", null, /* @__PURE__ */ React10.createElement("summary", { style: { cursor: "pointer", fontSize: 13, opacity: 0.75 } }, t("advanced")), /* @__PURE__ */ React10.createElement("div", { style: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" } }, /* @__PURE__ */ React10.createElement(
    "button",
    {
      type: "button",
      style: buttonStyle,
      onClick: () => {
        setOpenDialog("jump");
      }
    },
    t("advancedJump")
  ), /* @__PURE__ */ React10.createElement(
    "button",
    {
      type: "button",
      style: buttonStyle,
      onClick: () => {
        setOpenDialog("env");
      }
    },
    t("advancedEnv")
  ), /* @__PURE__ */ React10.createElement(
    "button",
    {
      type: "button",
      style: buttonStyle,
      onClick: () => {
        setOpenDialog("proxy");
      }
    },
    t("advancedProxy")
  )), /* @__PURE__ */ React10.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, marginTop: 8 } }, /* @__PURE__ */ React10.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 2 } }, /* @__PURE__ */ React10.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("localPort")), /* @__PURE__ */ React10.createElement(
    "input",
    {
      value: localPort,
      inputMode: "numeric",
      style: inputStyle,
      onChange: (event) => setLocalPort(event.target.value)
    }
  )), /* @__PURE__ */ React10.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 2 } }, /* @__PURE__ */ React10.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("privateKey")), /* @__PURE__ */ React10.createElement(
    "input",
    {
      value: privateKey,
      style: inputStyle,
      onChange: (event) => setPrivateKey(event.target.value)
    }
  )), /* @__PURE__ */ React10.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 2 } }, /* @__PURE__ */ React10.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("nodeVersion")), /* @__PURE__ */ React10.createElement(
    "input",
    {
      value: nodeVersion,
      placeholder: "v24.21.0",
      style: inputStyle,
      onChange: (event) => setNodeVersion(event.target.value)
    }
  )), /* @__PURE__ */ React10.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 2 } }, /* @__PURE__ */ React10.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("dshVersion")), /* @__PURE__ */ React10.createElement(
    "input",
    {
      value: dshVersion,
      list: "dsh-remote-explorer-dsh-versions",
      style: inputStyle,
      onChange: (event) => setDshVersion(event.target.value)
    }
  ), /* @__PURE__ */ React10.createElement("datalist", { id: "dsh-remote-explorer-dsh-versions" }, dshVersions.map((version) => /* @__PURE__ */ React10.createElement("option", { key: version, value: version })))), /* @__PURE__ */ React10.createElement("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13 } }, /* @__PURE__ */ React10.createElement(
    "input",
    {
      type: "checkbox",
      checked: forceRestart,
      onChange: (event) => setForceRestart(event.target.checked)
    }
  ), t("forceRestart")), /* @__PURE__ */ React10.createElement("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13 } }, /* @__PURE__ */ React10.createElement(
    "input",
    {
      type: "checkbox",
      checked: refreshMirrors,
      onChange: (event) => setRefreshMirrors(event.target.checked)
    }
  ), t("refreshMirrors")))), /* @__PURE__ */ React10.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 2, maxWidth: 420 } }, /* @__PURE__ */ React10.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("password")), /* @__PURE__ */ React10.createElement(
    "input",
    {
      type: "password",
      value: password,
      autoComplete: "off",
      style: inputStyle,
      onChange: (event) => setPassword(event.target.value)
    }
  ), /* @__PURE__ */ React10.createElement("span", { style: { fontSize: 11, opacity: 0.6 } }, t("passwordWarning"))), /* @__PURE__ */ React10.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } }, host.trim() !== "" && connectedHostAliases.has(host.trim()) ? (
    // 选中已连接主机：按钮组整体切换为「断开」（含连接中与外部视图的
    // 主机都算已连接；断开逻辑在面板层——需要会话表数据）
    /* @__PURE__ */ React10.createElement(
      "button",
      {
        type: "button",
        style: { ...buttonStyle, fontWeight: 600 },
        disabled: busy,
        onClick: () => {
          void onDisconnectHost(host.trim());
        }
      },
      busy ? t("connecting") : t("disconnect")
    )
  ) : DESKTOP ? (
    // 桌面端单入口：就绪后开整窗浮动桌面（桌面壳无跨 origin 导航能力）
    /* @__PURE__ */ React10.createElement(
      "button",
      {
        type: "button",
        style: { ...buttonStyle, fontWeight: 600 },
        disabled: busy || host.trim() === "",
        onClick: () => {
          void onConnect("window");
        }
      },
      busy ? t("connecting") : t("connectWindow")
    )
  ) : (
    // 浏览器端双入口（VS Code 语义）：当前标签 = 就绪后同标签切入；新标签 = 本页留守管理
    /* @__PURE__ */ React10.createElement(React10.Fragment, null, /* @__PURE__ */ React10.createElement(
      "button",
      {
        type: "button",
        style: { ...buttonStyle, fontWeight: 600 },
        disabled: busy || host.trim() === "",
        onClick: () => {
          void onConnect("current");
        }
      },
      busy ? t("connecting") : t("connectCurrent")
    ), /* @__PURE__ */ React10.createElement(
      "button",
      {
        type: "button",
        style: buttonStyle,
        disabled: busy || host.trim() === "",
        onClick: () => {
          void onConnect("new");
        }
      },
      t("connectNew")
    ))
  ), formError !== "" ? /* @__PURE__ */ React10.createElement("span", { style: { color: "#ef4444", fontSize: 13 } }, t("connectError"), "\uFF1A", formError) : null), openDialog === "jump" ? /* @__PURE__ */ React10.createElement(
    JumpHostDialog,
    {
      hostValue: host,
      hosts,
      onClose: closeDialog,
      onSaved: (entries) => {
        setJumpEntries(entries);
      },
      t
    }
  ) : null, openDialog === "env" ? /* @__PURE__ */ React10.createElement(EnvDialog, { transportType: "ssh", onClose: closeDialog, t }) : null, openDialog === "proxy" ? /* @__PURE__ */ React10.createElement(ProxyDialog, { onClose: closeDialog, t }) : null);
}
function stripJumpPasswords(entries) {
  return entries.map((entry) => ({
    target: entry.target,
    ...entry.identityFile !== void 0 ? { identityFile: entry.identityFile } : {}
  }));
}

// src/util/session-display.ts
var STATE_COLORS = {
  connected: "#22c55e",
  connecting: "#3b82f6",
  idle: "#9ca3af",
  "heartbeat-missed": "#f59e0b",
  reconnecting: "#f59e0b",
  "reconnect-failed": "#f97316",
  "reconnect-exhausted": "#ef4444",
  disconnected: "#9ca3af"
};
var STATE_LABEL_KEYS = {
  idle: "stateIdle",
  connecting: "stateConnecting",
  connected: "stateConnected",
  "heartbeat-missed": "stateHeartbeatMissed",
  reconnecting: "stateReconnecting",
  "reconnect-failed": "stateReconnectFailed",
  "reconnect-exhausted": "stateReconnectExhausted",
  disconnected: "stateDisconnected"
};

// src/plugin-client/use-session-polling.ts
var React11 = __toESM(require("react"), 1);
function useSessionPolling(options) {
  const { onSessionReady, onSessionError } = options;
  const [sessions, setSessions] = React11.useState([]);
  const [loadError, setLoadError] = React11.useState("");
  const [selectedId, setSelectedId] = React11.useState(null);
  const [log2, setLog] = React11.useState([]);
  const lastSeq = React11.useRef(0);
  const pendingNav = React11.useRef(null);
  const [countdown, setCountdown] = React11.useState(null);
  const onSessionReadyRef = React11.useRef(onSessionReady);
  onSessionReadyRef.current = onSessionReady;
  const onSessionErrorRef = React11.useRef(onSessionError);
  onSessionErrorRef.current = onSessionError;
  React11.useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const next = await fetchSessions();
        if (stopped) return;
        setSessions(next);
        setLoadError("");
        const pending = pendingNav.current;
        if (pending !== null) {
          const ready = next.find((item) => item.sessionId === pending.sessionId && !item.connecting && item.url !== void 0);
          if (ready?.url !== void 0) {
            onSessionReadyRef.current?.(ready);
            pendingNav.current = null;
          } else if (next.some((item) => item.sessionId === pending.sessionId && item.connectError !== void 0)) {
            onSessionErrorRef.current?.(pending.sessionId);
            pendingNav.current = null;
          }
        }
      } catch (error) {
        if (!stopped) setLoadError(messageOf(error));
      }
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, SESSIONS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  React11.useEffect(() => {
    if (countdown === null) return;
    if (countdown.seconds <= 0) {
      window.location.href = countdown.url;
      return;
    }
    const timer = setTimeout(() => {
      setCountdown((previous) => previous === null ? null : { ...previous, seconds: previous.seconds - 1 });
    }, 1e3);
    return () => {
      clearTimeout(timer);
    };
  }, [countdown]);
  React11.useEffect(() => {
    if (selectedId === null) {
      setLog([]);
      lastSeq.current = 0;
      return;
    }
    let stopped = false;
    lastSeq.current = 0;
    setLog([]);
    const tick = async () => {
      try {
        const result = await fetchSessionLog(selectedId, lastSeq.current);
        if (stopped) return;
        if (result.log.length > 0) {
          lastSeq.current = result.log[result.log.length - 1]?.seq ?? lastSeq.current;
          setLog((previous) => [...previous, ...result.log]);
        }
      } catch {
      }
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, LOG_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [selectedId]);
  return {
    sessions,
    loadError,
    setLoadError,
    selectedId,
    setSelectedId,
    log: log2,
    pendingNav,
    countdown,
    setCountdown
  };
}

// src/plugin-client/ssh-panel.tsx
function SshSessionPanel(props) {
  const { t } = props;
  const [hosts, setHosts] = React12.useState([]);
  const [stopRemote, setStopRemote] = React12.useState(true);
  const logBoxRef = React12.useRef(null);
  const {
    sessions,
    loadError,
    setLoadError,
    selectedId,
    setSelectedId,
    log: log2,
    pendingNav,
    countdown,
    setCountdown
  } = useSessionPolling({
    onSessionReady: (ready) => {
      if (ready.url === void 0) return;
      if (pendingNav.current?.mode === "window") {
        openRemoteWindow({
          sessionId: ready.sessionId,
          url: ready.url,
          hostAlias: ready.hostAlias
        });
      } else if (pendingNav.current?.mode === "current") {
        setCountdown({ url: ready.url, seconds: HANDOFF_COUNTDOWN_SECONDS });
      }
    }
    // 失败不空等：错误已在表单区呈现
  });
  const loadHosts = React12.useCallback(async (refresh) => {
    try {
      setHosts(await fetchHosts(refresh));
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, [setLoadError]);
  React12.useEffect(() => {
    void loadHosts(false);
  }, [loadHosts]);
  React12.useEffect(() => {
    const box = logBoxRef.current;
    if (box !== null) box.scrollTop = box.scrollHeight;
  }, [log2]);
  const onConnected = (session, mode) => {
    pendingNav.current = { sessionId: session.sessionId, mode };
    setSelectedId(session.sessionId);
  };
  const onDisconnect = async (target) => {
    setLoadError("");
    try {
      await postDisconnect(target, stopRemote);
    } catch (error) {
      setLoadError(messageOf(error));
    }
  };
  const connectedHostAliases = React12.useMemo(() => {
    const set = /* @__PURE__ */ new Set();
    for (const item of sessions) {
      if (item.connecting || item.state.tag !== "disconnected") set.add(item.hostAlias);
    }
    return set;
  }, [sessions]);
  const onDisconnectHost = async (hostAlias) => {
    const targets = sessions.filter((item) => item.hostAlias === hostAlias && item.external !== true && (item.connecting || item.state.tag !== "disconnected"));
    if (targets.length === 0) {
      setLoadError(t("hostDisconnectExternal"));
      return;
    }
    const errors = [];
    try {
      for (const item of targets) {
        try {
          await postDisconnect(item.sessionId, stopRemote);
        } catch (error) {
          errors.push(messageOf(error));
        }
      }
    } finally {
      if (errors.length > 0) setLoadError(errors.join("\uFF1B"));
    }
  };
  return /* @__PURE__ */ React12.createElement("div", { style: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    padding: "16px 20px",
    height: "100%",
    overflowY: "auto",
    boxSizing: "border-box"
  } }, /* @__PURE__ */ React12.createElement("h2", { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, t("nav")), /* @__PURE__ */ React12.createElement("p", { style: { margin: 0, opacity: 0.75, fontSize: 13 } }, t("sshSectionIntro")), countdown !== null ? /* @__PURE__ */ React12.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", fontSize: 13 } }, /* @__PURE__ */ React12.createElement("span", null, t("countdown"), " ", countdown.seconds, "s"), /* @__PURE__ */ React12.createElement(
    "button",
    {
      type: "button",
      style: {
        color: "inherit",
        background: "transparent",
        border: "1px solid rgba(127,127,127,0.5)",
        borderRadius: 6,
        padding: "2px 8px",
        cursor: "pointer",
        fontSize: 12
      },
      onClick: () => {
        pendingNav.current = null;
        setCountdown(null);
      }
    },
    t("cancelCountdown")
  )) : null, /* @__PURE__ */ React12.createElement(
    SshConnectForm,
    {
      t,
      hosts,
      connectedHostAliases,
      onConnected,
      onDisconnectHost: (hostAlias) => {
        void onDisconnectHost(hostAlias);
      },
      onRefreshHosts: () => {
        void loadHosts(true);
      }
    }
  ), /* @__PURE__ */ React12.createElement("section", null, /* @__PURE__ */ React12.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, marginBottom: 6 } }, /* @__PURE__ */ React12.createElement("strong", { style: { fontSize: 14 } }, t("sessions")), /* @__PURE__ */ React12.createElement("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, opacity: 0.75 } }, /* @__PURE__ */ React12.createElement(
    "input",
    {
      type: "checkbox",
      checked: stopRemote,
      onChange: (event) => setStopRemote(event.target.checked)
    }
  ), t("stopRemote"))), loadError !== "" ? /* @__PURE__ */ React12.createElement("div", { style: { color: "#ef4444", fontSize: 13, marginBottom: 6 } }, t("loadError"), "\uFF1A", loadError) : null, sessions.length === 0 ? /* @__PURE__ */ React12.createElement("div", { style: { fontSize: 13, opacity: 0.6 } }, t("noSessions")) : /* @__PURE__ */ React12.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, sessions.map((session) => renderSessionRow(session, selectedId, t, DESKTOP, {
    onSelect: setSelectedId,
    onDisconnect: (target) => {
      void onDisconnect(target);
    }
  })))), /* @__PURE__ */ React12.createElement("section", null, /* @__PURE__ */ React12.createElement("strong", { style: { fontSize: 14 } }, t("log")), /* @__PURE__ */ React12.createElement("div", { ref: logBoxRef, style: {
    marginTop: 6,
    height: 240,
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.5,
    padding: "6px 8px",
    border: "1px solid rgba(127,127,127,0.35)",
    borderRadius: 6
  } }, selectedId === null || log2.length === 0 ? /* @__PURE__ */ React12.createElement("span", { style: { opacity: 0.55 } }, t("logEmpty")) : log2.map((entry) => /* @__PURE__ */ React12.createElement("div", { key: entry.seq }, /* @__PURE__ */ React12.createElement("span", { style: { opacity: 0.55 } }, entry.ts.slice(11, 19)), " ", /* @__PURE__ */ React12.createElement("span", { style: { opacity: 0.75 } }, "[", entry.kind, "]"), " ", /* @__PURE__ */ React12.createElement("span", { style: entry.kind === "error" ? { color: "#ef4444" } : void 0 }, entry.text))))));
}
function renderSessionRow(session, selectedId, t, isDesktop, actions) {
  const stateTag = session.connecting ? "connecting" : session.state.tag;
  const stateLabel = t(STATE_LABEL_KEYS[stateTag] ?? "stateIdle");
  const stateColor = STATE_COLORS[stateTag] ?? "#9ca3af";
  const missingKeys = session.missingKeyEnvs ?? [];
  return /* @__PURE__ */ React12.createElement(
    "div",
    {
      key: session.sessionId,
      onClick: () => actions.onSelect(session.sessionId),
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 8px",
        border: "1px solid rgba(127,127,127,0.3)",
        borderRadius: 6,
        cursor: "pointer",
        background: session.sessionId === selectedId ? "rgba(127,127,127,0.12)" : "transparent",
        flexWrap: "wrap"
      }
    },
    /* @__PURE__ */ React12.createElement("span", { title: stateLabel, style: {
      width: 9,
      height: 9,
      borderRadius: "50%",
      flexShrink: 0,
      backgroundColor: stateColor,
      display: "inline-block"
    } }),
    /* @__PURE__ */ React12.createElement("span", { style: { fontWeight: 600, fontSize: 13 } }, session.hostAlias),
    /* @__PURE__ */ React12.createElement("span", { style: { fontSize: 12, opacity: 0.7 } }, session.remoteCwd === "" ? "~" : session.remoteCwd),
    /* @__PURE__ */ React12.createElement("span", { style: { fontSize: 12, opacity: 0.7 } }, stateLabel),
    session.localPort !== void 0 ? /* @__PURE__ */ React12.createElement("span", { style: { fontSize: 12, opacity: 0.7 } }, "127.0.0.1:", session.localPort) : null,
    session.external === true ? /* @__PURE__ */ React12.createElement("span", { style: { fontSize: 11, opacity: 0.6 } }, t("external")) : null,
    session.connectError !== void 0 ? /* @__PURE__ */ React12.createElement("span", { style: { fontSize: 12, color: "#ef4444" } }, session.connectError) : null,
    missingKeys.length > 0 ? /* @__PURE__ */ React12.createElement("span", { style: { fontSize: 11, color: "#f59e0b" }, title: missingKeys.join(", ") }, t("missingKeys"), ": ", missingKeys.join(", ")) : null,
    /* @__PURE__ */ React12.createElement("span", { style: { flex: 1 } }),
    session.url !== void 0 ? isDesktop ? (
      // 桌面端单入口：开整窗浮动桌面（跨 origin 导航会被桌面壳甩给系统浏览器）
      /* @__PURE__ */ React12.createElement(
        "button",
        {
          type: "button",
          onClick: (event) => {
            event.stopPropagation();
            openRemoteWindow({
              sessionId: session.sessionId,
              url: session.url ?? "",
              hostAlias: session.hostAlias
            });
          },
          style: {
            background: "transparent",
            color: "inherit",
            fontSize: 12,
            fontWeight: 600,
            border: "1px solid rgba(127,127,127,0.5)",
            borderRadius: 6,
            padding: "2px 8px",
            cursor: "pointer"
          }
        },
        t("openWindow")
      )
    ) : (
      // 浏览器端双入口：同标签切入 / 新标签
      /* @__PURE__ */ React12.createElement(React12.Fragment, null, /* @__PURE__ */ React12.createElement(
        "button",
        {
          type: "button",
          onClick: (event) => {
            event.stopPropagation();
            window.location.href = session.url ?? "";
          },
          style: {
            background: "transparent",
            color: "inherit",
            fontSize: 12,
            fontWeight: 600,
            border: "1px solid rgba(127,127,127,0.5)",
            borderRadius: 6,
            padding: "2px 8px",
            cursor: "pointer"
          }
        },
        t("enterCurrent")
      ), /* @__PURE__ */ React12.createElement(
        "a",
        {
          href: session.url,
          target: "_blank",
          rel: "noreferrer",
          onClick: (event) => event.stopPropagation(),
          style: { fontSize: 13 }
        },
        t("openNew"),
        " \u2197"
      ))
    ) : null,
    session.external === true ? null : /* @__PURE__ */ React12.createElement(
      "button",
      {
        type: "button",
        onClick: (event) => {
          event.stopPropagation();
          actions.onDisconnect(session.sessionId);
        },
        style: {
          background: "transparent",
          color: "inherit",
          fontSize: 12,
          border: "1px solid rgba(127,127,127,0.5)",
          borderRadius: 6,
          padding: "2px 8px",
          cursor: "pointer"
        }
      },
      t("disconnect")
    )
  );
}

// src/plugin-client/wsl-panel.tsx
var React13 = __toESM(require("react"), 1);
var logger = createLogger("wsl-panel");
var LAST_CWD_KEY_PREFIX2 = "dsh-remote-explorer:wsl:lastCwd:";
function WslSessionPanel(props) {
  const { t } = props;
  const [distroName, setDistroName] = React13.useState("");
  const [cwd, setCwd] = React13.useState("");
  const [wslUser, setWslUser] = React13.useState("");
  const [localPort, setLocalPort] = React13.useState("");
  const [nodeVersion, setNodeVersion] = React13.useState("");
  const [dshVersion, setDshVersion] = React13.useState("");
  const [forceRestart, setForceRestart] = React13.useState(false);
  const [busy, setBusy] = React13.useState(false);
  const [formError, setFormError] = React13.useState("");
  const [distros, setDistros] = React13.useState([]);
  const dshVersions = useDshVersions();
  const [stopRemote, setStopRemote] = React13.useState(true);
  const logBoxRef = React13.useRef(null);
  const [openDialog, setOpenDialog] = React13.useState(null);
  const closeDialog = React13.useCallback(() => {
    setOpenDialog(null);
  }, []);
  const {
    sessions,
    loadError,
    setLoadError,
    selectedId,
    setSelectedId,
    log: log2,
    pendingNav,
    countdown,
    setCountdown
  } = useSessionPolling({
    onSessionReady: (ready) => {
      if (ready.url === void 0) return;
      logger.info("\u4F1A\u8BDD\u5C31\u7EEA\uFF0C\u89E6\u53D1\u7A97\u53E3\u4EA4\u63A5", { mode: pendingNav.current?.mode, url: ready.url, sessionId: ready.sessionId });
      if (pendingNav.current?.mode === "window") {
        openRemoteWindow({
          sessionId: ready.sessionId,
          url: ready.url,
          hostAlias: ready.hostAlias
        });
      } else if (pendingNav.current?.mode === "current") {
        setCountdown({ url: ready.url, seconds: HANDOFF_COUNTDOWN_SECONDS });
      }
    },
    onSessionError: (sessionId) => {
      logger.info("\u4F1A\u8BDD\u8FDE\u63A5\u5931\u8D25", { sessionId });
    }
  });
  const loadDistros = React13.useCallback(async (refresh) => {
    try {
      setDistros(await fetchWslDistros(refresh));
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, [setLoadError]);
  React13.useEffect(() => {
    void loadDistros(false);
  }, [loadDistros]);
  React13.useEffect(() => {
    const box = logBoxRef.current;
    if (box !== null) box.scrollTop = box.scrollHeight;
  }, [log2]);
  const onDistroChange = (value) => {
    setDistroName(value);
    try {
      setCwd(localStorage.getItem(`${LAST_CWD_KEY_PREFIX2}${value}`) ?? "");
    } catch {
    }
  };
  const onConnect = async (mode) => {
    if (distroName.trim() === "" || busy) return;
    setBusy(true);
    setFormError("");
    try {
      const port = Number.parseInt(localPort, 10);
      logger.info("postConnect \u8BF7\u6C42", { distroName: distroName.trim(), mode, desktop: DESKTOP });
      const session = await postConnect({
        // WSL 模式下 hostAlias 带 wsl: 前缀，与 CLI 和 WslTransport.hostAlias 保持一致
        hostAlias: `wsl:${distroName.trim()}`,
        transportType: "wsl",
        distroName: distroName.trim(),
        ...wslUser.trim() !== "" ? { wslUser: wslUser.trim() } : {},
        ...cwd.trim() !== "" ? { cwd: cwd.trim() } : {},
        ...Number.isFinite(port) && port > 0 ? { localPort: port } : {},
        ...nodeVersion.trim() !== "" ? { nodeVersion: nodeVersion.trim() } : {},
        ...dshVersion.trim() !== "" ? { dshVersion: dshVersion.trim() } : {},
        forceRestart,
        managerUrl: DESKTOP ? OVERLAY_INTENT_ORIGIN : window.location.origin
      });
      logger.info("postConnect \u8FD4\u56DE", { sessionId: session.sessionId, connecting: session.connecting, url: session.url });
      pendingNav.current = { sessionId: session.sessionId, mode };
      try {
        localStorage.setItem(`${LAST_CWD_KEY_PREFIX2}${distroName.trim()}`, cwd.trim());
      } catch {
      }
      setSelectedId(session.sessionId);
    } catch (error) {
      setFormError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const onDisconnect = async (target) => {
    setLoadError("");
    try {
      await postDisconnect(target, stopRemote);
    } catch (error) {
      setLoadError(messageOf(error));
    }
  };
  const formatState = (state) => {
    const lower = state.toLowerCase();
    if (lower === "running") return t("wslStateRunning");
    if (lower === "stopped") return t("wslStateStopped");
    return state;
  };
  return /* @__PURE__ */ React13.createElement("div", { style: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    padding: "16px 20px",
    height: "100%",
    overflowY: "auto",
    boxSizing: "border-box"
  } }, /* @__PURE__ */ React13.createElement("h2", { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, t("nav")), /* @__PURE__ */ React13.createElement("p", { style: { margin: 0, opacity: 0.75, fontSize: 13 } }, t("wslSectionIntro")), countdown !== null ? /* @__PURE__ */ React13.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", fontSize: 13 } }, /* @__PURE__ */ React13.createElement("span", null, t("countdown"), " ", countdown.seconds, "s"), /* @__PURE__ */ React13.createElement(
    "button",
    {
      type: "button",
      style: buttonStyle,
      onClick: () => {
        pendingNav.current = null;
        setCountdown(null);
      }
    },
    t("cancelCountdown")
  )) : null, /* @__PURE__ */ React13.createElement("section", { style: { display: "flex", flexDirection: "column", gap: 8 } }, /* @__PURE__ */ React13.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } }, /* @__PURE__ */ React13.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 2, flex: "1 1 220px" } }, /* @__PURE__ */ React13.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("wslDistro")), /* @__PURE__ */ React13.createElement("span", { style: { display: "flex", gap: 4 } }, /* @__PURE__ */ React13.createElement(
    "input",
    {
      list: "dsh-remote-explorer-wsl-distros",
      value: distroName,
      placeholder: t("wslDistroPlaceholder"),
      style: { ...inputStyle, flex: 1 },
      onChange: (event) => onDistroChange(event.target.value)
    }
  ), /* @__PURE__ */ React13.createElement(
    "button",
    {
      type: "button",
      style: buttonStyle,
      title: t("refreshDistros"),
      onClick: () => {
        void loadDistros(true);
      }
    },
    "\u21BB"
  ))), /* @__PURE__ */ React13.createElement("datalist", { id: "dsh-remote-explorer-wsl-distros" }, distros.map((distro) => /* @__PURE__ */ React13.createElement("option", { key: distro.name, value: distro.name }, `${distro.name} (${t("wslVersion")} ${distro.version}, ${formatState(distro.state)}${distro.isDefault ? `, ${t("wslDefault")}` : ""})`))), /* @__PURE__ */ React13.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 2, flex: "2 1 300px" } }, /* @__PURE__ */ React13.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("cwd")), /* @__PURE__ */ React13.createElement(
    "input",
    {
      value: cwd,
      placeholder: t("cwdPlaceholder"),
      style: inputStyle,
      onChange: (event) => setCwd(event.target.value)
    }
  ))), /* @__PURE__ */ React13.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 2, maxWidth: 320 } }, /* @__PURE__ */ React13.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("wslUser")), /* @__PURE__ */ React13.createElement(
    "input",
    {
      value: wslUser,
      placeholder: t("wslUserPlaceholder"),
      style: inputStyle,
      onChange: (event) => setWslUser(event.target.value)
    }
  )), distros.length === 0 && loadError === "" ? /* @__PURE__ */ React13.createElement("div", { style: { fontSize: 13, opacity: 0.6 } }, t("wslNoDistros")) : null, /* @__PURE__ */ React13.createElement("details", null, /* @__PURE__ */ React13.createElement("summary", { style: { cursor: "pointer", fontSize: 13, opacity: 0.75 } }, t("advanced")), /* @__PURE__ */ React13.createElement("div", { style: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" } }, /* @__PURE__ */ React13.createElement(
    "button",
    {
      type: "button",
      style: buttonStyle,
      onClick: () => {
        setOpenDialog("env");
      }
    },
    t("advancedEnv")
  )), /* @__PURE__ */ React13.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, marginTop: 8 } }, /* @__PURE__ */ React13.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 2 } }, /* @__PURE__ */ React13.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("localPort")), /* @__PURE__ */ React13.createElement(
    "input",
    {
      value: localPort,
      inputMode: "numeric",
      style: inputStyle,
      onChange: (event) => setLocalPort(event.target.value)
    }
  )), /* @__PURE__ */ React13.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 2 } }, /* @__PURE__ */ React13.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("nodeVersion")), /* @__PURE__ */ React13.createElement(
    "input",
    {
      value: nodeVersion,
      placeholder: "v24.21.0",
      style: inputStyle,
      onChange: (event) => setNodeVersion(event.target.value)
    }
  )), /* @__PURE__ */ React13.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 2 } }, /* @__PURE__ */ React13.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("dshVersion")), /* @__PURE__ */ React13.createElement(
    "input",
    {
      value: dshVersion,
      list: "dsh-remote-explorer-wsl-dsh-versions",
      style: inputStyle,
      onChange: (event) => setDshVersion(event.target.value)
    }
  ), /* @__PURE__ */ React13.createElement("datalist", { id: "dsh-remote-explorer-wsl-dsh-versions" }, dshVersions.map((version) => /* @__PURE__ */ React13.createElement("option", { key: version, value: version })))), /* @__PURE__ */ React13.createElement("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13 } }, /* @__PURE__ */ React13.createElement(
    "input",
    {
      type: "checkbox",
      checked: forceRestart,
      onChange: (event) => setForceRestart(event.target.checked)
    }
  ), t("forceRestart")))), /* @__PURE__ */ React13.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } }, DESKTOP ? /* @__PURE__ */ React13.createElement(
    "button",
    {
      type: "button",
      style: { ...buttonStyle, fontWeight: 600 },
      disabled: busy || distroName.trim() === "",
      onClick: () => {
        void onConnect("window");
      }
    },
    busy ? t("connecting") : t("connectWindow")
  ) : /* @__PURE__ */ React13.createElement(React13.Fragment, null, /* @__PURE__ */ React13.createElement(
    "button",
    {
      type: "button",
      style: { ...buttonStyle, fontWeight: 600 },
      disabled: busy || distroName.trim() === "",
      onClick: () => {
        void onConnect("current");
      }
    },
    busy ? t("connecting") : t("connectCurrent")
  ), /* @__PURE__ */ React13.createElement(
    "button",
    {
      type: "button",
      style: buttonStyle,
      disabled: busy || distroName.trim() === "",
      onClick: () => {
        void onConnect("new");
      }
    },
    t("connectNew")
  )), formError !== "" ? /* @__PURE__ */ React13.createElement("span", { style: { color: "#ef4444", fontSize: 13 } }, t("connectError"), "\uFF1A", formError) : null), openDialog === "env" ? /* @__PURE__ */ React13.createElement(EnvDialog, { transportType: "wsl", onClose: closeDialog, t }) : null), /* @__PURE__ */ React13.createElement("section", null, /* @__PURE__ */ React13.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, marginBottom: 6 } }, /* @__PURE__ */ React13.createElement("strong", { style: { fontSize: 14 } }, t("sessions")), /* @__PURE__ */ React13.createElement("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, opacity: 0.75 } }, /* @__PURE__ */ React13.createElement(
    "input",
    {
      type: "checkbox",
      checked: stopRemote,
      onChange: (event) => setStopRemote(event.target.checked)
    }
  ), t("stopRemote"))), loadError !== "" ? /* @__PURE__ */ React13.createElement("div", { style: { color: "#ef4444", fontSize: 13, marginBottom: 6 } }, t("loadError"), "\uFF1A", loadError) : null, sessions.length === 0 ? /* @__PURE__ */ React13.createElement("div", { style: { fontSize: 13, opacity: 0.6 } }, t("noSessions")) : /* @__PURE__ */ React13.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, sessions.map((session) => renderSessionRow(session, selectedId, t, DESKTOP, {
    onSelect: setSelectedId,
    onDisconnect: (target) => {
      void onDisconnect(target);
    }
  })))), /* @__PURE__ */ React13.createElement("section", null, /* @__PURE__ */ React13.createElement("strong", { style: { fontSize: 14 } }, t("log")), /* @__PURE__ */ React13.createElement("div", { ref: logBoxRef, style: {
    marginTop: 6,
    height: 240,
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.5,
    padding: "6px 8px",
    border: "1px solid rgba(127,127,127,0.35)",
    borderRadius: 6
  } }, selectedId === null || log2.length === 0 ? /* @__PURE__ */ React13.createElement("span", { style: { opacity: 0.55 } }, t("logEmpty")) : log2.map((entry) => /* @__PURE__ */ React13.createElement("div", { key: entry.seq }, /* @__PURE__ */ React13.createElement("span", { style: { opacity: 0.55 } }, entry.ts.slice(11, 19)), " ", /* @__PURE__ */ React13.createElement("span", { style: { opacity: 0.75 } }, "[", entry.kind, "]"), " ", /* @__PURE__ */ React13.createElement("span", { style: entry.kind === "error" ? { color: "#ef4444" } : void 0 }, entry.text))))));
}

// src/plugin-client/index.tsx
var LOCALE_NS = "dshRemoteExplorer";
var PANEL_ID = "remote-sessions";
var PANEL_ORDER = 20;
var name = "dsh-remote-explorer";
var inject = ["slots", "locale"];
function isWindowsPlatform() {
  try {
    return /win/i.test(navigator.platform ?? "");
  } catch {
    return false;
  }
}
function RemoteSessionRouter(props) {
  const { t } = props;
  const [activeView, setActiveView] = React14.useState("menu");
  const [wslAvailable, setWslAvailable] = React14.useState(null);
  const [wslChecking, setWslChecking] = React14.useState(false);
  const buttonStyle2 = {
    background: "transparent",
    color: "inherit",
    border: "1px solid rgba(127,127,127,0.5)",
    borderRadius: 6,
    padding: "4px 12px",
    cursor: "pointer",
    fontSize: 13
  };
  const cardStyle = {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "12px 16px",
    border: "1px solid rgba(127,127,127,0.4)",
    borderRadius: 8,
    cursor: "pointer",
    background: "transparent",
    color: "inherit",
    textAlign: "left",
    width: "100%",
    transition: "background 0.15s"
  };
  const onWslCardClick = async () => {
    setWslChecking(true);
    try {
      const distros = await fetchWslDistros(true);
      if (distros.length > 0) {
        setWslAvailable(true);
        setActiveView("wsl");
      } else {
        setWslAvailable(false);
      }
    } catch {
      setWslAvailable(false);
    } finally {
      setWslChecking(false);
    }
  };
  if (activeView === "menu") {
    const showWsl = isWindowsPlatform();
    return /* @__PURE__ */ React14.createElement("div", { style: {
      display: "flex",
      flexDirection: "column",
      gap: 16,
      padding: "16px 20px",
      height: "100%",
      boxSizing: "border-box"
    } }, /* @__PURE__ */ React14.createElement("h2", { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, t("nav")), /* @__PURE__ */ React14.createElement("p", { style: { margin: 0, opacity: 0.75, fontSize: 13 } }, t("sectionIntro")), /* @__PURE__ */ React14.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginTop: 8, maxWidth: 400 } }, /* @__PURE__ */ React14.createElement(
      "button",
      {
        type: "button",
        style: cardStyle,
        onMouseEnter: (e) => {
          e.currentTarget.style.background = "rgba(127,127,127,0.1)";
        },
        onMouseLeave: (e) => {
          e.currentTarget.style.background = "transparent";
        },
        onClick: () => {
          setActiveView("ssh");
        }
      },
      /* @__PURE__ */ React14.createElement("span", { style: { fontWeight: 600, fontSize: 14 } }, t("menuSsh")),
      /* @__PURE__ */ React14.createElement("span", { style: { fontSize: 12, opacity: 0.7 } }, t("sshSectionIntro"))
    ), showWsl && /* @__PURE__ */ React14.createElement(
      "button",
      {
        type: "button",
        style: cardStyle,
        onMouseEnter: (e) => {
          e.currentTarget.style.background = "rgba(127,127,127,0.1)";
        },
        onMouseLeave: (e) => {
          e.currentTarget.style.background = "transparent";
        },
        onClick: () => {
          void onWslCardClick();
        },
        disabled: wslChecking
      },
      /* @__PURE__ */ React14.createElement("span", { style: { fontWeight: 600, fontSize: 14 } }, wslChecking ? `${t("menuWsl")}\u2026` : t("menuWsl")),
      /* @__PURE__ */ React14.createElement("span", { style: { fontSize: 12, opacity: 0.7 } }, t("wslSectionIntro"))
    )), wslAvailable === false && /* @__PURE__ */ React14.createElement("div", { style: {
      marginTop: 8,
      padding: "12px 16px",
      maxWidth: 400,
      border: "1px solid rgba(239,68,68,0.4)",
      borderRadius: 8,
      fontSize: 13,
      lineHeight: 1.6
    } }, /* @__PURE__ */ React14.createElement("strong", { style: { color: "#ef4444" } }, t("wslNotInstalledTitle")), /* @__PURE__ */ React14.createElement("p", { style: { margin: "6px 0 0", opacity: 0.85 } }, t("wslNotInstalledHint")), /* @__PURE__ */ React14.createElement(
      "button",
      {
        type: "button",
        style: { ...buttonStyle2, marginTop: 8, fontSize: 12 },
        onClick: () => {
          setWslAvailable(null);
        }
      },
      t("retry")
    )));
  }
  return /* @__PURE__ */ React14.createElement("div", { style: { display: "flex", flexDirection: "column", height: "100%" } }, /* @__PURE__ */ React14.createElement("div", { style: { padding: "8px 20px 0", flexShrink: 0 } }, /* @__PURE__ */ React14.createElement(
    "button",
    {
      type: "button",
      style: buttonStyle2,
      onClick: () => {
        setActiveView("menu");
      }
    },
    "\u2190 ",
    t("nav")
  )), /* @__PURE__ */ React14.createElement("div", { style: { flex: 1, minHeight: 0 } }, activeView === "ssh" ? /* @__PURE__ */ React14.createElement(SshSessionPanel, { t }) : /* @__PURE__ */ React14.createElement(WslSessionPanel, { t })));
}
function apply(ctx) {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, { zh, en }),
    "dsh-remote-explorer: locales"
  );
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,
    locale: LOCALE_NS
  }, RemoteSessionRouter));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: PANEL_ORDER,
    label: () => ctx.locale.bind(LOCALE_NS)("nav"),
    locale: LOCALE_NS
  }, RemoteSessionsIcon));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: "dsh-remote-explorer-intent",
    locale: LOCALE_NS
  }, IntentBanner));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: "dsh-remote-explorer-remote-window",
    locale: LOCALE_NS
  }, RemoteWindowOverlay));
}
return module.exports; } });

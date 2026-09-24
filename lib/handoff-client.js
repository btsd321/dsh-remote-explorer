window.__ModuleLoader__.load({ id: "dsh-remote-handoff", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// src/handoff/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var React = __toESM(require("react"), 1);

// src/handoff/protocol.ts
var HANDOFF_ROUTE_PREFIX = "/api/dsh-remote-handoff";
var HANDOFF_PROTOCOL_VERSION = 1;

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

// src/handoff/client.tsx
var zh = {
  pill: "\u8FDC\u7A0B\u4F1A\u8BDD\uFF08\u672C\u673A\u7BA1\u7406\uFF09",
  menuTitle: "\u672C\u673A\u8FDE\u63A5\u7BA1\u7406",
  log: "\u8FDB\u5EA6\u65E5\u5FD7",
  logEmpty: "\u6682\u65E0\u65E5\u5FD7",
  managerOpen: "\u8FD4\u56DE\u672C\u5730\u7BA1\u7406\u9875",
  managerClose: "\u5173\u95ED\u8FDC\u7A0B\u8FDE\u63A5\u5E76\u8FD4\u56DE",
  managerStop: "\u505C\u6B62\u8FDC\u7AEF dsh \u5E76\u8FD4\u56DE",
  managerMissing: "\u672C\u673A\u7BA1\u7406\u9875\u5730\u5740\u672A\u77E5\uFF08CLI \u5F62\u6001\u4F1A\u8BDD\uFF09\u2014\u2014\u8BF7\u7528 CLI \u7684 status/kill \u7BA1\u7406",
  versionMismatch: "\u672C\u673A\u4E0E\u8FDC\u7AEF\u4EA4\u63A5\u7EC4\u4EF6\u7248\u672C\u4E0D\u4E00\u81F4\uFF0C\u83DC\u5355\u964D\u7EA7\u4E3A\u53EA\u8BFB",
  managerUnreachable: "\u672C\u673A\u7BA1\u7406\u901A\u9053\u4E0D\u53EF\u8FBE\uFF08\u672C\u5730 dsh \u53EF\u80FD\u5DF2\u9000\u51FA\uFF09",
  stateConnecting: "\u8FDE\u63A5\u4E2D",
  stateConnected: "\u5DF2\u8FDE\u63A5",
  stateHeartbeatMissed: "\u5FC3\u8DF3\u4E22\u5931",
  stateReconnecting: "\u91CD\u8FDE\u4E2D",
  stateReconnectFailed: "\u91CD\u8FDE\u5931\u8D25",
  stateReconnectExhausted: "\u91CD\u8FDE\u6B21\u6570\u7528\u5C3D",
  stateDisconnected: "\u5DF2\u65AD\u5F00",
  stateIdle: "\u672A\u5F00\u59CB"
};
var en = {
  pill: "Remote session (managed locally)",
  menuTitle: "Local connection manager",
  log: "Progress log",
  logEmpty: "No log yet",
  managerOpen: "Back to local manager",
  managerClose: "Close remote connection and return",
  managerStop: "Stop remote dsh and return",
  managerMissing: "Local manager URL unknown (CLI session) \u2014 manage it via CLI status/kill",
  versionMismatch: "Handoff protocol mismatch; menu is read-only",
  managerUnreachable: "Local manager unreachable (local dsh may have exited)",
  stateConnecting: "Connecting",
  stateConnected: "Connected",
  stateHeartbeatMissed: "Heartbeat missed",
  stateReconnecting: "Reconnecting",
  stateReconnectFailed: "Reconnect failed",
  stateReconnectExhausted: "Reconnect exhausted",
  stateDisconnected: "Disconnected",
  stateIdle: "Idle"
};
var LOCALE_NS = "dshRemoteHandoff";
var STATE_POLL_MS = 2e3;
var LOG_POLL_MS = 1500;
var name = "dsh-remote-handoff";
var inject = ["slots", "locale"];
function apply(ctx) {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, { zh, en }),
    "dsh-remote-handoff: locales"
  );
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "dsh-remote-handoff",
    locale: LOCALE_NS
  }, HandoffPill));
}
function HandoffPill(props) {
  const { t, wide } = props;
  const [meta, setMeta] = React.useState(void 0);
  const [state, setState] = React.useState(null);
  const [unreachable, setUnreachable] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [log, setLog] = React.useState([]);
  const [menuPos, setMenuPos] = React.useState(null);
  const lastSeq = React.useRef(0);
  const logBoxRef = React.useRef(null);
  const buttonRef = React.useRef(null);
  React.useEffect(() => {
    let stopped = false;
    void fetch(`${HANDOFF_ROUTE_PREFIX}/meta`).then((response) => response.ok ? response.json() : Promise.reject(new Error())).then((value) => {
      if (!stopped) setMeta(value);
    }).catch(() => {
      if (!stopped) setMeta(null);
    });
    return () => {
      stopped = true;
    };
  }, []);
  React.useEffect(() => {
    if (meta === void 0 || meta === null) return;
    let stopped = false;
    const tick = async () => {
      try {
        const response = await fetch(`${HANDOFF_ROUTE_PREFIX}/state?id=${encodeURIComponent(meta.sessionId)}`);
        if (stopped) return;
        if (response.ok) {
          setState(await response.json());
          setUnreachable(false);
        } else if (response.status === 502) {
          setUnreachable(true);
        }
      } catch {
      }
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, STATE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [meta]);
  React.useEffect(() => {
    if (!open || state === null) {
      setLog([]);
      lastSeq.current = 0;
      return;
    }
    let stopped = false;
    lastSeq.current = 0;
    setLog([]);
    const tick = async () => {
      try {
        const response = await fetch(
          `${HANDOFF_ROUTE_PREFIX}/log?id=${encodeURIComponent(state.sessionId)}&since=${lastSeq.current}`
        );
        if (stopped || !response.ok) return;
        const body = await response.json();
        if (body.log.length > 0) {
          lastSeq.current = body.log[body.log.length - 1]?.seq ?? lastSeq.current;
          setLog((previous) => [...previous, ...body.log]);
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
  }, [open, state]);
  React.useEffect(() => {
    const box = logBoxRef.current;
    if (box !== null) box.scrollTop = box.scrollHeight;
  }, [log]);
  if (meta === void 0 || meta === null) return null;
  const readOnly = meta.managerUrl === void 0 || meta.protocolVersion !== HANDOFF_PROTOCOL_VERSION;
  const tag = state?.connecting === true ? "connecting" : state?.state.tag ?? "idle";
  const dotColor = STATE_COLORS[tag] ?? "#9ca3af";
  const label = t(STATE_LABEL_KEYS[tag] ?? "stateIdle");
  const intent = (hash) => {
    if (meta.managerUrl === void 0 || state === null) return;
    window.location.href = `${meta.managerUrl}/#${hash}=${encodeURIComponent(state.sessionId)}`;
  };
  const buttonStyle = {
    background: "transparent",
    color: "inherit",
    border: "1px solid rgba(127,127,127,0.5)",
    borderRadius: 6,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 12,
    width: "100%",
    textAlign: "left"
  };
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    setMenuPos(rect === void 0 ? { left: 8, bottom: 56 } : {
      left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 372)),
      bottom: Math.max(8, window.innerHeight - rect.top)
    });
    setOpen(true);
  };
  return /* @__PURE__ */ React.createElement(React.Fragment, null, open && menuPos !== null ? /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        position: "fixed",
        left: menuPos.left,
        bottom: menuPos.bottom,
        width: 360,
        maxHeight: "70vh",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 12,
        background: "rgba(30,30,30,0.92)",
        color: "#e5e5e5",
        border: "1px solid rgba(127,127,127,0.4)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        zIndex: 1300,
        fontFamily: "inherit"
      }
    },
    /* @__PURE__ */ React.createElement("strong", { style: { fontSize: 13 } }, t("menuTitle")),
    unreachable ? /* @__PURE__ */ React.createElement("span", { style: { fontSize: 12, color: "#f59e0b" } }, t("managerUnreachable")) : null,
    meta.protocolVersion !== HANDOFF_PROTOCOL_VERSION ? /* @__PURE__ */ React.createElement("span", { style: { fontSize: 12, color: "#f59e0b" } }, t("versionMismatch")) : null,
    meta.managerUrl === void 0 ? /* @__PURE__ */ React.createElement("span", { style: { fontSize: 12, opacity: 0.75 } }, t("managerMissing")) : null,
    state !== null ? /* @__PURE__ */ React.createElement("span", { style: { fontSize: 12, opacity: 0.85 } }, state.hostAlias, " \xB7 ", label, state.localPort !== void 0 ? ` \xB7 127.0.0.1:${state.localPort}` : "") : null,
    /* @__PURE__ */ React.createElement("strong", { style: { fontSize: 12 } }, t("log")),
    /* @__PURE__ */ React.createElement(
      "div",
      {
        ref: logBoxRef,
        style: {
          height: 160,
          overflowY: "auto",
          whiteSpace: "pre-wrap",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 11,
          lineHeight: 1.5,
          padding: "4px 6px",
          border: "1px solid rgba(127,127,127,0.35)",
          borderRadius: 6
        }
      },
      log.length === 0 ? /* @__PURE__ */ React.createElement("span", { style: { opacity: 0.55 } }, t("logEmpty")) : log.map((entry) => /* @__PURE__ */ React.createElement("div", { key: entry.seq }, /* @__PURE__ */ React.createElement("span", { style: { opacity: 0.55 } }, entry.ts.slice(11, 19)), " ", /* @__PURE__ */ React.createElement("span", { style: entry.kind === "error" ? { color: "#ef4444" } : void 0 }, entry.text)))
    ),
    readOnly ? null : /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        style: buttonStyle,
        onClick: () => {
          window.open(meta.managerUrl, "_blank", "noopener");
        }
      },
      t("managerOpen")
    ), /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        style: buttonStyle,
        onClick: () => {
          intent("handoff-disconnect");
        }
      },
      t("managerClose")
    ), /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        style: buttonStyle,
        onClick: () => {
          intent("handoff-stop");
        }
      },
      t("managerStop")
    ))
  ) : null, /* @__PURE__ */ React.createElement(
    "button",
    {
      ref: buttonRef,
      type: "button",
      title: t("pill"),
      onClick: toggle,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        padding: wide ? "6px 10px" : "6px 0",
        justifyContent: wide ? "flex-start" : "center",
        background: "transparent",
        color: "inherit",
        border: "none",
        cursor: "pointer",
        fontSize: 12,
        fontFamily: "inherit"
      }
    },
    /* @__PURE__ */ React.createElement(
      "span",
      {
        style: {
          width: 8,
          height: 8,
          borderRadius: "50%",
          flexShrink: 0,
          backgroundColor: dotColor,
          display: "inline-block"
        }
      }
    ),
    wide ? /* @__PURE__ */ React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, state?.hostAlias ?? "\u2026") : null
  ));
}
return module.exports; } });

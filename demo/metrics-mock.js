// Fake metrics source for the <anycable-metrics> demo.
// Emits messages in the same shape as the AnyCable server.
// Metrics: etc/grafana/dashboards/anycable.json in anycable-go.

const INTERVAL = 5; // seconds
const HISTORY = 60 * 60; // seconds

const gauge = (desc) => ({ kind: "gauge", desc });
const counter = (desc) => ({ kind: "counter", desc });

const META = {
  // Clients
  clients_num: gauge("The number of active clients"),
  clients_uniq_num: gauge(
    "The number of unique clients (with respect to connection identifiers)"
  ),
  broadcast_streams_num: gauge("The number of active broadcasting streams"),
  disconnect_queue_size: gauge("The size of delayed disconnect"),
  // Messages
  client_msg_total: counter("The total number of received messages from clients"),
  failed_client_msg_total: counter(
    "The total number of unrecognized messages received from clients"
  ),
  server_msg_total: counter("The total number of messages sent to clients"),
  failed_server_msg_total: counter(
    "The total number of messages failed to send to clients"
  ),
  timeout_server_msg_total: counter(
    "The total number of messages failed to send to clients due to write timeouts"
  ),
  data_sent_total: counter("The total amount of bytes sent to clients"),
  data_rcvd_total: counter("The total amount of bytes received from clients"),
  // Publications & broadcasts
  publications_total: counter(
    "The total number of publications received (from the application)"
  ),
  failed_broadcast_msg_total: counter(
    "The total number of unrecognized publications received from the application"
  ),
  broadcast_msg_total: counter(
    "The total number of messages received through PubSub (for broadcast)"
  ),
  remote_commands_total: counter(
    "The total number of remote commands received through PubSub"
  ),
  // RPC
  rpc_call_total: counter("The total number of RPC calls"),
  rpc_retries_total: counter("The total number of RPC call retries"),
  rpc_error_total: counter("The total number of failed RPC calls"),
  rpc_timeout_total: counter("The total number of RPC call that timed out"),
  rpc_canceled_total: counter("The total number of canceled RPC calls"),
  rpc_pending_num: gauge("The number of pending RPC calls"),
  rpc_capacity_num: gauge("The max number of concurrent RPC calls allowed"),
  grpc_active_conn_num: gauge(
    "The number of active HTTP connections used by gRPC"
  ),
  // Errors & auth
  failed_auths_total: counter(
    "The total number of failed authentication attempts"
  ),
  disconnected_slow_clients_total: counter(
    "The total number of disconnected slow clients"
  ),
  // Memory & runtime
  mem_sys_bytes: gauge("The total bytes of memory obtained from the OS"),
  heap_sys_bytes: gauge("The total bytes of heap memory obtained from the OS"),
  stack_sys_bytes: gauge("The total bytes of stack memory obtained from the OS"),
  heap_alloc_total: gauge("The number of allocated heap objects"),
  heap_idle_bytes: gauge("The total bytes of idle heap memory"),
  heap_released_bytes: gauge("The total bytes of heap memory released"),
  goroutines_num: gauge("The number of Go routines"),
};

const rnd = (amp) => (Math.random() - 0.5) * 2 * amp;
const chance = (p, n = 1) => (Math.random() < p ? Math.ceil(Math.random() * n) : 0);
const round = Math.round;

let clients = 1200;
const totals = {};

function sample(tsMs) {
  const wave = Math.sin(tsMs / 600_000);
  clients = Math.max(50, round(clients + rnd(20) + wave * 6));

  const received = round(clients * 0.4 * (1 + rnd(0.3)));
  const publications = round(70 + rnd(25) + chance(0.03) * 350);
  const broadcasts = publications + chance(0.2, 5);
  const sent = broadcasts * 12 + received;
  const rpcCalls = round(received * 0.6 + clients * 0.02 + rnd(10));

  const deltas = {
    client_msg_total: received,
    failed_client_msg_total: chance(0.05, 3),
    server_msg_total: sent,
    failed_server_msg_total: chance(0.08, 6),
    timeout_server_msg_total: chance(0.04, 3),
    data_sent_total: round(sent * (420 + rnd(60))),
    data_rcvd_total: round(received * (180 + rnd(40))),
    publications_total: publications,
    failed_broadcast_msg_total: chance(0.02),
    broadcast_msg_total: broadcasts,
    remote_commands_total: chance(0.06, 4),
    rpc_call_total: rpcCalls,
    rpc_retries_total: chance(0.1, 8),
    rpc_error_total: chance(0.08, 5),
    rpc_timeout_total: chance(0.03, 3),
    rpc_canceled_total: chance(0.02, 2),
    failed_auths_total: chance(0.1, 4),
    disconnected_slow_clients_total: chance(0.03, 2),
  };

  for (const name in deltas) totals[name] = (totals[name] || 0) + deltas[name];

  const heapSys = round(90e6 + clients * 38e3 + rnd(3e6));

  return {
    ts: Math.floor(tsMs / 1000),
    values: {
      ...totals,
      clients_num: clients,
      clients_uniq_num: round(clients * (0.72 + rnd(0.02))),
      broadcast_streams_num: round(clients * 0.28 + rnd(5)),
      disconnect_queue_size: Math.max(0, round(rnd(4) + chance(0.05, 30))),
      rpc_pending_num: Math.max(0, round(rpcCalls / 60 + rnd(3))),
      rpc_capacity_num: 28,
      grpc_active_conn_num: 4 + chance(0.2),
      mem_sys_bytes: round(heapSys * 1.35 + rnd(2e6)),
      heap_sys_bytes: heapSys,
      stack_sys_bytes: round(clients * 2 * 8e3 + 4e6),
      heap_alloc_total: round(heapSys * 0.6 + rnd(6e6)),
      heap_idle_bytes: round(heapSys * 0.35 + rnd(4e6)),
      heap_released_bytes: round(heapSys * 0.2 + rnd(3e6)),
      goroutines_num: round(clients * 2 + 200 + rnd(40)),
    },
    deltas,
  };
}

await customElements.whenDefined("anycable-metrics");

for (const el of document.querySelectorAll("anycable-metrics")) {
  const stepMs = INTERVAL * 1000;
  const now = Math.floor(Date.now() / stepMs) * stepMs;

  const points = [];
  for (let ts = now - HISTORY * 1000; ts <= now; ts += stepMs) {
    // Simulate a 2-minute outage 40 minutes ago (rendered as a gap)
    const ago = now - ts;
    if (ago < 40 * 60_000 && ago > 38 * 60_000) continue;
    points.push(sample(ts));
  }

  const snapshot = (pts) => ({
    type: "snapshot",
    interval: INTERVAL,
    meta: META,
    points: pts,
  });

  // Pretend we're connecting
  setTimeout(() => {
    el.status = "connected";
    el.ingest(snapshot(points));
    // The last snapshot point can also arrive as a broadcast: must be dropped
    el.ingest({ type: "point", point: points[points.length - 1] });
  }, 500);

  let next = now + stepMs;
  setInterval(() => {
    el.ingest({ type: "point", point: sample(next) });
    next += stepMs;
  }, stepMs);

  // Re-send part of the history (as after a reconnect): duplicates must be dropped
  setTimeout(() => el.ingest(snapshot(points.slice(-24))), 10_000);
}

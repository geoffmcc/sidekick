"use strict";
const assert = require("assert"),
  fs = require("fs"),
  path = require("path");
const root = path.join(__dirname, ".."),
  pack = path.join(root, "packs", "jellyfin");
const profiles = require(
  path.join(pack, "modules/jellyfin-tools/lib/profiles"),
);
const normalize = require(
  path.join(pack, "modules/jellyfin-tools/lib/normalize"),
);
const storageLib = require(
  path.join(pack, "modules/jellyfin-tools/lib/storage"),
);
const logsLib = require(path.join(pack, "modules/jellyfin-tools/lib/logs"));
let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`Passed: ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAILED: ${name}\n${e.stack}`);
  }
}
test("all Jellyfin JSON assets parse", () => {
  for (const f of fs
    .readdirSync(pack, { recursive: true })
    .filter((x) => x.endsWith(".json")))
    JSON.parse(fs.readFileSync(path.join(pack, f), "utf8"));
});
test("pack and module versions agree at 1.1.0", () => {
  const packManifest = JSON.parse(
    fs.readFileSync(path.join(pack, "sidekick.pack.json"), "utf8"),
  );
  const moduleManifest = JSON.parse(
    fs.readFileSync(
      path.join(pack, "modules/jellyfin-tools/manifest.json"),
      "utf8",
    ),
  );
  assert.strictEqual(packManifest.version, "1.1.1");
  assert.strictEqual(moduleManifest.version, "1.1.1");
  // Every services.dispatch target used by the module must be declared.
  const declared = moduleManifest.permissions.map((x) => x.tool).sort();
  assert.deepStrictEqual(declared, ["proxmox", "status", "web_fetch"]);
  // The dead allow_destructive knob is gone from the pack schema.
  assert.ok(!packManifest.configuration.schema.properties.allow_destructive);
});
test("zero and default profiles", () => {
  assert.deepStrictEqual(profiles.list({}), []);
  const x = profiles.resolve({
    profiles: {
      home: {
        endpoint: "https://jellyfin.example.internal",
        api_key_ref: "secret:jf-home",
        default: true,
      },
    },
  });
  assert.strictEqual(x.name, "home");
  assert.strictEqual(x.storage_provider, null);
  assert.strictEqual(x.verify_poll_interval_ms, 2000);
});
test("ambiguous profile is explicit", () =>
  assert.throws(
    () =>
      profiles.resolve({
        profiles: {
          a: { endpoint: "https://a.invalid", api_key_ref: "secret:a" },
          b: { endpoint: "https://b.invalid", api_key_ref: "secret:b" },
        },
      }),
    (e) => e.code === "profile_ambiguous",
  ));
test("unsafe endpoint forms are rejected", () => {
  for (const endpoint of [
    "http://public.example",
    "https://u:p@example",
    "https://example/x?token=bad",
    "https://example/x#frag",
  ])
    assert.throws(() =>
      profiles.resolve({
        allow_insecure_http: false,
        profiles: { x: { endpoint, api_key_ref: "secret:x" } },
      }),
    );
});
test("explicit HTTP opt-in and no credential leakage", () => {
  const x = profiles.resolve({
    allow_insecure_http: true,
    profiles: {
      x: {
        endpoint: "http://127.0.0.1:8096",
        api_key_ref: "secret:x",
        allow_insecure_http: true,
      },
    },
  });
  assert.strictEqual(x.endpoint.protocol, "http:");
  assert.throws(() =>
    profiles.resolve({
      profiles: {
        x: { endpoint: "https://example", api_key_ref: "raw-token" },
      },
    }),
  );
});
test("storage_provider config parses and fails closed on bad shapes", () => {
  const good = profiles.parse("x", {
    endpoint: "https://jf.example.internal",
    api_key_ref: "secret:x",
    storage_provider: { type: "proxmox", profile: "pve", node: "n1", storage: "tank", vmid: 120 },
    verify_poll_interval_ms: 50,
  });
  assert.strictEqual(good.storage_provider.type, "proxmox");
  assert.strictEqual(good.storage_provider.vmid, 120);
  assert.strictEqual(good.storage_provider.min_free_bytes, 1024 * 1024 * 1024);
  assert.strictEqual(good.storage_provider.max_used_percent, 95);
  assert.strictEqual(good.verify_poll_interval_ms, 50);
  const local = profiles.parse("x", {
    endpoint: "https://jf.example.internal",
    api_key_ref: "secret:x",
    storage_provider: { type: "local" },
  });
  assert.strictEqual(local.storage_provider.type, "local");
  // A half-configured provider must throw, not degrade to "no provider".
  for (const bad of [
    { type: "proxmox" },
    { type: "proxmox", profile: "p", node: "n" },
    { type: "nfs" },
    "local",
    { type: "proxmox", profile: "p", node: "n", storage: "s", vmid: 5 },
  ])
    assert.throws(
      () =>
        profiles.parse("x", {
          endpoint: "https://jf.example.internal",
          api_key_ref: "secret:x",
          storage_provider: bad,
        }),
      (e) => e.code === "invalid_input",
    );
});
test("playback diagnosis is deterministic and evidence separated", () => {
  const d = normalize.diagnose({
    Id: "s",
    PlayMethod: "Transcode",
    NowPlayingItem: {
      Id: "i",
      Name: "Synthetic",
      MediaStreams: [
        { Type: "Video", Codec: "hevc" },
        { Type: "Audio", Codec: "aac" },
      ],
    },
    TranscodingInfo: {
      TranscodeReasons: ["SubtitleCodecNotSupported"],
      HardwareAccelerationType: "none",
    },
  });
  assert.strictEqual(d.classification, "subtitle_burn_in");
  assert.ok(d.observed.length);
  assert.ok(d.conclusion.includes("Subtitle"));
  assert.ok(Array.isArray(d.unknowns));
});
test("direct play and missing evidence degrade honestly", () => {
  assert.strictEqual(
    normalize.diagnose({ PlayMethod: "DirectPlay" }).classification,
    "direct_play",
  );
  assert.strictEqual(
    normalize.diagnose({}).classification,
    "insufficient_evidence",
  );
});
test("capabilities are optional and normalized", () => {
  const c = normalize.capabilities({
    system: { ProductName: "Jellyfin" },
    sessions: [],
    libraries: [],
    tasks: [],
    plugins: [],
    liveTv: null,
    metrics: null,
  });
  assert.strictEqual(c.live_tv, false);
  assert.strictEqual(c.metrics, false);
  assert.strictEqual(c.events, false);
});
test("log tail summarization counts levels, dedupes signatures and redacts", () => {
  const text = [
    "[2026-08-14 10:00:00.000 +00:00] [INF] [1] Main: Started",
    "[2026-08-14 10:00:01.000 +00:00] [ERR] [5] MediaBrowser.X: Database is locked token=supersecret123",
    "[2026-08-14 10:00:02.000 +00:00] [ERR] [5] MediaBrowser.X: Database is locked token=supersecret123",
    "   at Stack.Trace()",
    "[2026-08-14 10:00:03.000 +00:00] [WRN] [9] Foo: careful",
  ].join("\n");
  const s = logsLib.summarizeTail(text);
  assert.strictEqual(s.level_counts.ERR, 2);
  assert.strictEqual(s.level_counts.WRN, 1);
  assert.strictEqual(s.level_counts.INF, 1);
  assert.strictEqual(s.top_errors.length, 1);
  assert.strictEqual(s.top_errors[0].count, 2);
  assert.ok(!JSON.stringify(s).includes("supersecret123"));
  assert.strictEqual(s.continuation_or_unparsed_lines, 1);
  assert.ok(s.time_range.first && s.time_range.last);
});
test("log file selection only accepts names the server listed", () => {
  const files = [
    { Name: "old.log", DateModified: "2026-01-01T00:00:00Z" },
    { Name: "new.log", DateModified: "2026-08-01T00:00:00Z" },
  ];
  assert.strictEqual(logsLib.pickLogFile(files).Name, "new.log");
  assert.strictEqual(logsLib.pickLogFile(files, "old.log").Name, "old.log");
  assert.throws(
    () => logsLib.pickLogFile(files, "../../../etc/passwd"),
    (e) => e.code === "not_found",
  );
});
test("humanToBytes parses df -h units approximately", () => {
  assert.strictEqual(storageLib.humanToBytes("1K"), 1024);
  assert.strictEqual(storageLib.humanToBytes("50G"), 50 * 2 ** 30);
  assert.strictEqual(storageLib.humanToBytes("garbage"), null);
});

// ---------------------------------------------------------------------------
// Entry-level coverage against canned fixtures: lib/client and lib/profiles
// are stubbed through the require cache BEFORE entry.js loads, so no test
// below performs network I/O or secret resolution.
// ---------------------------------------------------------------------------
const clientPath = require.resolve(
  path.join(pack, "modules/jellyfin-tools/lib/client"),
);
const profilesPath = require.resolve(
  path.join(pack, "modules/jellyfin-tools/lib/profiles"),
);
const realClient = require(clientPath);

let fixtures = {};
let postLog = [];
let delLog = [];
let activityQueries = [];
const captured = { createClientCalls: [] };
function setFixtures(next) {
  fixtures = next;
  postLog = [];
  delLog = [];
  activityQueries = [];
}
function fakeCreateClient(profile, key, signal, ca) {
  captured.createClientCalls.push({ profile: profile.name, key, ca });
  return {
    get: async (p, q) => {
      const fx = fixtures[p];
      if (fx === undefined) {
        const e = new Error(`fixture missing: ${p}`);
        e.code = "not_found";
        throw e;
      }
      if (typeof fx === "function") return fx(q);
      if (fx instanceof Error) throw fx;
      return JSON.parse(JSON.stringify(fx));
    },
    post: async (p, b) => {
      postLog.push({ path: p, body: b });
      return {};
    },
    del: async (p) => {
      delLog.push(p);
      return {};
    },
    getTail: async (p, q, bytes) => {
      const fx = fixtures[`TAIL ${p}`];
      if (fx === undefined)
        return { ok: false, reason: "log_too_large_without_range_support", total_size: null, status: 200 };
      return typeof fx === "function" ? fx(q, bytes) : fx;
    },
    origin: "http://stub",
  };
}
function stubModule(resolved, exports) {
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
}
stubModule(clientPath, {
  createClient: fakeCreateClient,
  scrub: realClient.scrub,
  MAX_RESPONSE_BYTES: realClient.MAX_RESPONSE_BYTES,
});
stubModule(profilesPath, {
  parse: profiles.parse,
  list: profiles.list,
  resolve: profiles.resolve,
  // Deterministic credential resolution: no secret store in tests. The CA is
  // what the TLS-threading regression asserts on.
  credential: (profile) => ({
    key: "test-key",
    ca: profile.ca_pem || (profile.ca_secret_ref ? "RESOLVED_CA_PEM" : null),
  }),
});
const entry = require(path.join(pack, "modules/jellyfin-tools/entry.js"));

const NOW = Date.now();
const RECENT = new Date(NOW - 3600 * 1000).toISOString();
function baseFixtures() {
  return {
    "/System/Info": {
      Version: "10.10.7",
      Id: "srv1",
      ServerName: "Test",
      ProductName: "Jellyfin Server",
      OperatingSystem: "Linux",
      HasPendingRestart: false,
      ProgramDataPath: "/config",
      LogPath: "/config/log",
      CachePath: "/cache",
      InternalMetadataPath: "/config/metadata",
      TranscodingTempPath: "/cache/transcodes",
    },
    "/Library/VirtualFolders": [
      {
        Name: "Movies",
        ItemId: "lib1",
        CollectionType: "movies",
        Locations: ["/media/movies"],
        RefreshStatus: "Idle",
        RefreshProgress: 0,
      },
      { Name: "Empty", ItemId: "lib2", Locations: [] },
    ],
    "/Items/Counts": { MovieCount: 10, ItemCount: 42 },
    "/ScheduledTasks": [
      {
        Id: "t1",
        Name: "Scan Media Library",
        Key: "RefreshLibrary",
        State: "Idle",
        LastExecutionResult: {
          Status: "Completed",
          StartTimeUtc: RECENT,
          EndTimeUtc: RECENT,
        },
      },
      {
        Id: "t2",
        Name: "Chapter Images",
        Key: "RefreshChapterImages",
        State: "Idle",
        LastExecutionResult: {
          Status: "Failed",
          StartTimeUtc: RECENT,
          EndTimeUtc: RECENT,
          ErrorMessage: "boom",
        },
      },
    ],
    "/Sessions": [
      {
        Id: "s1",
        UserName: "geoff",
        DeviceName: "tv",
        NowPlayingItem: {
          Id: "i1",
          Name: "Film",
          MediaStreams: [{ Type: "Video", Codec: "hevc" }],
        },
        PlayState: { PlayMethod: "Transcode" },
        TranscodingInfo: { TranscodeReasons: ["ContainerBitrateExceedsLimit"] },
      },
    ],
    "/Users": [
      {
        Id: "u1",
        Name: "admin",
        HasPassword: true,
        LastActivityDate: RECENT,
        LastLoginDate: RECENT,
        Policy: {
          IsAdministrator: true,
          IsDisabled: false,
          EnableRemoteAccess: true,
          EnableAllFolders: true,
          EnabledFolders: [],
        },
      },
      {
        Id: "u2",
        Name: "kid",
        HasPassword: false,
        LastActivityDate: null,
        Policy: {
          IsAdministrator: false,
          IsDisabled: true,
          EnableRemoteAccess: false,
          EnableAllFolders: false,
          EnabledFolders: ["lib1"],
        },
      },
    ],
    "/Devices": { Items: [{ Id: "d1", Name: "TV", AppName: "Jellyfin Web" }] },
    "/Plugins": [
      { Id: "p1", Name: "Trakt", Version: "1.0.0", Status: "Active", CanUninstall: true },
    ],
    "/System/ActivityLog/Entries": (q) => {
      activityQueries.push(q || {});
      return {
      Items: [
        {
          Id: 1,
          Name: "login",
          Type: "AuthenticationSucceeded",
          Severity: "Information",
          Date: RECENT,
          ShortOverview: "ok",
        },
      ],
      TotalRecordCount: 5,
      StartIndex: q?.StartIndex ?? 0,
      };
    },
    "/LiveTv/Info": { IsEnabled: false, Services: [], EnabledUsers: [] },
    "/System/Logs": [
      { Name: "log_20260814.log", Size: 5000, DateModified: RECENT },
    ],
    "TAIL /System/Logs/Log": {
      ok: true,
      method: "range",
      status: 206,
      total_size: 5000,
      text: [
        "[2026-08-14 10:00:00.000 +00:00] [INF] [1] Main: Started",
        "[2026-08-14 10:00:01.000 +00:00] [ERR] [5] X.Y: Database is locked api_key=verysecretvalue",
      ].join("\n"),
    },
    "/Items": (q) => {
      if (q?.SearchTerm !== undefined)
        return { Items: [{ Id: "i1", Name: "Film", Type: "Movie" }], TotalRecordCount: 1 };
      return {
        Items: [
          {
            Id: "m1",
            Name: "Alpha",
            Type: "Movie",
            ProductionYear: 2020,
            Overview: "",
            ImageTags: {},
            DateCreated: RECENT,
            Path: "/media/movies/alpha.mkv",
          },
          {
            Id: "m2",
            Name: "Alpha",
            Type: "Movie",
            ProductionYear: 2020,
            Overview: "fine",
            ImageTags: { Primary: "tag" },
            DateCreated: RECENT,
            Path: "/media/movies/alpha-2.mkv",
          },
        ],
        TotalRecordCount: 2,
      };
    },
    "/Items/i1": {
      Id: "i1",
      Name: "Film",
      Type: "Movie",
      Path: "/media/movies/film.mkv",
      MediaSources: [],
      MediaStreams: [],
    },
  };
}
// entry get() uses template /Items/${id}; fixture key must match exactly.
function servicesFor({ profileExtra = {}, config = {}, dispatch } = {}) {
  return {
    config: {
      allow_insecure_http: true,
      profiles: {
        home: {
          endpoint: "http://127.0.0.1:8096",
          api_key_ref: "secret:jf",
          allow_insecure_http: true,
          default: true,
          verify_poll_interval_ms: 50,
          ...profileExtra,
        },
      },
      ...config,
    },
    dispatch:
      dispatch ||
      (async () => ({ content: [{ type: "text", text: "denied" }], isError: true, code: "module_permission_denied" })),
  };
}
function tools(services) {
  const built = entry.buildDescriptors(services);
  return {
    read: built.find((d) => d.name === "jellyfin"),
    maint: built.find((d) => d.name === "jellyfin_maintenance"),
  };
}
async function call(descriptor, args) {
  const out = await descriptor.handler(args, {});
  return { out, parsed: JSON.parse(out.content[0].text) };
}

const asyncFailures = [];
async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`Passed: ${name}`);
  } catch (e) {
    asyncFailures.push(name);
    console.error(`FAILED: ${name}\n${e.stack}`);
  }
}
(async () => {
  await asyncTest(
    "handlers receive the module services facade (profiles resolve from config)",
    async () => {
      const { read } = tools(servicesFor());
      const { parsed } = await call(read, { action: "list_profiles" });
      assert.strictEqual(parsed.profiles[0].name, "home");
    },
  );
  await asyncTest(
    "unconfigured module lists zero profiles instead of throwing",
    async () => {
      const { read } = tools({ config: {} });
      const { parsed } = await call(read, { action: "list_profiles" });
      assert.deepStrictEqual(parsed.profiles, []);
    },
  );
  await asyncTest(
    "every declared read action returns structured output, none falls through to unknown-action",
    async () => {
      const { read } = tools(servicesFor());
      const actions = read.schema.shape.action.options;
      assert.ok(actions.length >= 38, "expected the full declared action list");
      const extra = {
        item_details: { item_id: "i1" },
        task_status: { task_id: "t1" },
        user_status: { user_id: "u1" },
        plugin_status: { plugin_id: "p1" },
      };
      for (const action of actions) {
        setFixtures(baseFixtures());
        const { out, parsed } = await call(read, { action, ...(extra[action] || {}) });
        assert.ok(!out.isError, `${action} returned an error: ${out.content[0].text.slice(0, 200)}`);
        assert.ok(
          !JSON.stringify(parsed).includes("unknown action"),
          `${action} fell through to the unknown-action branch`,
        );
      }
    },
  );
  await asyncTest(
    "TLS regression: resolved ca_secret_ref CA is threaded into createClient",
    async () => {
      setFixtures(baseFixtures());
      const { read } = tools(
        servicesFor({
          profileExtra: {
            endpoint: "https://jf.example.internal",
            ca_secret_ref: "secret:jf-ca",
          },
        }),
      );
      // https profile: drop the http opt-in noise by overriding endpoint only.
      const { out } = await call(read, { action: "version" });
      assert.ok(!out.isError);
      const last = captured.createClientCalls[captured.createClientCalls.length - 1];
      assert.strictEqual(last.ca, "RESOLVED_CA_PEM");
    },
  );
  await asyncTest(
    "maintenance_plan recommends from LastExecutionResult, not State",
    async () => {
      setFixtures(baseFixtures());
      fixtures["/ScheduledTasks"].push({
        Id: "t3",
        Name: "Running Task",
        Key: "X",
        State: "Running",
        CurrentProgressPercentage: 40,
        LastExecutionResult: { Status: "Completed", StartTimeUtc: RECENT, EndTimeUtc: RECENT },
      });
      const { read } = tools(servicesFor());
      const { parsed } = await call(read, { action: "maintenance_plan" });
      const failed = parsed.recommendations.filter((r) => r.kind === "failed_task");
      assert.strictEqual(failed.length, 1);
      assert.strictEqual(failed[0].task_id, "t2");
      assert.strictEqual(failed[0].last_status, "Failed");
      assert.strictEqual(parsed.currently_running.length, 1);
      assert.strictEqual(parsed.currently_running[0].task_id, "t3");
      // The old bug filtered on State === "Failed" (a value State never has).
      assert.ok(parsed.basis.includes("LastExecutionResult"));
    },
  );
  await asyncTest("storage_preflight: proxmox provider derives safety from evidence", async () => {
    setFixtures(baseFixtures());
    const calls = [];
    const services = servicesFor({
      profileExtra: {
        storage_provider: { type: "proxmox", profile: "pve", node: "n1", storage: "tank" },
      },
      dispatch: async (name, args) => {
        calls.push({ name, args });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                active: true,
                enabled: true,
                total_bytes: 100 * 2 ** 30,
                avail_bytes: 50 * 2 ** 30,
                used_fraction_pct: 50,
              }),
            },
          ],
        };
      },
    });
    const { read } = tools(services);
    const { parsed } = await call(read, { action: "storage_preflight" });
    assert.strictEqual(parsed.state, "ok");
    assert.strictEqual(parsed.safe_for_library_state_mutation, true);
    assert.strictEqual(parsed.provider, "proxmox");
    assert.strictEqual(calls[0].name, "proxmox");
    assert.strictEqual(calls[0].args.action, "storage_status");
    assert.ok(parsed.evidence.avail_bytes > 0);
    assert.ok(parsed.paths_checked.includes("/media/movies"));
  });
  await asyncTest("storage_preflight: proxmox low space is unsafe, provider error not_verifiable", async () => {
    setFixtures(baseFixtures());
    const low = servicesFor({
      profileExtra: { storage_provider: { type: "proxmox", profile: "pve", node: "n1", storage: "tank" } },
      dispatch: async () => ({
        content: [{ type: "text", text: JSON.stringify({ ok: true, active: true, avail_bytes: 100, used_fraction_pct: 99 }) }],
      }),
    });
    let { parsed } = await call(tools(low).read, { action: "storage_preflight" });
    assert.strictEqual(parsed.state, "unsafe");
    assert.strictEqual(parsed.safe_for_library_state_mutation, false);
    assert.ok(parsed.reasons.includes("low_free_space"));
    assert.ok(parsed.reasons.includes("high_utilization"));
    const broken = servicesFor({
      profileExtra: { storage_provider: { type: "proxmox", profile: "pve", node: "n1", storage: "tank" } },
      dispatch: async () => ({ content: [{ type: "text", text: "boom" }], isError: true }),
    });
    ({ parsed } = await call(tools(broken).read, { action: "storage_preflight" }));
    assert.strictEqual(parsed.state, "not_verifiable");
    assert.strictEqual(parsed.reason, "storage_provider_error");
    assert.strictEqual(parsed.safe_for_library_state_mutation, false);
  });
  await asyncTest("storage_preflight: local provider uses the status tool's disk evidence", async () => {
    setFixtures(baseFixtures());
    const services = servicesFor({
      profileExtra: { storage_provider: { type: "local" } },
      dispatch: async (name, args) => {
        assert.strictEqual(name, "status");
        assert.strictEqual(args.include, "disk");
        return {
          content: [
            { type: "text", text: JSON.stringify({ disk: { mount: "/", size: "100G", used: "40G", avail: "50G", pct: "40%" } }) },
          ],
        };
      },
    });
    const { parsed } = await call(tools(services).read, { action: "storage_preflight" });
    assert.strictEqual(parsed.state, "ok");
    assert.strictEqual(parsed.provider, "local");
    assert.strictEqual(parsed.evidence.granularity, "host_root_filesystem_only");
  });
  await asyncTest("storage_preflight: no provider is not_verifiable, never bare unknown", async () => {
    setFixtures(baseFixtures());
    const { parsed } = await call(tools(servicesFor()).read, { action: "storage_preflight" });
    assert.strictEqual(parsed.state, "not_verifiable");
    assert.strictEqual(parsed.reason, "no_storage_provider_configured");
    assert.ok(parsed.required_capability.includes("storage_provider"));
    assert.strictEqual(parsed.safe_for_library_state_mutation, false);
  });
  await asyncTest("storage_preflight: require_safe fails the call on non-ok state", async () => {
    setFixtures(baseFixtures());
    const { out } = await call(tools(servicesFor()).read, {
      action: "storage_preflight",
      require_safe: true,
    });
    assert.ok(out.isError);
    assert.strictEqual(out.code, "unsafe_storage_state");
  });
  const okProxmoxDispatch = async (name) => {
    if (name === "proxmox")
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, active: true, enabled: true, avail_bytes: 50 * 2 ** 30, used_fraction_pct: 50 }) },
        ],
      };
    return { content: [{ type: "text", text: "denied" }], isError: true };
  };
  await asyncTest("scan_library guard matrix: writes disabled fails closed", async () => {
    setFixtures(baseFixtures());
    const { maint } = tools(servicesFor());
    const { out } = await call(maint, { action: "scan_library", library_id: "lib1" });
    assert.ok(out.isError);
    assert.strictEqual(out.code, "policy_denied");
  });
  await asyncTest("scan_library guard matrix: protected library is a hard deny", async () => {
    setFixtures(baseFixtures());
    const services = servicesFor({
      profileExtra: { allow_writes: true, storage_provider: { type: "proxmox", profile: "pve", node: "n1", storage: "tank" } },
      config: { protected_resources: [{ kind: "library", name: "Movies" }] },
      dispatch: okProxmoxDispatch,
    });
    const { maint } = tools(services);
    let { out } = await call(maint, { action: "scan_library", library_id: "lib1" });
    assert.ok(out.isError);
    assert.strictEqual(out.code, "policy_denied");
    // A full scan touches every library: any protected library denies it.
    ({ out } = await call(maint, { action: "scan_library", all_libraries: true }));
    assert.ok(out.isError);
    assert.strictEqual(out.code, "policy_denied");
    assert.strictEqual(postLog.length, 0);
  });
  await asyncTest("scan_library guard matrix: unsafe/unverifiable storage blocks execution", async () => {
    setFixtures(baseFixtures());
    const services = servicesFor({ profileExtra: { allow_writes: true } });
    const { maint } = tools(services);
    const { out } = await call(maint, { action: "scan_library", library_id: "lib1" });
    assert.ok(out.isError);
    assert.strictEqual(out.code, "unsafe_storage_state");
    assert.strictEqual(postLog.length, 0);
  });
  await asyncTest("scan_library guard matrix: missing target and conflicting args are invalid_input", async () => {
    setFixtures(baseFixtures());
    const services = servicesFor({ profileExtra: { allow_writes: true }, dispatch: okProxmoxDispatch });
    const { maint } = tools(services);
    let { out } = await call(maint, { action: "scan_library" });
    assert.ok(out.isError);
    assert.strictEqual(out.code, "invalid_input");
    ({ out } = await call(maint, { action: "scan_library", library_id: "lib1", all_libraries: true }));
    assert.ok(out.isError);
    assert.strictEqual(out.code, "invalid_input");
    ({ out } = await call(maint, { action: "scan_library", library_id: "nope" }));
    assert.ok(out.isError);
    assert.strictEqual(out.code, "not_found");
  });
  await asyncTest("scan_library dry_run runs validation and the real preflight, no mutation", async () => {
    setFixtures(baseFixtures());
    const services = servicesFor({
      profileExtra: { allow_writes: true, storage_provider: { type: "proxmox", profile: "pve", node: "n1", storage: "tank" } },
      dispatch: okProxmoxDispatch,
    });
    const { maint } = tools(services);
    const { out, parsed } = await call(maint, { action: "scan_library", library_id: "lib1", dry_run: true });
    assert.ok(!out.isError);
    assert.strictEqual(parsed.dry_run, true);
    assert.strictEqual(parsed.would_execute, true);
    assert.strictEqual(parsed.target.library_id, "lib1");
    assert.strictEqual(parsed.endpoint, "POST /Items/lib1/Refresh");
    assert.strictEqual(parsed.storage_preflight.state, "ok");
    assert.strictEqual(postLog.length, 0);
    // Dry run against unverifiable storage reports blocked, does not throw.
    setFixtures(baseFixtures());
    const noProvider = tools(servicesFor({ profileExtra: { allow_writes: true } })).maint;
    const blocked = await call(noProvider, { action: "scan_library", library_id: "lib1", dry_run: true });
    assert.ok(!blocked.out.isError);
    assert.strictEqual(blocked.parsed.would_execute, false);
    assert.ok(blocked.parsed.blocked_reason.includes("not_verifiable"));
  });
  await asyncTest("scan_library happy path posts the refresh and observes the running scan", async () => {
    setFixtures(baseFixtures());
    // After the refresh request, the scheduled-task poll sees RefreshLibrary running.
    let taskCalls = 0;
    const base = baseFixtures();
    fixtures["/ScheduledTasks"] = () => {
      taskCalls += 1;
      const tasks = JSON.parse(JSON.stringify(base["/ScheduledTasks"]));
      if (postLog.length) tasks[0].State = "Running";
      return tasks;
    };
    const services = servicesFor({
      profileExtra: { allow_writes: true, storage_provider: { type: "proxmox", profile: "pve", node: "n1", storage: "tank" } },
      dispatch: okProxmoxDispatch,
    });
    const { maint } = tools(services);
    const { out, parsed } = await call(maint, { action: "scan_library", library_id: "lib1" });
    assert.ok(!out.isError);
    assert.strictEqual(postLog.length, 1);
    assert.strictEqual(postLog[0].path, "/Items/lib1/Refresh");
    assert.strictEqual(parsed.outcome, "running");
    assert.strictEqual(parsed.changes_made, true);
    assert.ok(parsed.outcome_semantics.includes("accepted"));
    assert.ok(taskCalls >= 2, "postcondition must actually poll");
  });
  await asyncTest("run_task observes the Idle→Running transition and reports honestly", async () => {
    setFixtures(baseFixtures());
    const base = baseFixtures();
    fixtures["/ScheduledTasks"] = () => {
      const tasks = JSON.parse(JSON.stringify(base["/ScheduledTasks"]));
      if (postLog.length) tasks[1].State = "Running";
      return tasks;
    };
    const { maint } = tools(servicesFor({ profileExtra: { allow_writes: true } }));
    const { out, parsed } = await call(maint, { action: "run_task", task_id: "t2" });
    assert.ok(!out.isError);
    assert.strictEqual(parsed.outcome, "verified");
    assert.deepStrictEqual(
      {
        before: parsed.postcondition.state_before,
        after: parsed.postcondition.state_after,
        observed: parsed.postcondition.transition_observed,
      },
      { before: "Idle", after: "Running", observed: true },
    );
    assert.strictEqual(postLog[0].path, "/ScheduledTasks/Running/t2");
  });
  await asyncTest("run_task without an observed transition is only request_accepted", async () => {
    setFixtures(baseFixtures());
    const { maint } = tools(servicesFor({ profileExtra: { allow_writes: true } }));
    const { out, parsed } = await call(maint, { action: "run_task", task_id: "t2" });
    assert.ok(!out.isError);
    assert.strictEqual(parsed.outcome, "request_accepted");
    assert.strictEqual(parsed.postcondition.transition_observed, false);
    assert.strictEqual(parsed.postcondition.polls, 3);
  });
  await asyncTest("cancel_task transitions and nothing_to_cancel stays honest", async () => {
    setFixtures(baseFixtures());
    const base = baseFixtures();
    fixtures["/ScheduledTasks"] = () => {
      const tasks = JSON.parse(JSON.stringify(base["/ScheduledTasks"]));
      tasks[1].State = delLog.length ? "Idle" : "Running";
      return tasks;
    };
    const { maint } = tools(servicesFor({ profileExtra: { allow_writes: true } }));
    let { parsed } = await call(maint, { action: "cancel_task", task_id: "t2" });
    assert.strictEqual(parsed.outcome, "verified");
    assert.strictEqual(parsed.postcondition.state_before, "Running");
    assert.strictEqual(delLog[0], "/ScheduledTasks/Running/t2");
    setFixtures(baseFixtures());
    ({ parsed } = await call(maint, { action: "cancel_task", task_id: "t1" }));
    assert.strictEqual(parsed.outcome, "nothing_to_cancel");
    assert.strictEqual(delLog.length, 0);
  });
  await asyncTest("dry_run validates required args first and maps expected_effect per action", async () => {
    setFixtures(baseFixtures());
    const { maint } = tools(servicesFor({ profileExtra: { allow_writes: true } }));
    const missing = await call(maint, { action: "run_task", dry_run: true });
    assert.ok(missing.out.isError);
    assert.strictEqual(missing.out.code, "invalid_input");
    const run = await call(maint, { action: "run_task", task_id: "t1", dry_run: true });
    assert.ok(run.parsed.expected_effect.includes("start scheduled task"));
    const cancel = await call(maint, { action: "cancel_task", task_id: "t1", dry_run: true });
    assert.ok(cancel.parsed.expected_effect.includes("cancellation"));
    assert.ok(!cancel.parsed.expected_effect.includes("library refresh"));
    assert.strictEqual(cancel.parsed.would_execute, false); // t1 is Idle
  });
  await asyncTest("activity handles the {Items, TotalRecordCount} shape with start_index", async () => {
    setFixtures(baseFixtures());
    const { read } = tools(servicesFor());
    const { parsed } = await call(read, { action: "activity", start_index: 3, limit: 10 });
    assert.strictEqual(parsed.total_record_count, 5);
    assert.strictEqual(parsed.start_index, 3);
    assert.strictEqual(parsed.items.length, 1);
    assert.strictEqual(parsed.items[0].severity, "Information");
  });
  await asyncTest("activity forwards user filters without silently widening scope", async () => {
    setFixtures(baseFixtures());
    const { read } = tools(servicesFor());
    const byId = await call(read, { action: "activity", user_id: "u2", limit: 10 });
    assert.strictEqual(byId.out.isError, undefined);
    assert.strictEqual(activityQueries[0].UserId, "u2");

    const byName = await call(read, { action: "activity", username: "ADMIN", limit: 10 });
    assert.strictEqual(byName.out.isError, undefined);
    assert.strictEqual(activityQueries[1].UserId, "u1");
  });
  await asyncTest("logs_summary returns bounded redacted intelligence, never raw content", async () => {
    setFixtures(baseFixtures());
    const { read } = tools(servicesFor());
    const { out, parsed } = await call(read, { action: "logs_summary" });
    assert.ok(!out.isError);
    assert.strictEqual(parsed.available, true);
    assert.strictEqual(parsed.log_file.name, "log_20260814.log");
    assert.strictEqual(parsed.retrieval.tail_only, true);
    assert.strictEqual(parsed.level_counts.ERR, 1);
    assert.ok(!out.content[0].text.includes("verysecretvalue"));
    // Tail unavailable degrades honestly.
    setFixtures({ ...baseFixtures(), "TAIL /System/Logs/Log": { ok: false, reason: "log_too_large_without_range_support", total_size: 10 ** 9 } });
    const big = await call(read, { action: "logs_summary" });
    assert.strictEqual(big.parsed.available, false);
    assert.ok(big.parsed.unknowns[0].includes("log_too_large_without_range_support"));
  });
  await asyncTest("incident_diagnose classifies from evidence and lists real sources", async () => {
    setFixtures(baseFixtures());
    const { read } = tools(servicesFor());
    const { parsed } = await call(read, { action: "incident_diagnose" });
    assert.ok(["errors_present", "recurring_error"].includes(parsed.classification));
    assert.ok(Array.isArray(parsed.observed) && parsed.observed.length);
    assert.ok(parsed.evidence_sources.includes("/System/Logs/Log (bounded tail)"));
    assert.ok(parsed.raw_output_withheld);
  });
  await asyncTest("metrics_summary derives from real sources and names them", async () => {
    setFixtures(baseFixtures());
    const { read } = tools(servicesFor());
    const { parsed } = await call(read, { action: "metrics_summary" });
    assert.deepStrictEqual(parsed.sources_used, ["/Sessions", "/Items/Counts", "/ScheduledTasks"]);
    assert.strictEqual(parsed.sessions.connected, 1);
    assert.strictEqual(parsed.sessions.transcoding, 1);
    assert.strictEqual(parsed.tasks.recent_failures[0].task_id, "t2");
    assert.ok(parsed.note.includes("no metrics endpoint"));
  });
  await asyncTest("upgrade_readiness derives status and blockers from evidence", async () => {
    setFixtures(baseFixtures());
    const services = servicesFor({
      dispatch: async (name) =>
        name === "web_fetch"
          ? { content: [{ type: "text", text: `Status: 200\n\n${JSON.stringify({ tag_name: "v10.10.7" })}` }] }
          : { content: [{ type: "text", text: "denied" }], isError: true },
    });
    const { read } = tools(services);
    const { parsed } = await call(read, { action: "upgrade_readiness" });
    assert.strictEqual(parsed.status, "blocked");
    assert.ok(parsed.blocked_by.some((b) => b.reason === "active_sessions"));
    assert.strictEqual(parsed.latest_stable, "10.10.7");
    assert.ok(parsed.warnings.some((w) => w.reason === "storage_not_verifiable"));
    // Release lookup failure degrades to unknown, never invents a version.
    setFixtures({ ...baseFixtures(), "/Sessions": [] });
    const offline = await call(tools(servicesFor()).read, { action: "upgrade_readiness" });
    assert.strictEqual(offline.parsed.latest_stable, "unknown");
    assert.notStrictEqual(offline.parsed.status, "ready");
  });
  await asyncTest("backup_readiness uses proxmox vzdump evidence when vmid is configured", async () => {
    setFixtures(baseFixtures());
    const services = servicesFor({
      profileExtra: {
        storage_provider: { type: "proxmox", profile: "pve", node: "n1", storage: "tank", vmid: 120 },
      },
      dispatch: async (name, args) => {
        if (name === "proxmox" && args.action === "storage_status")
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, active: true, avail_bytes: 50 * 2 ** 30, used_fraction_pct: 50 }) }] };
        if (name === "proxmox" && args.action === "backup_status")
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  jobs: { total: 1, list: [{ id: "backup-1", selection: "120", storage: "pbs" }] },
                  recent_backups: {
                    total: 1,
                    failures: 0,
                    most_recent: [{ upid: "UPID:n1:0001:vzdump:120:", id: "120", ok: true, end_time: Math.floor(NOW / 1000) }],
                  },
                }),
              },
            ],
          };
        return { content: [{ type: "text", text: "denied" }], isError: true };
      },
    });
    const { parsed } = await call(tools(services).read, { action: "backup_readiness" });
    assert.strictEqual(parsed.status, "ready");
    assert.strictEqual(parsed.evidence.provider_backup.jobs_covering_guest, 1);
    assert.ok(parsed.evidence.provider_backup.last_success);
    // Without any evidence source the status is not_verifiable with reasons.
    setFixtures(baseFixtures());
    const bare = await call(tools(servicesFor()).read, { action: "backup_readiness" });
    assert.strictEqual(bare.parsed.status, "not_verifiable");
    assert.ok(bare.parsed.reasons.includes("no_backup_evidence_source_configured"));
  });
  await asyncTest("playback_diagnose names the chosen session and refuses ambiguity", async () => {
    setFixtures(baseFixtures());
    const { read } = tools(servicesFor());
    let { parsed } = await call(read, { action: "playback_diagnose" });
    assert.strictEqual(parsed.profile, "home");
    assert.deepStrictEqual(parsed.session_chosen, { id: "s1", reason: "only_session_with_active_playback" });
    setFixtures(baseFixtures());
    fixtures["/Sessions"] = [
      fixtures["/Sessions"] && baseFixtures()["/Sessions"][0],
      { ...baseFixtures()["/Sessions"][0], Id: "s2", UserName: "other" },
    ];
    ({ parsed } = await call(read, { action: "playback_diagnose" }));
    assert.strictEqual(parsed.classification, "ambiguous_sessions");
    assert.strictEqual(parsed.candidates.length, 2);
    assert.ok(parsed.recommended_next_check.includes("session_id"));
  });
  await asyncTest("user_status and user_access_audit surface policy evidence", async () => {
    setFixtures(baseFixtures());
    const { read } = tools(servicesFor());
    const missing = await call(read, { action: "user_status" });
    assert.ok(missing.out.isError);
    assert.strictEqual(missing.out.code, "invalid_input");
    const byName = await call(read, { action: "user_status", username: "ADMIN" });
    assert.strictEqual(byName.parsed.user.id, "u1");
    assert.strictEqual(byName.parsed.user.policy.is_administrator, true);
    const audit = await call(read, { action: "user_access_audit" });
    assert.strictEqual(audit.parsed.summary.administrators, 1);
    assert.strictEqual(audit.parsed.summary.disabled_accounts, 1);
    assert.ok(audit.parsed.findings.some((f) => f.finding === "access_to_all_folders" && f.user_id === "u1"));
    assert.ok(audit.parsed.findings.some((f) => f.finding === "restricted_folder_access" && f.user_id === "u2"));
    assert.ok(audit.parsed.findings.some((f) => f.finding === "no_recorded_activity" && f.user_id === "u2"));
  });
  await asyncTest("plugin_status returns one plugin's detail; live TV honest when disabled", async () => {
    setFixtures(baseFixtures());
    const { read } = tools(servicesFor());
    const plugin = await call(read, { action: "plugin_status", plugin_id: "p1" });
    assert.strictEqual(plugin.parsed.plugin.name, "Trakt");
    assert.strictEqual(plugin.parsed.plugin.can_uninstall, true);
    const missing = await call(read, { action: "plugin_status" });
    assert.strictEqual(missing.out.code, "invalid_input");
    const tuners = await call(read, { action: "tuner_status" });
    assert.strictEqual(tuners.parsed.available, false);
    assert.strictEqual(tuners.parsed.reason, "live_tv_disabled");
    setFixtures({
      ...baseFixtures(),
      "/LiveTv/Info": { IsEnabled: true, Services: [{ Name: "svc", Status: "Ok", Tuners: ["hdhr-1"] }] },
      "/LiveTv/Recordings": { Items: [{ Id: "r1", Name: "News", ChannelName: "C1" }], TotalRecordCount: 1 },
    });
    const withTv = await call(read, { action: "tuner_status" });
    assert.deepStrictEqual(withTv.parsed.services[0].tuners, ["hdhr-1"]);
    assert.ok(withTv.parsed.note.includes("no dedicated tuner-listing endpoint"));
    const rec = await call(read, { action: "recording_status" });
    assert.strictEqual(rec.parsed.total_record_count, 1);
    assert.strictEqual(rec.parsed.recordings[0].channel, "C1");
  });
  await asyncTest("authentication failures surface instead of degrading to unavailable", async () => {
    setFixtures(baseFixtures());
    const authError = new Error("Jellyfin rejected the configured API credential");
    authError.code = "authentication_failed";
    fixtures["/LiveTv/Info"] = authError;
    const { read } = tools(servicesFor());
    const { out } = await call(read, { action: "capabilities" });
    assert.ok(out.isError);
    assert.strictEqual(out.code, "authentication_failed");
  });
  await asyncTest("new library intelligence actions return evidence-based structures", async () => {
    setFixtures(baseFixtures());
    const { read } = tools(servicesFor());
    const status = await call(read, { action: "library_status" });
    assert.strictEqual(status.parsed.libraries.length, 2);
    assert.strictEqual(status.parsed.item_counts.MovieCount, 10);
    assert.strictEqual(status.parsed.library_scan_task.id, "t1");
    const health = await call(read, { action: "library_health" });
    assert.strictEqual(health.parsed.state, "attention");
    assert.ok(health.parsed.findings.some((f) => f.finding === "no_locations" && f.id === "lib2"));
    assert.ok(health.parsed.not_verified[0].includes("filesystem_accessibility"));
    const recent = await call(read, { action: "recent_media", limit: 5 });
    assert.strictEqual(recent.parsed.total_record_count, 2);
    assert.ok(recent.parsed.source.includes("SortBy=DateCreated"));
    const meta = await call(read, { action: "metadata_issues" });
    assert.strictEqual(meta.parsed.bounded_sample, true);
    assert.ok(meta.parsed.issues.some((i) => i.id === "m1" && i.missing.includes("overview")));
    const dupes = await call(read, { action: "duplicate_candidates" });
    assert.strictEqual(dupes.parsed.candidates.length, 1);
    assert.strictEqual(dupes.parsed.candidates[0].items.length, 2);
    assert.ok(dupes.parsed.note.includes("not confirmed duplicates"));
  });
  await asyncTest("real client maps 400/429 and serves a true Range tail (loopback)", async () => {
    const http = require("http");
    const tailPayload = "X".repeat(3000) + "\nTHE-REAL-TAIL";
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://localhost");
      if (u.pathname === "/bad") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Message: "bad request shape" }));
      } else if (u.pathname === "/throttle") {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end("{}");
      } else if (u.pathname === "/System/Logs/Log") {
        const range = req.headers.range;
        const m = /^bytes=-(\d+)$/.exec(range || "");
        if (m) {
          const n = Math.min(Number(m[1]), tailPayload.length);
          const start = tailPayload.length - n;
          res.writeHead(206, {
            "Content-Type": "text/plain",
            "Content-Range": `bytes ${start}-${tailPayload.length - 1}/${tailPayload.length}`,
          });
          res.end(tailPayload.slice(start));
        } else {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(tailPayload);
        }
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const profile = profiles.parse(
        "loop",
        { endpoint: `http://127.0.0.1:${port}`, api_key_ref: "secret:x", allow_insecure_http: true },
        { allow_insecure_http: true },
      );
      const client = realClient.createClient(profile, "k", undefined, null);
      await assert.rejects(() => client.get("/bad"), (e) => e.code === "invalid_input" && e.message.includes("bad request shape"));
      await assert.rejects(() => client.get("/throttle"), (e) => e.code === "rate_limited");
      // getTail floors the bound at 1024 bytes; the payload is larger, so a
      // true partial tail (not the whole file) must come back via 206.
      const tail = await client.getTail("/System/Logs/Log", { name: "x" }, 1024);
      assert.strictEqual(tail.ok, true);
      assert.strictEqual(tail.method, "range");
      assert.strictEqual(tail.total_size, tailPayload.length);
      assert.ok(tail.text.endsWith("THE-REAL-TAIL"));
      assert.strictEqual(tail.text.length, 1024);
    } finally {
      server.close();
    }
  });
  if (failures || asyncFailures.length) {
    process.exitCode = 1;
  } else console.log("All Jellyfin pack tests passed.");
})();

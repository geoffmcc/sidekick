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
if (failures) {
  process.exitCode = 1;
} else console.log("All Jellyfin pack tests passed.");

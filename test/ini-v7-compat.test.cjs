const assert = require("assert");
const { sidekick_parse } = require("../src/tools/families/data-utilities");
const INI = require("ini");

(async () => {
  const parsed = await sidekick_parse({
    format: "ini",
    input: "[database]\nhost=localhost\nports[]=6379\nports[]=6380\n[database.credentials]\nuser=sidekick\n"
  });
  assert.ok(!parsed.isError);
  assert.deepStrictEqual(JSON.parse(parsed.content[0].text), {
    database: { host: "localhost", ports: ["6379", "6380"], credentials: { user: "sidekick" } }
  });

  const polluted = INI.parse("__proto__[polluted]=true\nconstructor[unsafe]=true\n");
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual({}.unsafe, undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(polluted, "__proto__"), false);

  const roundTrip = INI.stringify({ database: { host: "localhost", tags: ["one", "two"] } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(INI.parse(roundTrip))), { database: { host: "localhost", tags: ["one", "two"] } });
  console.log("INI v7 compatibility: nested sections, arrays, prototype safety, and serialization passed");
})().catch(error => {
  console.error(error);
  process.exit(1);
});

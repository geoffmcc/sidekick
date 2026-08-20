const assert = require("assert");

process.env.NODE_ENV = "test";

const { getBuiltinRegistry } = require("../src/tools");

async function main() {
  const descriptors = getBuiltinRegistry().listInDefinitionOrder();
  const annotationKeys = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  assert.ok(descriptors.length > 0, "expected builtin descriptors");
  for (const descriptor of descriptors) {
    assert.deepStrictEqual(Object.keys(descriptor.annotations).sort(), annotationKeys.slice().sort());
    for (const key of annotationKeys) {
      assert.strictEqual(typeof descriptor.annotations[key], "boolean", `${descriptor.name}.${key} must be boolean`);
    }
  }

  console.log(`MCP annotations: ${descriptors.length} canonical tools verified`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

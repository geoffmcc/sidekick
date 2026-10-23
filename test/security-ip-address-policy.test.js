"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { embeddedIPv4Address, isLinkLocal, isMetadataAddress, isPrivateAddress } = require("../src/security/ip-address-policy");
const { validateOutboundUrl } = require("../src/security/outbound-url");
const { validateEndpoint } = require("../src/compute/endpoint-guard");

test("private IPv4 cannot be laundered through NAT64, IPv4-compatible, or 6to4 addresses", () => {
  for (const address of [
    "64:ff9b::7f00:1",
    "::7f00:1",
    "2002:0a00:0001::",
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} must classify according to its embedded IPv4 address`);
  }
  assert.equal(embeddedIPv4Address("64:ff9b::7f00:1"), "127.0.0.1");
  assert.equal(embeddedIPv4Address("2002:c0a8:0101::"), "192.168.1.1");
});

test("translated metadata and link-local addresses remain blocked", () => {
  for (const address of ["64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::"]) {
    assert.equal(isLinkLocal(address), true, `${address} must inherit IPv4 link-local classification`);
    assert.equal(isMetadataAddress(address), true, `${address} must inherit IPv4 metadata classification`);
    assert.match(validateOutboundUrl(`http://[${address}]/`), /metadata|link-local/i);
    assert.match(validateEndpoint(`http://[${address}]/`), /metadata|link-local/i);
  }
});

test("public IPv4 translated by the well-known NAT64 prefix remains public", () => {
  assert.equal(embeddedIPv4Address("64:ff9b::5db8:d822"), "93.184.216.34");
  assert.equal(isPrivateAddress("64:ff9b::5db8:d822"), false);
  assert.equal(validateOutboundUrl("http://[64:ff9b::5db8:d822]/"), null);
});

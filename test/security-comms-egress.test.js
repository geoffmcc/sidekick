"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const dns = require("node:dns");
const {
  descriptors,
  validateEmailHeaders,
  resolveSmtpDestination,
  MAX_NOTIFICATION_REQUEST_BYTES,
} = require("../src/tools/families/comms");

test("email recipient and subject cannot inject additional headers", () => {
  assert.equal(validateEmailHeaders("person@example.test", "Weekly report"), null);
  assert.match(validateEmailHeaders("person@example.test\r\nBcc: attacker@example.test", "Weekly report"), /recipient/);
  assert.match(validateEmailHeaders("person@example.test", "Report\nBcc: attacker@example.test"), /subject/);
});

test("SMTP destination pins DNS while allowing operator-configured private relays", async t => {
  const originalLookup = dns.promises.lookup;
  let answers = [{ address: "203.0.113.10", family: 4 }];
  dns.promises.lookup = async () => answers;
  t.after(() => { dns.promises.lookup = originalLookup; });

  const publicRelay = await resolveSmtpDestination("smtp.example.test", "587");
  assert.equal(publicRelay.address, "203.0.113.10");
  assert.equal(publicRelay.url.hostname, "smtp.example.test");
  assert.equal(publicRelay.url.port, "587");

  answers = [{ address: "192.168.1.20", family: 4 }];
  const privateRelay = await resolveSmtpDestination("mail.internal", 465);
  assert.equal(privateRelay.address, "192.168.1.20");

  answers = [{ address: "169.254.169.254", family: 4 }];
  const metadata = await resolveSmtpDestination("smtp.example.test", 587);
  assert.match(metadata.refusal, /metadata|link-local/i);
});

test("SMTP configuration rejects ambiguous hosts and ports", async () => {
  assert.equal((await resolveSmtpDestination("https://user:pass@example.test/path", 587)).code, "invalid_smtp_configuration");
  assert.equal((await resolveSmtpDestination("smtp.example.test", "587junk")).code, "invalid_smtp_configuration");
});

test("notification schema bounds message size", () => {
  const descriptor = descriptors.find(item => item.name === "notify");
  const parsed = descriptor.schema.safeParse({ channel: "email", recipient: "person@example.test", message: "x".repeat(MAX_NOTIFICATION_REQUEST_BYTES + 1) });
  assert.equal(parsed.success, false);
});

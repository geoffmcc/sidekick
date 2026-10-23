"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const github = require("../src/tools/families/github");

test("GitHub response reader retains bodies within the configured byte bound", async () => {
  const response = new EventEmitter();
  const pending = github.readGithubResponseText(response, 16);
  response.emit("data", Buffer.from("bounded"));
  response.emit("end");
  assert.equal(await pending, "bounded");
});

test("GitHub response reader drops accumulated content after the byte bound is exceeded", async () => {
  const response = new EventEmitter();
  const pending = github.readGithubResponseText(response, 5);
  response.emit("data", Buffer.from("012345"));
  response.emit("data", Buffer.from("still discarded"));
  response.emit("end");
  assert.equal(await pending, null);
});

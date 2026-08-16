const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { formatDuration } = require("./support.js");

describe("test helpers", () => {
  test("formats durations below one second as milliseconds", () => {
    assert.equal(formatDuration(0), "0ms");
    assert.equal(formatDuration(13.651), "14ms");
    assert.equal(formatDuration(151.18), "151ms");
    assert.equal(formatDuration(999), "999ms");
  });

  test("formats durations of at least one second as seconds", () => {
    assert.equal(formatDuration(1_000), "1.0s");
    assert.equal(formatDuration(1_100), "1.1s");
    assert.equal(formatDuration(3_240), "3.2s");
  });

  test("rejects invalid durations", () => {
    assert.throws(() => formatDuration(-1), TypeError);
    assert.throws(() => formatDuration(Number.NaN), TypeError);
    assert.throws(() => formatDuration(Number.POSITIVE_INFINITY), TypeError);
  });
});

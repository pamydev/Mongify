const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  matchesQuery,
  normalizeQueryCount,
  projectDocument,
} = require("../dist/query.js");

describe("Mongify query operators", () => {
  test("matches numeric $lt, $lte, $gt and $gte comparisons", () => {
    const document = { score: 10 };

    assert.equal(matchesQuery(document, { score: { $lt: 11 } }), true);
    assert.equal(matchesQuery(document, { score: { $lt: 10 } }), false);
    assert.equal(matchesQuery(document, { score: { $lte: 10 } }), true);
    assert.equal(matchesQuery(document, { score: { $gt: 9 } }), true);
    assert.equal(matchesQuery(document, { score: { $gt: 10 } }), false);
    assert.equal(matchesQuery(document, { score: { $gte: 10 } }), true);
    assert.equal(
      matchesQuery(document, { score: { $gte: 5, $lt: 20 } }),
      true,
    );
  });

  test("matches Date $lt, $lte, $gt and $gte comparisons", () => {
    const date = new Date("2026-06-01T00:00:00.000Z");
    const document = { date };

    assert.equal(
      matchesQuery(document, {
        date: { $gt: new Date("2026-01-01T00:00:00.000Z") },
      }),
      true,
    );
    assert.equal(matchesQuery(document, { date: { $gte: new Date(date) } }), true);
    assert.equal(matchesQuery(document, { date: { $lte: new Date(date) } }), true);
    assert.equal(
      matchesQuery(document, {
        date: { $lt: new Date("2026-01-01T00:00:00.000Z") },
      }),
      false,
    );
  });

  test("does not compare incompatible types", () => {
    assert.equal(matchesQuery({ score: "10" }, { score: { $gt: 5 } }), false);
    assert.equal(
      matchesQuery({ date: new Date() }, { date: { $gt: 5 } }),
      false,
    );
  });

  test("matches scalar and array fields with $in", () => {
    assert.equal(matchesQuery({ role: "admin" }, { role: { $in: ["admin", "owner"] } }), true);
    assert.equal(matchesQuery({ role: "user" }, { role: { $in: ["admin", "owner"] } }), false);
    assert.equal(matchesQuery({ tags: ["typescript", "node"] }, { tags: { $in: ["node"] } }), true);
    assert.equal(matchesQuery({ tags: ["typescript"] }, { tags: { $in: ["node"] } }), false);
  });

  test("matches scalar and array fields with $nin", () => {
    assert.equal(matchesQuery({ role: "user" }, { role: { $nin: ["admin"] } }), true);
    assert.equal(matchesQuery({ role: "admin" }, { role: { $nin: ["admin"] } }), false);
    assert.equal(matchesQuery({ tags: ["typescript", "node"] }, { tags: { $nin: ["php"] } }), true);
    assert.equal(matchesQuery({ tags: ["typescript", "node"] }, { tags: { $nin: ["node"] } }), false);
  });

  test("requires arrays for $in and $nin", () => {
    assert.throws(() => matchesQuery({ role: "admin" }, { role: { $in: "admin" } }), /\$in requires an array/);
    assert.throws(() => matchesQuery({ role: "admin" }, { role: { $nin: "admin" } }), /\$nin requires an array/);
  });

  test("combines queries with $and", () => {
    const document = { age: 37, active: true };
    assert.equal(matchesQuery(document, { $and: [{ age: { $gte: 18 } }, { active: true }] }), true);
    assert.equal(matchesQuery(document, { $and: [{ age: { $gte: 18 } }, { active: false }] }), false);
  });

  test("combines queries with $or", () => {
    const document = { role: "user", active: true };
    assert.equal(matchesQuery(document, { $or: [{ role: "admin" }, { active: true }] }), true);
    assert.equal(matchesQuery(document, { $or: [{ role: "admin" }, { active: false }] }), false);
  });

  test("negates top-level and field expressions with $not", () => {
    const document = { age: 37, active: true };
    assert.equal(matchesQuery(document, { $not: { active: false } }), true);
    assert.equal(matchesQuery(document, { age: { $not: { $lt: 18 } } }), true);
    assert.equal(matchesQuery(document, { age: { $not: { $gte: 18 } } }), false);
  });

  test("validates logical operator operands", () => {
    assert.throws(() => matchesQuery({}, { $and: {} }), /\$and requires an array/);
    assert.throws(() => matchesQuery({}, { $or: "invalid" }), /\$or requires an array/);
    assert.throws(() => matchesQuery({}, { $not: [] }), /\$not requires a query object/);
  });

  test("matches field presence with $exists", () => {
    assert.equal(matchesQuery({ name: "Pamela" }, { name: { $exists: true } }), true);
    assert.equal(matchesQuery({ name: "Pamela" }, { email: { $exists: false } }), true);
    assert.equal(matchesQuery({ email: undefined }, { email: { $exists: true } }), true);
    assert.equal(matchesQuery({}, { email: { $exists: true } }), false);
  });

  test("matches JavaScript value types with $type", () => {
    assert.equal(matchesQuery({ value: 10 }, { value: { $type: "number" } }), true);
    assert.equal(matchesQuery({ value: new Date() }, { value: { $type: "date" } }), true);
    assert.equal(matchesQuery({ value: [] }, { value: { $type: "array" } }), true);
    assert.equal(matchesQuery({ value: null }, { value: { $type: "null" } }), true);
    assert.equal(matchesQuery({}, { value: { $type: "undefined" } }), true);
    assert.equal(matchesQuery({ value: "text" }, { value: { $type: ["string", "number"] } }), true);
  });

  test("validates $exists and $type operands", () => {
    assert.throws(() => matchesQuery({}, { value: { $exists: "yes" } }), /\$exists requires a boolean/);
    assert.throws(() => matchesQuery({}, { value: { $type: 1 } }), /\$type requires a type name/);
  });

  test("matches strings and string arrays with $regex", () => {
    assert.equal(matchesQuery({ name: "Pamela Sedrez" }, { name: { $regex: "^Pamela" } }), true);
    assert.equal(matchesQuery({ name: "pamela" }, { name: { $regex: "^PAMELA$", $options: "i" } }), true);
    assert.equal(matchesQuery({ name: "Alice" }, { name: { $regex: /pamela/i } }), false);
    assert.equal(matchesQuery({ tags: ["typescript", "nodejs"] }, { tags: { $regex: /node/ } }), true);
  });

  test("validates $regex and $options operands", () => {
    assert.throws(() => matchesQuery({ name: "Pamela" }, { name: { $regex: 10 } }), /\$regex requires a string or RegExp/);
    assert.throws(() => matchesQuery({ name: "Pamela" }, { name: { $options: "i" } }), /\$options requires \$regex/);
    assert.throws(() => matchesQuery({ name: "Pamela" }, { name: { $regex: "pamela", $options: 1 } }), /\$options requires a string/);
  });

  test("queries fields inside nested documents", () => {
    const document = {
      name: "Pamela",
      profile: {
        location: { country: "Brazil", city: "São Paulo" },
        active: true,
      },
    };

    assert.equal(matchesQuery(document, { profile: { active: true } }), true);
    assert.equal(matchesQuery(document, { profile: { active: false } }), false);
    assert.equal(
      matchesQuery(document, {
        profile: { location: { country: "Brazil" } },
      }),
      true,
    );
  });

  test("applies operators inside nested documents and document arrays", () => {
    const document = {
      profile: { age: 37 },
      addresses: [{ city: "Florianópolis" }, { city: "São Paulo" }],
    };
    assert.equal(matchesQuery(document, { profile: { age: { $gte: 18 } } }), true);
    assert.equal(matchesQuery(document, { addresses: { city: "São Paulo" } }), true);
    assert.equal(matchesQuery(document, { addresses: { city: "Curitiba" } }), false);
  });

  test("projects included fields and includes _id by default", () => {
    const document = { _id: "1", name: "Pamela", email: "pamela@example.com" };
    assert.deepEqual(projectDocument(document, { name: 1 }), {
      _id: "1",
      name: "Pamela",
    });
    assert.deepEqual(projectDocument(document, { name: true, _id: 0 }), {
      name: "Pamela",
    });
    assert.deepEqual(projectDocument(document, { _id: 1 }), { _id: "1" });
  });

  test("projects excluded fields without mutating the document", () => {
    const document = { _id: "1", name: "Pamela", password: "secret" };
    assert.deepEqual(projectDocument(document, { password: 0 }), {
      _id: "1",
      name: "Pamela",
    });
    assert.equal(document.password, "secret");
  });

  test("validates projection definitions", () => {
    assert.throws(() => projectDocument({}, { name: 1, email: 0 }), /cannot mix/);
    assert.throws(() => projectDocument({}, { name: 2 }), /Invalid projection value/);
  });

  test("normalizes limit values", () => {
    assert.equal(normalizeQueryCount(undefined, "limit"), undefined);
    assert.equal(normalizeQueryCount(0, "limit"), 0);
    assert.equal(normalizeQueryCount("10", "limit"), 10);
    assert.throws(() => normalizeQueryCount(-1, "limit"), /limit must be a non-negative integer/);
    assert.throws(() => normalizeQueryCount("2.5", "limit"), /limit must be a non-negative integer/);
    assert.throws(() => normalizeQueryCount("invalid", "limit"), /limit must be a non-negative integer/);
  });

  test("normalizes skip values", () => {
    assert.equal(normalizeQueryCount(undefined, "skip"), undefined);
    assert.equal(normalizeQueryCount(0, "skip"), 0);
    assert.equal(normalizeQueryCount("3", "skip"), 3);
    assert.throws(() => normalizeQueryCount(-1, "skip"), /skip must be a non-negative integer/);
    assert.throws(() => normalizeQueryCount("1.5", "skip"), /skip must be a non-negative integer/);
  });
});

import type { MongifyDocument, MongifyQuery } from "./types";

const comparison_operators = new Set(["$lt", "$lte", "$gt", "$gte"]);

export interface SimpleRangeQuery {
  field: string;
  lower?: { value: number | string | Date; inclusive: boolean };
  upper?: { value: number | string | Date; inclusive: boolean };
}

export function matchesQuery(
  document: MongifyDocument,
  query?: MongifyQuery,
): boolean {
  if (!query || Object.keys(query).length === 0) {
    return true;
  }

  return Object.entries(query).every(([field, condition]) => {
    if (field === "$and" || field === "$or") {
      if (!Array.isArray(condition)) {
        throw new TypeError(`${field} requires an array of queries`);
      }
      const results = condition.map((nested) => {
        validateNestedQuery(field, nested);
        return matchesQuery(document, nested);
      });
      return field === "$and" ? results.every(Boolean) : results.some(Boolean);
    }
    if (field === "$not") {
      validateNestedQuery(field, condition);
      return !matchesQuery(document, condition);
    }
    if (field.startsWith("$")) {
      throw new TypeError(`Unsupported query operator: ${field}`);
    }
    return matchesCondition(
      document[field],
      condition,
      Object.prototype.hasOwnProperty.call(document, field),
    );
  });
}

export function isSimpleEqualityQuery(
  query?: MongifyQuery,
): query is MongifyQuery {
  if (!query || Object.keys(query).length !== 1) {
    return false;
  }
  const value = query[Object.keys(query)[0]];
  return !isOperatorExpression(value) && !isNestedObject(value);
}

export function getSimpleEqualityQuery(
  query?: MongifyQuery,
): Record<string, any> | undefined {
  if (!query || Object.keys(query).length === 0) return undefined;
  if (
    Object.entries(query).some(
      ([field, value]) =>
        field.startsWith("$") ||
        isOperatorExpression(value) ||
        isNestedObject(value),
    )
  ) {
    return undefined;
  }
  return query;
}

export function getSimpleRangeQuery(
  query?: MongifyQuery,
): SimpleRangeQuery | undefined {
  if (!query || Object.keys(query).length !== 1) return undefined;
  const field = Object.keys(query)[0];
  const condition = query[field];
  if (!isOperatorExpression(condition)) return undefined;
  const operators = Object.keys(condition);
  if (
    operators.length === 0 ||
    !operators.every((operator) => comparison_operators.has(operator)) ||
    operators.filter((operator) => operator === "$gt" || operator === "$gte")
      .length > 1 ||
    operators.filter((operator) => operator === "$lt" || operator === "$lte")
      .length > 1
  ) {
    return undefined;
  }

  const values = Object.values(condition);
  if (!values.every(isRangeValue)) return undefined;
  if (new Set(values.map(rangeValueType)).size !== 1) return undefined;

  const result: SimpleRangeQuery = { field };
  if ("$gt" in condition) {
    result.lower = { value: condition.$gt, inclusive: false };
  } else if ("$gte" in condition) {
    result.lower = { value: condition.$gte, inclusive: true };
  }
  if ("$lt" in condition) {
    result.upper = { value: condition.$lt, inclusive: false };
  } else if ("$lte" in condition) {
    result.upper = { value: condition.$lte, inclusive: true };
  }
  return result;
}

export function projectDocument(
  document: MongifyDocument,
  projection?: Record<string, 0 | 1 | boolean>,
): MongifyDocument {
  if (projection === undefined) return document;
  if (projection === null || Array.isArray(projection) || typeof projection !== "object") {
    throw new TypeError("Projection must be an object");
  }

  const entries = Object.entries(projection);
  for (const [field, value] of entries) {
    if (!(value === 0 || value === 1 || typeof value === "boolean")) {
      throw new TypeError(`Invalid projection value for field: ${field}`);
    }
  }
  const regular = entries.filter(([field]) => field !== "_id");
  const includes =
    regular.some(([, value]) => Boolean(value)) ||
    (regular.length === 0 && (projection._id === 1 || projection._id === true));
  const excludes = regular.some(([, value]) => !Boolean(value));
  if (includes && excludes) {
    throw new TypeError("Projection cannot mix included and excluded fields");
  }

  if (includes) {
    const result: MongifyDocument = {};
    for (const [field, value] of regular) {
      if (value && Object.prototype.hasOwnProperty.call(document, field)) {
        result[field] = document[field];
      }
    }
    if (projection._id !== 0 && projection._id !== false && document._id !== undefined) {
      result._id = document._id;
    }
    return result;
  }

  const result = { ...document };
  for (const [field, value] of entries) {
    if (!value) delete result[field];
  }
  return result;
}

export function normalizeQueryCount(
  value: string | number | undefined,
  label: "limit" | "skip",
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function matchesCondition(value: any, condition: any, exists = true): boolean {
  if (isOperatorExpression(condition)) {
    return Object.entries(condition).every(([operator, operand]) => {
      if (comparison_operators.has(operator)) {
        return compare(value, operand, operator);
      }
      if (operator === "$in" || operator === "$nin") {
        if (!Array.isArray(operand)) {
          throw new TypeError(`${operator} requires an array`);
        }
        const candidates = Array.isArray(value) ? value : [value];
        const included = candidates.some((candidate) =>
          operand.some((expected) => valuesEqual(candidate, expected)),
        );
        return operator === "$in" ? included : !included;
      }
      if (operator === "$not") {
        if (!isNestedObject(operand)) {
          throw new TypeError("$not requires a query expression");
        }
        return !matchesCondition(value, operand, exists);
      }
      if (operator === "$exists") {
        if (typeof operand !== "boolean") {
          throw new TypeError("$exists requires a boolean");
        }
        return exists === operand;
      }
      if (operator === "$type") {
        const expected = Array.isArray(operand) ? operand : [operand];
        if (!expected.every((type) => typeof type === "string")) {
          throw new TypeError("$type requires a type name or an array of type names");
        }
        return expected.includes(valueType(value, exists));
      }
      if (operator === "$regex") {
        return matchesRegex(value, operand, condition.$options);
      }
      if (operator === "$options") {
        if (!("$regex" in condition)) {
          throw new TypeError("$options requires $regex");
        }
        if (typeof operand !== "string") {
          throw new TypeError("$options requires a string");
        }
        return true;
      }
      throw new TypeError(`Unsupported query operator: ${operator}`);
    });
  }
  if (isNestedObject(condition)) {
    const candidates = Array.isArray(value) ? value : [value];
    return candidates.some(
      (candidate) => isNestedObject(candidate) && matchesQuery(candidate, condition),
    );
  }
  return valuesEqual(value, condition);
}

function matchesRegex(value: any, operand: any, options: any): boolean {
  if (!(typeof operand === "string" || operand instanceof RegExp)) {
    throw new TypeError("$regex requires a string or RegExp");
  }
  if (options !== undefined && typeof options !== "string") {
    throw new TypeError("$options requires a string");
  }
  const expression = new RegExp(
    operand instanceof RegExp ? operand.source : operand,
    options ?? (operand instanceof RegExp ? operand.flags : undefined),
  );
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.some((candidate) => {
    if (typeof candidate !== "string") return false;
    expression.lastIndex = 0;
    return expression.test(candidate);
  });
}

function valueType(value: any, exists: boolean): string {
  if (!exists || value === undefined) return "undefined";
  if (value === null) return "null";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateNestedQuery(operator: string, value: any): void {
  if (!isNestedObject(value)) {
    throw new TypeError(`${operator} requires a query object`);
  }
}

function compare(value: any, operand: any, operator: string): boolean {
  const left = comparableValue(value);
  const right = comparableValue(operand);
  if (left === undefined || right === undefined || left.type !== right.type) {
    return false;
  }

  switch (operator) {
    case "$lt":
      return left.value < right.value;
    case "$lte":
      return left.value <= right.value;
    case "$gt":
      return left.value > right.value;
    case "$gte":
      return left.value >= right.value;
    default:
      return false;
  }
}

function comparableValue(
  value: any,
): { type: "date" | "number"; value: number } | { type: "string"; value: string } | undefined {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp)
      ? { type: "date", value: timestamp }
      : undefined;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? { type: "number", value }
    : typeof value === "string"
      ? { type: "string", value }
      : undefined;
}

function isRangeValue(value: any): value is number | string | Date {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "string" ||
    (value instanceof Date && Number.isFinite(value.getTime()))
  );
}

function rangeValueType(value: number | string | Date): string {
  return value instanceof Date ? "date" : typeof value;
}

function valuesEqual(left: any, right: any): boolean {
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.getTime() === right.getTime()
    );
  }
  return left === right;
}

function isOperatorExpression(value: any): value is Record<string, any> {
  return (
    isNestedObject(value) &&
    Object.keys(value).some((key) => key.startsWith("$"))
  );
}

function isNestedObject(value: any): value is Record<string, any> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp)
  );
}

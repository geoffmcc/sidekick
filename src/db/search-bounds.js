"use strict";

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 500;
const MAX_SEARCH_QUERY_CHARS = 500;
const MAX_SEARCH_TABLE_FILTERS = 50;

function normalizeDatabaseSearchRequest(query, options = {}) {
  const requestedLimit = Number(options.limit);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_SEARCH_LIMIT)
    : DEFAULT_SEARCH_LIMIT;
  const normalizedQuery = typeof query === "string" ? query.trim().slice(0, MAX_SEARCH_QUERY_CHARS) : "";
  const inputTables = Array.isArray(options.tables)
    ? options.tables
    : (typeof options.tables === "string" ? options.tables.split(",") : null);
  const tables = inputTables
    ? [...new Set(inputTables.filter(value => typeof value === "string" && value.trim()).map(value => value.trim()).slice(0, MAX_SEARCH_TABLE_FILTERS))]
    : null;
  return { query: normalizedQuery, tables, limit };
}

module.exports = {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY_CHARS,
  MAX_SEARCH_TABLE_FILTERS,
  normalizeDatabaseSearchRequest,
};

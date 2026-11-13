/**
 * SQL rows come back in snake_case; the public API is camelCase everywhere.
 * Converting once at the response boundary keeps queries readable and the
 * contract (openapi.yaml) consistent.
 */
const toCamel = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [toCamel(k), camelize(v)]));
  }
  return value; // Date, string, number, boolean, null
}

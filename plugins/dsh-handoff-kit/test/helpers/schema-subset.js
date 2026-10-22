/**
 * Validator for the harness's enforced JSON Schema subset, used to prove the
 * tool output schema accepts every canonical result shape. It mirrors the
 * documented subset: type/oneOf/properties/required/boolean
 * additionalProperties/items/enum/const, with JSON annotations allowed.
 *
 * @module test/helpers/schema-subset
 */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/**
 * Validate a value against the supported schema subset.
 * @param {Record<string, unknown>} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]} violations (empty = valid)
 */
export function validateSubset(schema, value, path = '') {
  const violations = []
  const here = path === '' ? 'value' : path
  if (!isPlainObject(schema)) return [`${here}: schema is not an object`]

  if (Object.hasOwn(schema, 'oneOf')) {
    const branches = schema.oneOf
    if (!Array.isArray(branches) || branches.length < 2) return [`${here}: oneOf must have two branches`]
    const matches = branches.filter((branch) => validateSubset(branch, value, here).length === 0).length
    if (matches !== 1) violations.push(`${here}: must match exactly one oneOf branch (matched ${matches})`)
    return violations
  }

  const declared = schema.type
  if (declared === undefined) return violations // annotation-only schema accepts anything

  const actual = typeOf(value)
  const matchesType =
    declared === actual ||
    (declared === 'number' && actual === 'integer') ||
    (declared === 'integer' && actual === 'integer')
  if (!matchesType) return [`${here}: expected ${declared}, got ${actual}`]

  if (Object.hasOwn(schema, 'enum') && !schema.enum.includes(value))
    violations.push(`${here}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`)
  if (Object.hasOwn(schema, 'const') && value !== schema.const)
    violations.push(`${here}: expected const ${JSON.stringify(schema.const)}`)

  if (declared === 'object') {
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${here}.${key}: required property missing`)
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        violations.push(...validateSubset(properties[key], child, `${here}.${key}`))
      } else if (schema.additionalProperties === false) {
        violations.push(`${here}.${key}: additional property not allowed`)
      }
    }
  }

  if (declared === 'array') {
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        violations.push(...validateSubset(schema.items, item, `${here}[${index}]`))
      })
    }
  }

  return violations
}

/** Throwing assertion wrapper used by tool tests. */
export function assertValidAgainst(schema, value, label = 'value') {
  const violations = validateSubset(schema, value)
  if (violations.length > 0)
    throw new Error(`${label} violates the tool output schema:\n- ${violations.join('\n- ')}`)
}

/**
 * Assert a raw schema belongs to the harness's supported keyword subset.
 * @param {Record<string, unknown>} schema
 * @returns {string[]} violations
 */
export function validateSchemaSubset(schema) {
  const violations = [];
  const allowed = new Set(["type","oneOf","properties","required","additionalProperties","items","enum","const","description","title","default","examples"]);
  const types = new Set(["object","array","string","number","integer","boolean","null"]);
  const seen = new Set();
  const stack = [[schema, "schema"]];
  while (stack.length > 0) {
    const [node, path] = stack.pop();
    if (node === null || typeof node !== "object" || Array.isArray(node)) { violations.push(`${path}: must be a schema object`); continue; }
    if (seen.has(node)) { violations.push(`${path}: circular`); continue; }
    seen.add(node);
    for (const key of Object.keys(node)) if (!allowed.has(key)) violations.push(`${path}.${key}: unsupported keyword`);
    const hasType = Object.hasOwn(node, "type");
    const hasOneOf = Object.hasOwn(node, "oneOf");
    if (hasType && hasOneOf) violations.push(`${path}: cannot declare both type and oneOf`);
    if (!hasType && !hasOneOf) {
      for (const key of ["properties","required","additionalProperties","items","enum","const"]) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key}: requires type or oneOf`);
      }
      continue;
    }
    if (hasOneOf) {
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${path}.oneOf: needs at least two schemas`);
      else node.oneOf.forEach((branch, index) => stack.push([branch, `${path}.oneOf[${index}]`]));
      continue;
    }
    if (!types.has(node.type)) { violations.push(`${path}.type: unsupported (${String(node.type)})`); continue; }
    const t = node.type;
    const wrongContext = [["properties","object"],["required","object"],["additionalProperties","object"],["items","array"],["enum","string|number|integer|boolean|null"],["const","string|number|integer|boolean|null"]];
    for (const [key, okay] of wrongContext) if (Object.hasOwn(node, key) && !okay.split("|").includes(t)) violations.push(`${path}.${key}: not supported on type ${t}`);
    if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") violations.push(`${path}.additionalProperties: must be boolean`);
    if (t === "object") {
      const properties = node.properties;
      if (properties !== undefined) {
        if (properties === null || typeof properties !== "object" || Array.isArray(properties)) violations.push(`${path}.properties: must be an object of schemas`);
        else for (const [key, child] of Object.entries(properties)) stack.push([child, `${path}.properties.${key}`]);
      }
      if (node.required !== undefined) {
        if (!Array.isArray(node.required) || !node.required.every((entry) => typeof entry === "string")) violations.push(`${path}.required: must be an array of strings`);
        else for (const key of node.required) if (properties !== undefined && !Object.hasOwn(properties, key)) violations.push(`${path}.required: "${key}" is not a declared property`);
      }
    }
    if (t === "array" && node.items !== undefined) stack.push([node.items, `${path}.items`]);
    if (Object.hasOwn(node, "enum") && (!Array.isArray(node.enum) || node.enum.length === 0)) violations.push(`${path}.enum: must be a non-empty array`);
  }
  return violations;
}

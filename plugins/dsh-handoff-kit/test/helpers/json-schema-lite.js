/**
 * Minimal JSON Schema validator for the keywords used by the published
 * handoff-manifest schemas (`schema/manifest.v1.json` / `manifest.v2.json`).
 *
 * Supported keywords (deliberately bounded, zero dependencies):
 *   $schema/title/description (annotations, ignored), type, const, enum,
 *   pattern, minLength, minimum, oneOf, required, properties,
 *   additionalProperties (boolean or schema), items.
 *
 * The published schemas are consumer-facing JSON Schema (draft 2020-12); this
 * helper is only the in-repo regression validator for the shape contract, not a
 * general-purpose validator.
 *
 * @module test/helpers/json-schema-lite
 */

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function matchesType(declared, value) {
  const actual = typeOf(value)
  if (declared === actual) return true
  if (declared === 'number' && actual === 'integer') return true
  if (declared === 'integer' && actual === 'integer') return true
  return false
}

/**
 * Validate a value against the supported schema subset.
 * @param {Record<string, unknown>} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]} violations (empty = valid)
 */
export function validateJsonSchema(schema, value, path = '$') {
  const violations = []
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema))
    return [`${path}: schema must be an object`]

  if (schema.const !== undefined && value !== schema.const)
    violations.push(`${path}: expected const ${JSON.stringify(schema.const)}`)
  if (schema.enum !== undefined && Array.isArray(schema.enum) && !schema.enum.includes(value))
    violations.push(`${path}: value not in enum`)

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => validateJsonSchema(branch, value, path).length === 0)
    if (matches.length !== 1) violations.push(`${path}: oneOf matched ${matches.length} branches`)
    return violations
  }

  if (schema.type !== undefined) {
    const declared = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!declared.some((type) => matchesType(type, value))) {
      violations.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`)
      return violations
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      violations.push(`${path}: shorter than ${schema.minLength}`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
      violations.push(`${path}: does not match pattern`)
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum)
    violations.push(`${path}: below minimum ${schema.minimum}`)

  if (typeOf(value) === 'object') {
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${path}.${key}: required property missing`)
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        violations.push(...validateJsonSchema(properties[key], child, `${path}.${key}`))
      } else if (schema.additionalProperties === false) {
        violations.push(`${path}.${key}: additional property not allowed`)
      } else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
        violations.push(...validateJsonSchema(schema.additionalProperties, child, `${path}.${key}`))
      }
    }
  }

  if (typeOf(value) === 'array' && schema.items !== undefined) {
    value.forEach((item, index) => {
      violations.push(...validateJsonSchema(schema.items, item, `${path}[${index}]`))
    })
  }

  return violations
}

/** True when the value validates without violations. */
export function isValidAgainst(schema, value) {
  return validateJsonSchema(schema, value).length === 0
}
